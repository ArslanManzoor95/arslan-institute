import { fetchJson } from "../http.js";
import { log } from "../log.js";
import type { MediaKind, SavedItem } from "../types.js";
import type { Config } from "../config.js";
import type { MonthWindow } from "./index.js";

const READER_LIST_URL = "https://readwise.io/api/v3/list/";

/**
 * Reader's document shape. Fields are all optional on purpose: the API adds
 * fields over time and we would rather degrade than throw on an unknown month.
 */
interface ReaderDocument {
  id?: string;
  url?: string;
  source_url?: string;
  title?: string;
  author?: string;
  source?: string;
  category?: string;
  location?: string;
  tags?: Record<string, unknown> | string[] | null;
  site_name?: string;
  word_count?: number | null;
  created_at?: string;
  updated_at?: string;
  published_date?: string | number | null;
  summary?: string | null;
  image_url?: string | null;
  content?: string | null;
  html_content?: string | null;
  notes?: string | null;
  saved_at?: string;
  parent_id?: string | null;
}

interface ReaderListResponse {
  count?: number;
  nextPageCursor?: string | null;
  results?: ReaderDocument[];
}

/** Reader's `category` maps onto our media kinds. */
const CATEGORY_TO_KIND: Record<string, MediaKind> = {
  article: "article",
  email: "newsletter",
  rss: "article",
  tweet: "post",
  video: "video",
  pdf: "paper",
  epub: "other",
  note: "other",
  highlight: "other",
};

/** Categories that are annotations on other documents, not things to print. */
const SKIP_CATEGORIES = new Set(["highlight", "note"]);

export async function fetchReadwiseItems(
  config: Config,
  window: MonthWindow,
  token: string,
): Promise<SavedItem[]> {
  const locations = config.sources.readwise.locations;
  const collected = new Map<string, SavedItem>();

  for (const location of locations) {
    const docs = await listDocuments(token, {
      location,
      updatedAfter: window.start,
      withHtmlContent: config.sources.readwise.withHtmlContent,
    });
    log.info(`readwise: ${docs.length} documents in "${location}"`);

    for (const doc of docs) {
      const item = toSavedItem(doc);
      if (!item) continue;
      // A document can appear under more than one location across a month.
      if (!collected.has(item.id)) collected.set(item.id, item);
    }
  }

  const inWindow = [...collected.values()].filter((item) =>
    isWithin(item.savedAt, window),
  );
  log.info(
    `readwise: ${inWindow.length} of ${collected.size} saved inside ${window.month}`,
  );
  return inWindow;
}

async function listDocuments(
  token: string,
  params: { location: string; updatedAfter: string; withHtmlContent: boolean },
): Promise<ReaderDocument[]> {
  const docs: ReaderDocument[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const query = new URLSearchParams({
      location: params.location,
      updatedAfter: params.updatedAfter,
    });
    if (params.withHtmlContent) query.set("withHtmlContent", "true");
    if (cursor) query.set("pageCursor", cursor);

    const body = await fetchJson<ReaderListResponse>(
      `${READER_LIST_URL}?${query.toString()}`,
      {
        headers: { Authorization: `Token ${token}` },
        label: "readwise",
        // Reader rate-limits the list endpoint; the retry helper honours
        // Retry-After, which is what it returns on 429.
        retries: 5,
        timeoutMs: 60_000,
      },
    );

    docs.push(...(body.results ?? []));
    cursor = body.nextPageCursor ?? undefined;
    page++;
  } while (cursor && page < 100);

  return docs;
}

function toSavedItem(doc: ReaderDocument): SavedItem | null {
  const category = (doc.category ?? "article").toLowerCase();
  if (SKIP_CATEGORIES.has(category)) return null;

  const url = doc.source_url ?? doc.url;
  const id = doc.id;
  if (!url || !id) return null;

  const savedAt = doc.saved_at ?? doc.created_at;
  if (!savedAt) return null;

  const kind = refineKind(CATEGORY_TO_KIND[category] ?? "other", url);

  return {
    id: `readwise:${id}`,
    source: "readwise",
    sourceId: id,
    url,
    title: doc.title?.trim() || url,
    author: doc.author?.trim() || undefined,
    siteName: doc.site_name?.trim() || undefined,
    publishedAt: normalisePublished(doc.published_date),
    savedAt: new Date(savedAt).toISOString(),
    kind,
    tags: normaliseTags(doc.tags),
    note: doc.notes?.trim() || undefined,
    html: doc.html_content ?? undefined,
    summary: doc.summary?.trim() || undefined,
    wordCount: doc.word_count ?? undefined,
    imageUrl: doc.image_url ?? undefined,
  };
}

/** Reader labels some things generically; the URL is a better signal. */
export function refineKind(kind: MediaKind, url: string): MediaKind {
  const host = safeHost(url);
  if (!host) return kind;
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "video";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return "post";
  if (/(^|\.)linkedin\.com$/.test(host)) {
    return /\/pulse\//.test(url) ? "article" : "post";
  }
  if (/(^|\.)(arxiv\.org|papers\.ssrn\.com)$/.test(host)) return "paper";
  if (/(^|\.)(vimeo\.com|loom\.com)$/.test(host)) return "video";
  if (/(^|\.)(open\.spotify\.com|podcasts\.apple\.com|overcast\.fm)$/.test(host)) {
    return "podcast";
  }
  if (/(^|\.)(substack\.com)$/.test(host)) return "newsletter";
  return kind;
}

export function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normaliseTags(tags: ReaderDocument["tags"]): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String);
  return Object.keys(tags);
}

function normalisePublished(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  // Reader has returned both epoch millis and ISO strings here over time.
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isWithin(iso: string, window: MonthWindow): boolean {
  const t = new Date(iso).getTime();
  return t >= new Date(window.start).getTime() && t < new Date(window.end).getTime();
}
