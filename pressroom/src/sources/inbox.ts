import { fetchJson } from "../http.js";
import { log } from "../log.js";
import type { MediaKind, SavedItem } from "../types.js";
import type { Config } from "../config.js";
import type { MonthWindow } from "./index.js";
import { refineKind } from "./readwise.js";

/** The row shape the capture Worker returns from GET /items. */
interface InboxRow {
  id: string;
  url: string;
  title?: string | null;
  note?: string | null;
  tags?: string | string[] | null;
  kind?: string | null;
  author?: string | null;
  site_name?: string | null;
  saved_at: string;
}

interface InboxListResponse {
  items?: InboxRow[];
}

export async function fetchInboxItems(
  config: Config,
  window: MonthWindow,
  token: string,
): Promise<SavedItem[]> {
  const endpoint = config.sources.inbox.endpoint;
  if (!endpoint) {
    throw new Error(
      "sources.inbox.enabled is true but sources.inbox.endpoint is not set",
    );
  }

  const query = new URLSearchParams({ since: window.start, until: window.end });
  const body = await fetchJson<InboxListResponse>(
    `${endpoint.replace(/\/$/, "")}/items?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      label: "inbox",
    },
  );

  const items = (body.items ?? []).map(toSavedItem);
  log.info(`inbox: ${items.length} items saved inside ${window.month}`);
  return items;
}

function toSavedItem(row: InboxRow): SavedItem {
  const declared = (row.kind ?? "article") as MediaKind;
  return {
    id: `inbox:${row.id}`,
    source: "inbox",
    sourceId: row.id,
    url: row.url,
    title: row.title?.trim() || row.url,
    author: row.author?.trim() || undefined,
    siteName: row.site_name?.trim() || undefined,
    savedAt: new Date(row.saved_at).toISOString(),
    kind: refineKind(declared, row.url),
    tags: parseTags(row.tags),
    note: row.note?.trim() || undefined,
  };
}

function parseTags(tags: InboxRow["tags"]): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String);
  return tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}
