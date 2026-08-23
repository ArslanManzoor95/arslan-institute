/** Text helpers shared by enrichment, curation, and layout. */

const BLOCK_TAGS =
  /<\/(?:p|div|section|article|h[1-6]|li|blockquote|figcaption|pre|tr)>/gi;

/** Crude but dependency-free HTML to text, for fragments we only need to read. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_TAGS, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&hellip;/gi, "…")
    .replace(/&mdash;/gi, "—")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Typical adult reading speed on paper, rounded up. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}

export function truncateWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= limit) return text.trim();
  return words.slice(0, limit).join(" ") + "…";
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Split plain text into paragraphs. Single newlines inside a paragraph are
 * treated as soft wraps, which is how most extractors emit body copy.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** Sentences, for pulling quotes and building standfirsts. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z"'“‘])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Straight quotes and dashes look wrong in print. */
export function typographic(text: string): string {
  return text
    .replace(/(^|[\s(\[{])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s(\[{])'/g, "$1‘")
    .replace(/'/g, "’")
    .replace(/(\w)\s+--\s+(\w)/g, "$1 — $2")
    .replace(/\.\.\./g, "…");
}
