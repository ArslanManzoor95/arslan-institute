import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { Issue, IssuePiece } from "../types.js";
import { escapeHtml, paragraphs, typographic } from "../text.js";
import { qrSvg, displayUrl } from "./qr.js";

// ESM has no __dirname; derive it from the module URL.
const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "templates", "newsprint.css"), "utf8");

/** Where a pull quote is dropped into the flow. */
const PULL_QUOTE_EVERY = 5;

export async function renderIssueHtml(
  issue: Issue,
  config: Config,
): Promise<string> {
  const body = [
    frontPage(issue, config),
    await piecesHtml(issue.pieces, config),
  ].join("\n");
  return shell(issue, config, body);
}

export async function renderBackmatterHtml(
  issue: Issue,
  config: Config,
  notesPages: number,
): Promise<string> {
  const body = [backmatter(issue, config), notes(notesPages)].join("\n");
  return shell(issue, config, body);
}

function shell(issue: Issue, config: Config, body: string): string {
  const { layout } = config;
  const textHeight = layout.pageHeightMm - layout.marginMm * 2;
  const vars = [
    `--page-width: ${layout.pageWidthMm}mm`,
    `--page-height: ${layout.pageHeightMm}mm`,
    `--page-margin: ${layout.marginMm}mm`,
    `--text-height: ${textHeight}mm`,
    `--columns: ${layout.columns}`,
    `--column-gap: 6mm`,
    `--body-size: ${layout.bodyPt}pt`,
    `--body-leading: ${layout.leadingPt}pt`,
  ].join("; ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(issue.masthead)} — ${escapeHtml(issue.monthLabel)}</title>
<style>
@page { size: ${layout.pageWidthMm}mm ${layout.pageHeightMm}mm; margin: ${layout.marginMm}mm; }
:root { ${vars}; }
${CSS}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Nameplate type is set to the measure, not to a fixed size: a long masthead
 * at 78pt runs off the page and a short one leaves the sheet looking empty.
 * Widths are estimated per character — caps and spaces differ enough that an
 * average would still overflow on a word like "MMM".
 */
export function mastheadPt(masthead: string, config: Config): number {
  const measurePt =
    (config.layout.pageWidthMm - config.layout.marginMm * 2) * (72 / 25.4);
  const ems = [...masthead.toUpperCase()].reduce((total, char) => {
    if (char === " ") return total + 0.26;
    if ("MW".includes(char)) return total + 0.92;
    if ("IJ".includes(char)) return total + 0.36;
    if ("EFLTZ".includes(char)) return total + 0.61;
    return total + 0.7;
  }, 0);
  // The 0.98 keeps a hair of air at both ends of the line.
  return Math.min(96, (measurePt * 0.98) / Math.max(ems, 1));
}

function frontPage(issue: Issue, config: Config): string {
  const contents = issue.pieces
    .map(
      (piece, index) => `<li>
        <span class="num">${String(index + 1).padStart(2, "0")}</span>
        <span>
          <span class="title">${escapeHtml(typographic(piece.headline))}</span>
          <span class="meta">${escapeHtml(piece.verdict.section)} · ${describeLength(piece)}</span>
        </span>
      </li>`,
    )
    .join("\n");

  const noteParagraphs = paragraphs(issue.editorsNote)
    .map((p) => `<p>${escapeHtml(typographic(p))}</p>`)
    .join("\n");

  const noteHasDropCap = (paragraphs(issue.editorsNote)[0]?.length ?? 0) >= 120;

  return `<section class="frontpage">
  <header class="nameplate">
    <h1 style="font-size:${mastheadPt(issue.masthead, config).toFixed(1)}pt">${escapeHtml(issue.masthead)}</h1>
    ${config.motto ? `<div class="strapline">${escapeHtml(config.motto)}</div>` : ""}
  </header>
  <div class="folio-bar">
    <span>No. ${issue.number}</span>
    <span>${escapeHtml(issue.monthLabel)}</span>
    <span>${issue.pieces.length} pieces · printed for one reader</span>
  </div>
  <div class="frontpage-grid">
    <div class="editors-note${noteHasDropCap ? " has-dropcap" : ""}">
      <h2>From the editor</h2>
      ${noteParagraphs}
    </div>
    <nav class="contents">
      <h2>Inside</h2>
      <ol>${contents}</ol>
      <p class="stats-strip">${statsStrip(issue)}</p>
    </nav>
  </div>
  ${leadBand(issue)}
</section>`;
}

/**
 * The bottom of the front page. Without it, a short editor's note leaves the
 * sheet looking half-finished; with it, page one always reads as composed.
 */
function leadBand(issue: Issue): string {
  const lead = issue.pieces[0];
  if (!lead) return "";
  return `<div class="lead-band">
    <span class="kicker">The lead · ${escapeHtml(lead.verdict.section)}</span>
    <h2>${escapeHtml(typographic(lead.headline))}</h2>
    ${lead.standfirst ? `<p class="standfirst">${escapeHtml(typographic(lead.standfirst))}</p>` : ""}
    <span class="kicker">First inside</span>
  </div>`;
}

function statsStrip(issue: Issue): string {
  const minutes = issue.pieces.reduce(
    (total, piece) =>
      total +
      (piece.verdict.treatment === "summary-card" ? 2 : piece.item.readingMinutes),
    0,
  );
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const time = hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
  return `${issue.stats.captured} saved · ${issue.stats.printed} printed · about ${time} of reading`;
}

/** Group consecutive pieces so cards share a grid and sections get one head. */
async function piecesHtml(pieces: IssuePiece[], config: Config): Promise<string> {
  const out: string[] = [];
  let currentSection: string | null = null;
  let cardRun: IssuePiece[] = [];

  const flushCards = async () => {
    if (cardRun.length === 0) return;
    const cards = await Promise.all(
      cardRun.map((piece) => cardHtml(piece, config)),
    );
    out.push(`<div class="cards">\n${cards.join("\n")}\n</div>`);
    cardRun = [];
  };

  for (const [index, piece] of pieces.entries()) {
    if (piece.verdict.section !== currentSection) {
      await flushCards();
      currentSection = piece.verdict.section;
      out.push(
        `<h3 class="section-head">${escapeHtml(currentSection)}</h3>`,
      );
    }

    if (piece.verdict.treatment === "summary-card") {
      cardRun.push(piece);
      continue;
    }

    await flushCards();
    out.push(await articleHtml(piece, config, index === 0));
  }

  await flushCards();
  return out.join("\n");
}

async function articleHtml(
  piece: IssuePiece,
  config: Config,
  isLead: boolean,
): Promise<string> {
  const classes = ["piece", `piece--${piece.verdict.treatment}`];
  if (isLead) classes.push("piece--lead");

  const bodyParagraphs = paragraphs(piece.body);
  const withQuotes = interleavePullQuotes(bodyParagraphs, piece.pullQuotes);

  const tail =
    piece.verdict.treatment === "extract"
      ? await continuesBlock(piece, config)
      : `<p class="continues">Source: ${escapeHtml(displayUrl(piece.item.url))}</p>`;

  return `<article class="${classes.join(" ")}">
  <div class="piece-head">
    <h2>${escapeHtml(typographic(piece.headline))}</h2>
    ${piece.standfirst ? `<p class="standfirst">${escapeHtml(typographic(piece.standfirst))}</p>` : ""}
    <div class="byline">${byline(piece)}</div>
  </div>
  <div class="piece-body">
${withQuotes}
${tail}
  </div>
</article>`;
}

async function cardHtml(piece: IssuePiece, config: Config): Promise<string> {
  const wide =
    piece.item.kind === "video" || piece.item.kind === "podcast" ? " piece--wide" : "";
  const bodyParagraphs = paragraphs(piece.body)
    .map((p) => `<p>${escapeHtml(typographic(p))}</p>`)
    .join("\n");

  return `<article class="piece piece--card${wide}">
  <div class="piece-head">
    <h2>${escapeHtml(typographic(piece.headline))}</h2>
    ${piece.standfirst ? `<p class="standfirst">${escapeHtml(typographic(piece.standfirst))}</p>` : ""}
    <div class="byline">${byline(piece)}</div>
  </div>
  <div class="piece-body">
${bodyParagraphs}
  </div>
  ${await qrFoot(piece, config, cardFootLabel(piece))}
</article>`;
}

async function continuesBlock(piece: IssuePiece, config: Config): Promise<string> {
  return `<div class="continues">${await qrFoot(
    piece,
    config,
    `This is an extract. The full piece — about ${piece.item.wordCount.toLocaleString("en-GB")} words — is at:`,
  )}</div>`;
}

async function qrFoot(
  piece: IssuePiece,
  config: Config,
  label: string,
): Promise<string> {
  const svg = await qrSvg(piece.item.url);
  const caption =
    piece.item.kind === "video" || piece.item.kind === "podcast" ? "Watch" : "Read";
  void config;
  return `<div class="card-foot">
    <div class="where">${escapeHtml(label)}<br>${escapeHtml(displayUrl(piece.item.url))}</div>
    <div>
      <div class="qr">${svg}</div>
      <div class="qr-caption">${caption}</div>
    </div>
  </div>`;
}

function cardFootLabel(piece: IssuePiece): string {
  if (piece.item.kind === "video" || piece.item.kind === "podcast") {
    const runtime = piece.item.durationSeconds
      ? ` (${Math.round(piece.item.durationSeconds / 60)} min)`
      : "";
    return `Summarised for print. The original${runtime} is at:`;
  }
  return "The original is at:";
}

function interleavePullQuotes(
  bodyParagraphs: string[],
  pullQuotes: string[],
): string {
  const out: string[] = [];
  let quoteIndex = 0;

  for (const [index, paragraph] of bodyParagraphs.entries()) {
    out.push(`<p>${escapeHtml(typographic(paragraph))}</p>`);
    const due = index > 0 && (index + 1) % PULL_QUOTE_EVERY === 0;
    const remaining = bodyParagraphs.length - index > 3;
    if (due && remaining && quoteIndex < pullQuotes.length) {
      const quote = pullQuotes[quoteIndex++]!;
      out.push(
        `<blockquote class="pull">${escapeHtml(typographic(quote))}</blockquote>`,
      );
    }
  }

  return out.join("\n");
}

function byline(piece: IssuePiece): string {
  const bits = [
    piece.item.author,
    piece.item.siteName,
    describeLength(piece),
    piece.item.publishedAt
      ? new Date(piece.item.publishedAt).toLocaleDateString("en-GB", {
          month: "short",
          year: "numeric",
        })
      : undefined,
  ].filter((b): b is string => Boolean(b));
  return escapeHtml(bits.join(" · "));
}

function describeLength(piece: IssuePiece): string {
  if (piece.verdict.treatment === "summary-card") {
    if (piece.item.durationSeconds) {
      return `${Math.round(piece.item.durationSeconds / 60)} min to watch`;
    }
    return "summary";
  }
  return `${piece.item.readingMinutes} min read`;
}

function backmatter(issue: Issue, config: Config): string {
  const spike = issue.spike
    .map(
      (entry) => `<li>
        <span class="title">${escapeHtml(typographic(entry.title))}</span>
        <span class="reason">${escapeHtml(entry.reason)} · ${escapeHtml(displayUrl(entry.url, 48))}</span>
      </li>`,
    )
    .join("\n");

  return `<section class="backmatter">
  <h3 class="section-head">The spike — saved, not printed</h3>
  <p class="continues">${issue.spike.length} of the ${issue.stats.captured} things you saved in ${escapeHtml(issue.monthLabel)} did not make the paper. They are listed here so nothing disappears silently. Nothing on this list needs your attention.</p>
  <ul class="spike-list">${spike}</ul>
  <div class="colophon">
    ${escapeHtml(issue.masthead)}, No. ${issue.number} · ${escapeHtml(issue.monthLabel)}<br>
    Assembled ${escapeHtml(new Date(issue.generatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }))} from ${issue.stats.captured} saved links; ${issue.stats.enrichedFull} were retrieved in full; ${issue.stats.printed} were printed.<br>
    Set in ${escapeHtml(config.layout.columns.toString())} columns at ${config.layout.bodyPt}pt on ${config.layout.leadingPt}pt.<br>
    Summaries and headlines written by Claude (${escapeHtml(config.curation.model)}); article text is the authors' own, unedited.<br>
    Printed once. Not for distribution.
  </div>
</section>`;
}

/** Ruled pages, used to pad the issue up to the printer's page multiple. */
function notes(count: number): string {
  if (count <= 0) return "";
  const lines = Array.from({ length: 26 }, () => "<div></div>").join("");
  return Array.from(
    { length: count },
    () => `<section class="notes-page">
  <h2>Notes</h2>
  <div class="rules">${lines}</div>
</section>`,
  ).join("\n");
}
