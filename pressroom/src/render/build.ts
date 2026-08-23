import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../log.js";
import type { Config } from "../config.js";
import type { Issue } from "../types.js";
import { renderIssueHtml, renderBackmatterHtml } from "./html.js";
import {
  countPages,
  htmlToPdf,
  mergePdfs,
  padToMultiple,
  stampMetadata,
  toGreyscale,
} from "./pdf.js";

/** How many times we will shrink the issue to hit the page budget. */
const MAX_FIT_PASSES = 6;

export interface BuildResult {
  issue: Issue;
  /** The file to hand the printer. */
  printPath: string;
  /** The RGB file, for reading on screen before you approve. */
  proofPath: string;
  htmlPath: string;
  dataPath: string;
  pageCount: number;
  greyscaleApplied: boolean;
}

export async function buildIssue(
  issue: Issue,
  config: Config,
  outDir: string,
): Promise<BuildResult> {
  await mkdir(outDir, { recursive: true });
  const stem = `issue-${issue.month}`;

  const { mainPdf, working } = await fitToBudget(issue, config);

  // Back matter is rendered twice: once to learn its natural length, then
  // again with exactly enough notes pages to land on the printer's multiple.
  const bare = await htmlToPdf(await renderBackmatterHtml(working, config, 0), config.layout);
  const bareCount = await countPages(bare);
  const mainCount = await countPages(mainPdf);
  const multiple = config.layout.pageMultiple;
  const shortfall = (multiple - ((mainCount + bareCount) % multiple)) % multiple;

  const backPdf =
    shortfall === 0
      ? bare
      : await htmlToPdf(
          await renderBackmatterHtml(working, config, shortfall),
          config.layout,
        );

  let merged = await mergePdfs([mainPdf, backPdf]);
  merged = await padToMultiple(merged, config.layout, multiple, config.layout.minPages);

  const pageCount = await countPages(merged);
  working.pageCount = pageCount;

  merged = await stampMetadata(merged, {
    title: `${working.masthead} No. ${working.number} — ${working.monthLabel}`,
    author: working.masthead,
    subject: `${working.pieces.length} pieces saved in ${working.monthLabel}`,
  });

  const proofPath = join(outDir, `${stem}.proof.pdf`);
  const printPath = join(outDir, `${stem}.print.pdf`);
  const htmlPath = join(outDir, `${stem}.html`);
  const dataPath = join(outDir, `${stem}.json`);

  await writeFile(proofPath, merged);
  await writeFile(htmlPath, await renderIssueHtml(working, config));

  let greyscaleApplied = false;
  if (config.print.colour === "greyscale") {
    greyscaleApplied = await toGreyscale(proofPath, printPath);
  }
  if (!greyscaleApplied) {
    await writeFile(printPath, merged);
  }

  // Written last: it records what actually happened, including whether the
  // greyscale conversion ran, so `pressroom order` need not guess.
  working.greyscaleApplied = greyscaleApplied;
  await writeFile(dataPath, JSON.stringify(working, null, 2));

  log.info(`built ${pageCount} pages → ${printPath}`);

  return {
    issue: working,
    printPath,
    proofPath,
    htmlPath,
    dataPath,
    pageCount,
    greyscaleApplied,
  };
}

/**
 * Render, measure, and if the issue runs long, spike the weakest piece and
 * try again. Estimates get you close; only the real render tells the truth.
 */
async function fitToBudget(
  issue: Issue,
  config: Config,
): Promise<{ mainPdf: Uint8Array; working: Issue }> {
  const working: Issue = { ...issue, pieces: [...issue.pieces], spike: [...issue.spike] };
  // Two pages of back matter is the usual cost; leave room for it.
  const editorialBudget = Math.max(4, config.layout.maxPages - 2);

  for (let pass = 1; pass <= MAX_FIT_PASSES; pass++) {
    const pdf = await htmlToPdf(await renderIssueHtml(working, config), config.layout);
    const pages = await countPages(pdf);
    log.info(`render pass ${pass}: ${pages} editorial pages`);

    const overBudget = pages > Math.min(editorialBudget, config.curation.pageBudget + 2);
    if (!overBudget || working.pieces.length <= config.curation.minPieces) {
      if (overBudget) {
        log.warn(
          `issue is ${pages} pages and cannot shrink further without dropping ` +
            `below the ${config.curation.minPieces}-piece minimum`,
        );
      }
      return { mainPdf: pdf, working };
    }

    const weakest = working.pieces.reduce((worst, piece) =>
      piece.verdict.score < worst.verdict.score ? piece : worst,
    );
    working.pieces = working.pieces.filter((p) => p !== weakest);
    working.spike.push({
      title: weakest.item.title,
      url: weakest.item.url,
      kind: weakest.item.kind,
      reason: "the issue ran long once typeset",
    });
    working.stats = { ...working.stats, printed: working.pieces.length };
    log.info(`over budget at ${pages} pages — spiked "${weakest.headline}"`);
  }

  const pdf = await htmlToPdf(await renderIssueHtml(working, config), config.layout);
  return { mainPdf: pdf, working };
}

export async function readPdf(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}
