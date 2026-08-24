import { log } from "../log.js";
import type { Config, Secrets } from "../config.js";
import type { SavedItem } from "../types.js";
import { fetchReadwiseItems } from "./readwise.js";
import { fetchInboxItems } from "./inbox.js";
import { fetchEmailItems } from "./email.js";

/** The slice of time one issue covers. */
export interface MonthWindow {
  /** `YYYY-MM`. */
  month: string;
  monthLabel: string;
  /** Inclusive ISO instant. */
  start: string;
  /** Exclusive ISO instant. */
  end: string;
}

/**
 * Month boundaries in the reader's own timezone, so something saved at
 * 00:30 on the 1st lands in the issue they expect.
 */
export function monthWindow(month: string, timeZone: string): MonthWindow {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`Expected a month as YYYY-MM, got "${month}"`);
  }
  const [yearStr, monthStr] = month.split("-") as [string, string];
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;

  const startUtcGuess = Date.UTC(year, monthIndex, 1);
  const endUtcGuess = Date.UTC(year, monthIndex + 1, 1);

  const start = new Date(
    startUtcGuess - offsetMinutes(startUtcGuess, timeZone) * 60_000,
  ).toISOString();
  const end = new Date(
    endUtcGuess - offsetMinutes(endUtcGuess, timeZone) * 60_000,
  ).toISOString();

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(startUtcGuess));

  return { month, monthLabel, start, end };
}

/** Minutes that `timeZone` is ahead of UTC at the given instant. */
function offsetMinutes(instant: number, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).format(new Date(instant));
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(formatted);
  if (!match) return 0; // UTC, or a zone Intl reports without an offset.
  const [, sign, hours, minutes] = match as unknown as [string, string, string, string];
  const total = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -total : total;
}

/** The month before the current one, in the reader's timezone. */
export function previousMonth(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const date = new Date(Date.UTC(year, month - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Pull every enabled source and merge, keeping the earliest save of a URL. */
export async function collectSavedItems(
  config: Config,
  secrets: Secrets,
  window: MonthWindow,
): Promise<SavedItem[]> {
  const batches: SavedItem[][] = [];

  if (config.sources.readwise.enabled) {
    if (!secrets.readwiseToken) {
      throw new Error("sources.readwise.enabled is true but READWISE_TOKEN is unset");
    }
    batches.push(await fetchReadwiseItems(config, window, secrets.readwiseToken));
  }

  if (config.sources.inbox.enabled) {
    if (!secrets.inboxToken) {
      throw new Error("sources.inbox.enabled is true but INBOX_TOKEN is unset");
    }
    batches.push(await fetchInboxItems(config, window, secrets.inboxToken));
  }

  if (config.sources.email.enabled) {
    batches.push(await fetchEmailItems(config, window, secrets));
  }

  if (batches.length === 0) {
    throw new Error(
      "No sources are enabled. Turn on sources.readwise, sources.email, or " +
        "sources.inbox in pressroom.config.json.",
    );
  }

  return dedupeByUrl(batches.flat());
}

/**
 * The same link often arrives twice — saved on the phone and again from the
 * desktop. Keep the richer copy, and keep the earliest save date so the
 * issue reflects when you first found it.
 */
export function dedupeByUrl(items: SavedItem[]): SavedItem[] {
  const byKey = new Map<string, SavedItem>();

  for (const item of items) {
    const key = canonicalUrl(item.url);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const winner = richness(item) > richness(existing) ? item : existing;
    const loser = winner === item ? existing : item;
    byKey.set(key, {
      ...winner,
      savedAt: winner.savedAt < loser.savedAt ? winner.savedAt : loser.savedAt,
      note: winner.note ?? loser.note,
      tags: [...new Set([...winner.tags, ...loser.tags])],
    });
  }

  const merged = [...byKey.values()];
  const dropped = items.length - merged.length;
  if (dropped > 0) log.info(`merged ${dropped} duplicate save(s)`);
  return merged.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

/** Strip tracking noise so the same article saved twice compares equal. */
export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|si$|s$|igshid)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return url;
  }
}

function richness(item: SavedItem): number {
  return (
    (item.html ? 4 : 0) +
    (item.summary ? 2 : 0) +
    (item.note ? 2 : 0) +
    (item.author ? 1 : 0) +
    item.tags.length
  );
}
