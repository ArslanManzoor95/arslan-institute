/** Shared domain types for the pipeline. */

/** Where an item was captured from. */
export type SourceName = "readwise" | "inbox" | "email";

/** What kind of thing the link points at. Drives enrichment and layout. */
export type MediaKind =
  | "article"
  | "video"
  | "post"
  | "thread"
  | "paper"
  | "newsletter"
  | "podcast"
  | "other";

/** How a piece is rendered in the issue. */
export type Treatment =
  | "full" // the whole text, set in two columns
  | "extract" // an edited extract plus a pointer to the rest
  | "summary-card"; // a single card: summary, key lines, QR code

/** A link as captured, before we have gone and read it. */
export interface SavedItem {
  /** Stable id: `${source}:${sourceId}`. */
  id: string;
  source: SourceName;
  sourceId: string;
  url: string;
  title: string;
  author?: string;
  siteName?: string;
  /** When the thing was published, if we know. ISO 8601. */
  publishedAt?: string;
  /** When you saved it. ISO 8601. */
  savedAt: string;
  kind: MediaKind;
  tags: string[];
  /** Your own note at capture time. Weighs heavily in curation. */
  note?: string;
  /** Raw HTML the source already had, if any. Saves us a fetch. */
  html?: string;
  /** Plain-text summary the source already had, if any. */
  summary?: string;
  wordCount?: number;
  imageUrl?: string;
}

export type EnrichmentStatus =
  /** We have the full text. */
  | "full"
  /** We have something real but partial (a summary, an abstract, a description). */
  | "partial"
  /** Metadata only — paywall, login wall, or a fetch that failed. */
  | "thin";

/** A saved item after we have tried to read it. */
export interface EnrichedItem extends SavedItem {
  /** Body text, already stripped of navigation and boilerplate. */
  text: string;
  wordCount: number;
  readingMinutes: number;
  enrichment: {
    status: EnrichmentStatus;
    /** How we got the text, for debugging a thin month. */
    method: string;
    error?: string;
  };
  /** Video only: transcript if we could get one. */
  transcript?: string;
  /** Video only: duration in seconds. */
  durationSeconds?: number;
}

/** Claude's judgement on one candidate. */
export interface Verdict {
  id: string;
  /** 0-100. Only used for ranking; the cut line is set by the page budget. */
  score: number;
  /** One sentence to the editor arguing for or against printing it. */
  pitch: string;
  /** Which part of the paper it belongs in. */
  section: string;
  treatment: Treatment;
  /** Sub-scores, kept for the "why did this get in" report. */
  rubric: {
    durability: number;
    density: number;
    printFit: number;
    personalPull: number;
  };
  /** Set when the piece is a near-duplicate of another candidate. */
  duplicateOf?: string;
}

/** A piece that made the issue, with its copy written. */
export interface IssuePiece {
  item: EnrichedItem;
  verdict: Verdict;
  /** The headline as it appears in print — may differ from the source title. */
  headline: string;
  /** The standfirst / deck under the headline. */
  standfirst: string;
  /** Body copy to typeset. For summary cards, this is Claude's summary. */
  body: string;
  /** Pull quotes to break up the column. */
  pullQuotes: string[];
  /** Estimated pages, before we measure the real render. */
  estimatedPages: number;
}

/** Everything that was saved but did not make the cut. */
export interface SpikeEntry {
  title: string;
  url: string;
  kind: MediaKind;
  reason: string;
}

export interface Issue {
  /** Monotonic issue number. */
  number: number;
  /** `YYYY-MM` — the month being printed. */
  month: string;
  /** Human month, e.g. "August 2026". */
  monthLabel: string;
  generatedAt: string;
  masthead: string;
  /** The front-page note from the editor. */
  editorsNote: string;
  pieces: IssuePiece[];
  spike: SpikeEntry[];
  /** Filled in after the first render. */
  pageCount?: number;
  /**
   * Whether the print file was actually converted to greyscale. False when
   * Ghostscript was unavailable, so a later `order` reports the truth rather
   * than what the config asked for.
   */
  greyscaleApplied?: boolean;
  stats: {
    captured: number;
    enrichedFull: number;
    printed: number;
  };
}
