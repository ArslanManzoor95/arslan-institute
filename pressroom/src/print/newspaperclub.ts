import type { Config } from "../config.js";
import type { Issue } from "../types.js";
import type { PrintResult } from "./index.js";

/**
 * Newspaper Club has no public ordering API, so this adapter does the part
 * that can be automated — producing a file that passes their preflight — and
 * hands you a checklist for the two minutes that cannot.
 *
 * Their digital tabloid: 289 x 380mm, 15mm margins top/bottom/outside, 4-64
 * pages in multiples of 4, greyscale or CMYK, single pages rather than
 * spreads. Those are the defaults in `layout`, so a file built by this tool
 * already matches.
 */
export function newspaperClubHandoff(
  issue: Issue,
  config: Config,
  printPath: string,
): PrintResult {
  const steps = [
    `Open https://www.newspaperclub.com/print/upload`,
    `Choose "Digital Tabloid", ${config.print.copies} cop${config.print.copies === 1 ? "y" : "ies"}.`,
    `Upload ${printPath} (${issue.pageCount} pages, ${config.print.colour}).`,
    `Their preflight will show a page-by-page preview — check page 1 and the`,
    `  last page, then approve.`,
    `Pay. One to seven working days by Royal Mail.`,
  ];

  return {
    vendor: "newspaperclub",
    placed: false,
    requiresManualUpload: true,
    reference: `${issue.masthead} No. ${issue.number}`,
    instructions: steps.join("\n"),
    uploadUrl: "https://www.newspaperclub.com/print/upload",
  };
}
