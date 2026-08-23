import { mapLimit } from "../http.js";
import { log } from "../log.js";
import { countWords, readingMinutes } from "../text.js";
import type { EnrichedItem, EnrichmentStatus, SavedItem } from "../types.js";
import { extractArticle, type Extraction } from "./article.js";
import { extractVideo, type VideoExtraction } from "./youtube.js";
import { extractSocial } from "./social.js";

/** How many pages we are willing to fetch at once. Be a good citizen. */
const CONCURRENCY = 4;

/** Below this, a piece cannot be set as a full article — it becomes a card. */
export const THIN_WORD_THRESHOLD = 250;

export async function enrichAll(items: SavedItem[]): Promise<EnrichedItem[]> {
  log.step(`Reading ${items.length} saved item(s)`);

  const enriched = await mapLimit(items, CONCURRENCY, async (item, index) => {
    const result = await enrichOne(item);
    log.info(
      `[${index + 1}/${items.length}] ${result.enrichment.status.padEnd(7)} ` +
        `${String(result.wordCount).padStart(5)}w  ${result.title.slice(0, 68)}`,
    );
    return result;
  });

  const full = enriched.filter((e) => e.enrichment.status === "full").length;
  log.info(`read ${full}/${items.length} in full`);
  return enriched;
}

export async function enrichOne(item: SavedItem): Promise<EnrichedItem> {
  const extraction = await extractFor(item);
  const video = "transcript" in extraction ? extraction : undefined;
  const text = extraction.text.trim();
  const words = countWords(text);

  return {
    ...item,
    // Extractors often know the real title and byline better than the saver did.
    title: extraction.title?.trim() || item.title,
    author: extraction.author?.trim() || item.author,
    siteName: extraction.siteName?.trim() || item.siteName,
    publishedAt: extraction.publishedAt ?? item.publishedAt,
    text,
    wordCount: words,
    readingMinutes: readingMinutes(words),
    transcript: video?.transcript,
    durationSeconds: video?.durationSeconds,
    enrichment: {
      status: statusFor(words),
      method: extraction.method,
      error: extraction.error,
    },
  };
}

function extractFor(item: SavedItem): Promise<Extraction | VideoExtraction> {
  switch (item.kind) {
    case "video":
    case "podcast":
      return extractVideo(item);
    case "post":
    case "thread":
      return extractSocial(item);
    default:
      return extractArticle(item);
  }
}

function statusFor(words: number): EnrichmentStatus {
  if (words >= THIN_WORD_THRESHOLD) return "full";
  if (words > 0) return "partial";
  return "thin";
}
