import { fetchWithRetry } from "../http.js";
import { htmlToText, countWords } from "../text.js";
import type { SavedItem } from "../types.js";
import { type Extraction, meta, metaFrom, readable } from "./article.js";

/**
 * X and LinkedIn both serve a login wall to anything that is not a signed-in
 * browser. In practice the text comes from whatever your capture tool stored
 * at save time — which is the strongest argument for saving through Reader
 * rather than pasting a bare URL. When we do have to go to the network, Open
 * Graph tags are the most we can expect.
 */
export async function extractSocial(item: SavedItem): Promise<Extraction> {
  if (item.html && item.html.length > 200) {
    const parsed = readable(item.html, item.url);
    if (parsed && countWords(parsed.text) > 30) {
      return { ...parsed, method: "source-html" };
    }
    const text = htmlToText(item.html);
    if (countWords(text) > 20) return { text, method: "source-html-raw" };
  }

  if (item.summary && countWords(item.summary) > 20) {
    return { text: item.summary, method: "source-summary" };
  }

  try {
    const res = await fetchWithRetry(item.url, {
      headers: {
        // Social sites serve OG tags to crawlers and a login wall to browsers,
        // so here we ask as a crawler on purpose.
        "user-agent": "Mozilla/5.0 (compatible; pressroom/1.0; +print-archive)",
        accept: "text/html,application/xhtml+xml",
      },
      label: "social",
      retries: 2,
      timeoutMs: 20_000,
    });
    const html = await res.text();
    const description = meta(html, "og:description") ?? meta(html, "description");
    const info = metaFrom(html);
    if (description && countWords(description) > 10) {
      return { text: description, method: "open-graph", ...info };
    }
    return {
      text: item.summary ?? "",
      method: "open-graph",
      error: "post text is behind a login wall",
      ...info,
    };
  } catch (err) {
    return {
      text: item.summary ?? "",
      method: "social",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
