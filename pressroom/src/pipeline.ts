import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.js";
import { mapLimit } from "./http.js";
import { truncateWords } from "./text.js";
import type { Config, Secrets } from "./config.js";
import type { EnrichedItem, Issue, IssuePiece, Verdict } from "./types.js";
import { collectSavedItems, monthWindow, type MonthWindow } from "./sources/index.js";
import { enrichAll } from "./enrich/index.js";
import { scoreCandidates, composePiece, writeEditorsNote, fallbackCopy } from "./curate/claude.js";
import { clampTreatment, estimatePages, selectIssue } from "./curate/index.js";

export function savesPath(outDir: string, month: string): string {
  return join(outDir, `saves-${month}.json`);
}

export function draftPath(outDir: string, month: string): string {
  return join(outDir, `issue-${month}.draft.json`);
}

export function issuePath(outDir: string, month: string): string {
  return join(outDir, `issue-${month}.json`);
}

/** Calendar-derived, so CI and your laptop agree without shared state. */
export function issueNumber(config: Config, month: string): number {
  const first = config.firstIssueMonth ?? month;
  const [fy, fm] = first.split("-").map(Number) as [number, number];
  const [y, m] = month.split("-").map(Number) as [number, number];
  const elapsed = (y - fy) * 12 + (m - fm);
  return config.firstIssueNumber + Math.max(0, elapsed);
}

export async function runFetch(
  config: Config,
  secrets: Secrets,
  window: MonthWindow,
  outDir: string,
): Promise<EnrichedItem[]> {
  log.step(`Collecting saves for ${window.monthLabel}`);
  const saved = await collectSavedItems(config, secrets, window);
  if (saved.length === 0) {
    log.warn(`nothing was saved in ${window.monthLabel}`);
  }
  const enriched = await enrichAll(saved);
  await mkdir(outDir, { recursive: true });
  await writeFile(savesPath(outDir, window.month), JSON.stringify(enriched, null, 2));
  return enriched;
}

export async function loadSaves(
  outDir: string,
  month: string,
): Promise<EnrichedItem[]> {
  const raw = await readFile(savesPath(outDir, month), "utf8");
  return JSON.parse(raw) as EnrichedItem[];
}

export interface CurateOptions {
  /** Skip every model call and use a transparent heuristic instead. */
  noAi: boolean;
}

export async function runCurate(
  items: EnrichedItem[],
  config: Config,
  secrets: Secrets,
  window: MonthWindow,
  outDir: string,
  options: CurateOptions,
): Promise<Issue> {
  const verdicts = options.noAi
    ? heuristicVerdicts(items, config)
    : await scoreCandidates(items, config, secrets.anthropicApiKey);

  const { selected, spike } = selectIssue(items, verdicts, config);

  log.step(`Writing copy for ${selected.length} piece(s)`);
  const pieces = await mapLimit(selected, 3, async ({ item, verdict }) => {
    const copy = options.noAi
      ? fallbackCopy(item, verdict, config)
      : await composePiece(item, verdict, config, secrets.anthropicApiKey);
    const piece: IssuePiece = {
      item,
      verdict,
      ...copy,
      estimatedPages: estimatePages(item, verdict.treatment, config),
    };
    log.info(`  ${verdict.treatment.padEnd(13)} ${piece.headline}`);
    return piece;
  });

  const note = options.noAi
    ? {
        editorsNote: `${pieces.length} pieces from ${window.monthLabel}, strongest first.`,
        strapline: config.motto,
      }
    : await writeEditorsNote(pieces, window, config, secrets.anthropicApiKey);

  const issue: Issue = {
    number: issueNumber(config, window.month),
    month: window.month,
    monthLabel: window.monthLabel,
    generatedAt: new Date().toISOString(),
    masthead: config.masthead,
    editorsNote: note.editorsNote,
    pieces,
    spike,
    stats: {
      captured: items.length,
      enrichedFull: items.filter((i) => i.enrichment.status === "full").length,
      printed: pieces.length,
    },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(draftPath(outDir, window.month), JSON.stringify(issue, null, 2));
  return issue;
}

export async function loadDraft(outDir: string, month: string): Promise<Issue> {
  const raw = await readFile(draftPath(outDir, month), "utf8");
  return JSON.parse(raw) as Issue;
}

export async function loadIssue(outDir: string, month: string): Promise<Issue> {
  const raw = await readFile(issuePath(outDir, month), "utf8");
  return JSON.parse(raw) as Issue;
}

/**
 * The no-API path. Deliberately dumb and legible: recency, substance, and
 * your own tags. It is a fallback for a missing key or a dry run, not a
 * replacement for reading the things.
 */
export function heuristicVerdicts(items: EnrichedItem[], config: Config): Verdict[] {
  const sections = config.curation.sections;
  const newest = Math.max(...items.map((i) => new Date(i.savedAt).getTime()), 0);

  return items.map((item) => {
    const ageDays = (newest - new Date(item.savedAt).getTime()) / 86_400_000;
    const lengthScore = Math.min(10, item.wordCount / 400);
    const recency = Math.max(0, 10 - ageDays / 3);
    const retrieval = item.enrichment.status === "full" ? 10 : item.enrichment.status === "partial" ? 4 : 1;
    const noted = item.note ? 10 : 3;
    const score = Math.round(
      lengthScore * 2.5 + recency * 1.5 + retrieval * 3 + noted * 3,
    );

    return {
      id: item.id,
      score: Math.min(100, score),
      pitch: `Heuristic only: ${item.wordCount} words, retrieved ${item.enrichment.status}.`,
      section: sections.at(-1) ?? "Shorts",
      treatment: clampTreatment(item, "full", config),
      rubric: {
        durability: recency,
        density: lengthScore,
        printFit: retrieval,
        personalPull: noted,
      },
    };
  });
}

export function summariseIssue(issue: Issue): string {
  const lines = issue.pieces.map(
    (piece, index) =>
      `${String(index + 1).padStart(2, " ")}. [${piece.verdict.section}] ${piece.headline}\n` +
      `    ${truncateWords(piece.verdict.pitch, 24)}\n` +
      `    score ${piece.verdict.score} · ${piece.verdict.treatment} · ~${piece.estimatedPages} pages · ${piece.item.url}`,
  );
  return lines.join("\n");
}

export { monthWindow };
