import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { fetchWithRetry } from "../http.js";
import { htmlToText, countWords } from "../text.js";
import type { SavedItem } from "../types.js";

export interface Extraction {
  text: string;
  method: string;
  title?: string;
  author?: string;
  siteName?: string;
  publishedAt?: string;
  error?: string;
}

/** A browser UA. Plenty of publishers serve a stub to anything else. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Get the body of an article. Prefers HTML the source already stored — that
 * copy was fetched with your session and gets past soft paywalls that a
 * cold fetch from a build runner will not.
 */
export async function extractArticle(item: SavedItem): Promise<Extraction> {
  if (item.html && item.html.length > 500) {
    const parsed = readable(item.html, item.url);
    if (parsed && countWords(parsed.text) > 120) {
      return { ...parsed, method: "source-html" };
    }
  }

  try {
    const res = await fetchWithRetry(item.url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-GB,en;q=0.9",
      },
      label: item.siteName ?? "fetch",
      retries: 3,
      timeoutMs: 25_000,
    });
    const html = await res.text();
    const parsed = readable(html, item.url);
    if (parsed && countWords(parsed.text) > 120) {
      return { ...parsed, method: "fetch+readability" };
    }
    // Readability bailed (single-page apps, unusual markup). Take the raw text.
    const raw = htmlToText(html);
    if (countWords(raw) > 200) {
      return { text: raw, method: "fetch+raw", ...metaFrom(html) };
    }
    return {
      text: "",
      method: "fetch",
      error: "no readable body found",
      ...metaFrom(html),
    };
  } catch (err) {
    return {
      text: "",
      method: "fetch",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Run Readability over a document without letting page scripts or CSS run. */
export function readable(html: string, url: string): Extraction | null {
  try {
    // Swallow the CSS/JS parse noise jsdom emits on real-world pages.
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent) return null;
    return {
      text: article.textContent.trim(),
      method: "readability",
      title: article.title?.trim() || undefined,
      author: article.byline?.trim() || undefined,
      siteName: article.siteName?.trim() || undefined,
      publishedAt: article.publishedTime ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Open Graph and friends, for when the body is unreachable. */
export function metaFrom(html: string): Partial<Extraction> {
  const head = html.slice(0, 300_000);
  return {
    title: meta(head, "og:title") ?? titleTag(head),
    author: meta(head, "article:author") ?? meta(head, "author"),
    siteName: meta(head, "og:site_name"),
    publishedAt:
      meta(head, "article:published_time") ?? meta(head, "og:published_time"),
  };
}

export function meta(html: string, key: string): string | undefined {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decode(match[1]).trim() || undefined;
  }
  return undefined;
}

function titleTag(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? decode(match[1]).trim() : undefined;
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}
