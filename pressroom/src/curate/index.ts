import { log } from "../log.js";
import type { Config } from "../config.js";
import type {
  EnrichedItem,
  SpikeEntry,
  Treatment,
  Verdict,
} from "../types.js";
import { THIN_WORD_THRESHOLD } from "../enrich/index.js";

export interface Selection {
  selected: { item: EnrichedItem; verdict: Verdict }[];
  spike: SpikeEntry[];
}

/**
 * Mechanical facts beat the model's opinion. A 12,000-word piece cannot be
 * `full` in a 24-page paper, and a video is never anything but a card no
 * matter how good the transcript is.
 */
export function clampTreatment(
  item: EnrichedItem,
  proposed: Treatment,
  config: Config,
): Treatment {
  if (item.kind === "video" || item.kind === "podcast") return "summary-card";
  if (item.wordCount < THIN_WORD_THRESHOLD) return "summary-card";
  if (item.wordCount > config.curation.extractWordLimit) {
    return proposed === "summary-card" ? "summary-card" : "extract";
  }
  return proposed === "extract" ? "full" : proposed;
}

/**
 * Pages a piece will take, before we measure the real render.
 *
 * Cards are half a page each — two to a spread — except video and podcast
 * cards, which get a full page: a summary you can read instead of watching
 * needs room to be worth reading.
 */
export function estimatePages(
  item: EnrichedItem,
  treatment: Treatment,
  config: Config,
): number {
  if (treatment === "summary-card") {
    return item.kind === "video" || item.kind === "podcast" ? 1 : 0.5;
  }
  const words =
    treatment === "extract"
      ? Math.min(item.wordCount, config.curation.extractWordLimit)
      : item.wordCount;
  // Headline, standfirst and white space cost roughly a third of a page.
  const pages = words / config.layout.wordsPerPage + 0.34;
  return Math.round(pages * 4) / 4;
}

export function selectIssue(
  items: EnrichedItem[],
  verdicts: Verdict[],
  config: Config,
): Selection {
  const byId = new Map(items.map((item) => [item.id, item]));
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));
  const spike: SpikeEntry[] = [];

  const selected: { item: EnrichedItem; verdict: Verdict }[] = [];
  const perKind = new Map<string, number>();
  let pages = 0;

  const spikeIt = (item: EnrichedItem, reason: string) =>
    spike.push({ title: item.title, url: item.url, kind: item.kind, reason });

  // Tag rules run before scoring is consulted at all.
  const neverTags = new Set(config.curation.neverPrintTags.map(lower));
  const alwaysTags = new Set(config.curation.alwaysPrintTags.map(lower));

  const candidates = items.filter((item) => {
    if (item.tags.map(lower).some((t) => neverTags.has(t))) {
      spikeIt(item, "tagged never-print");
      return false;
    }
    return true;
  });

  const forced = candidates.filter((item) =>
    item.tags.map(lower).some((t) => alwaysTags.has(t)),
  );
  const rest = candidates
    .filter((item) => !forced.includes(item))
    .sort((a, b) => score(verdictById, b) - score(verdictById, a));

  const take = (item: EnrichedItem, forcedIn: boolean): boolean => {
    const verdict = verdictById.get(item.id);
    if (!verdict) {
      spikeIt(item, "no verdict");
      return false;
    }

    const duplicate = verdict.duplicateOf;
    if (duplicate && selected.some((s) => s.item.id === duplicate)) {
      spikeIt(item, `covers the same ground as another piece`);
      return false;
    }

    const treatment = clampTreatment(item, verdict.treatment, config);
    const cost = estimatePages(item, treatment, config);
    const kindCap = config.curation.maxPerKind[item.kind];
    const kindCount = perKind.get(item.kind) ?? 0;

    if (!forcedIn) {
      if (selected.length >= config.curation.maxPieces) {
        spikeIt(item, `issue full at ${config.curation.maxPieces} pieces`);
        return false;
      }
      if (pages + cost > config.curation.pageBudget) {
        spikeIt(item, `would not fit the ${config.curation.pageBudget}-page budget`);
        return false;
      }
      if (kindCap !== undefined && kindCount >= kindCap) {
        spikeIt(item, `already ${kindCap} ${item.kind}(s) in this issue`);
        return false;
      }
    }

    selected.push({ item, verdict: { ...verdict, treatment } });
    perKind.set(item.kind, kindCount + 1);
    pages += cost;
    return true;
  };

  for (const item of forced) take(item, true);
  for (const item of rest) take(item, false);

  if (selected.length < config.curation.minPieces) {
    log.warn(
      `only ${selected.length} piece(s) cleared the bar (minimum is ` +
        `${config.curation.minPieces}). A thin month is a real answer — ` +
        `consider skipping this issue rather than padding it.`,
    );
  }

  log.info(
    `selected ${selected.length} piece(s), roughly ${pages.toFixed(2)} pages, ` +
      `${spike.length} spiked`,
  );

  return { selected: order(selected, config), spike };
}

/**
 * Printing order: the strongest piece leads the front page, then sections in
 * their configured order, strongest first inside each.
 */
function order(
  selected: { item: EnrichedItem; verdict: Verdict }[],
  config: Config,
): { item: EnrichedItem; verdict: Verdict }[] {
  const sections = config.curation.sections;
  const sorted = [...selected].sort((a, b) => {
    const sectionDelta =
      sectionIndex(a.verdict.section, sections) -
      sectionIndex(b.verdict.section, sections);
    if (sectionDelta !== 0) return sectionDelta;
    return b.verdict.score - a.verdict.score;
  });

  const leadIndex = sorted.reduce(
    (best, entry, index) =>
      entry.verdict.score > (sorted[best]?.verdict.score ?? -1) ? index : best,
    0,
  );
  const [lead] = sorted.splice(leadIndex, 1);
  return lead ? [lead, ...sorted] : sorted;
}

function sectionIndex(section: string, sections: string[]): number {
  const index = sections.indexOf(section);
  return index === -1 ? sections.length : index;
}

function score(verdicts: Map<string, Verdict>, item: EnrichedItem): number {
  return verdicts.get(item.id)?.score ?? 0;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}
