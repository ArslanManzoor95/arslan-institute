import { PDFDocument } from "pdf-lib";
import type { Config } from "./config.js";

export interface Check {
  name: string;
  ok: boolean;
  /** A failed check blocks the order; a warning does not. */
  severity: "error" | "warning";
  detail: string;
}

const MM_TO_PT = 72 / 25.4;
/** Printers allow a little slop on page size; a millimetre is plenty. */
const SIZE_TOLERANCE_PT = 3;

/**
 * The checks a print shop would run on your file before they charge you for
 * a reprint. Newspaper Club's digital tabloid rules are the defaults:
 * 289 x 380mm, 4-64 pages, multiples of 4, greyscale or CMYK.
 */
export async function preflight(
  pdf: Uint8Array,
  config: Config,
  options: { greyscaleApplied: boolean },
): Promise<Check[]> {
  const doc = await PDFDocument.load(pdf);
  const pageCount = doc.getPageCount();
  const { layout } = config;
  const checks: Check[] = [];

  checks.push({
    name: "page-multiple",
    ok: pageCount % layout.pageMultiple === 0,
    severity: "error",
    detail: `${pageCount} pages; the printer needs a multiple of ${layout.pageMultiple}`,
  });

  checks.push({
    name: "page-count-range",
    ok: pageCount >= layout.minPages && pageCount <= layout.maxPages,
    severity: "error",
    detail: `${pageCount} pages; allowed range is ${layout.minPages}-${layout.maxPages}`,
  });

  const expectedWidth = layout.pageWidthMm * MM_TO_PT;
  const expectedHeight = layout.pageHeightMm * MM_TO_PT;
  const wrongSize = doc.getPages().filter((page) => {
    const { width, height } = page.getSize();
    return (
      Math.abs(width - expectedWidth) > SIZE_TOLERANCE_PT ||
      Math.abs(height - expectedHeight) > SIZE_TOLERANCE_PT
    );
  });

  checks.push({
    name: "page-size",
    ok: wrongSize.length === 0,
    severity: "error",
    detail:
      wrongSize.length === 0
        ? `every page is ${layout.pageWidthMm} x ${layout.pageHeightMm}mm`
        : `${wrongSize.length} page(s) are not ${layout.pageWidthMm} x ${layout.pageHeightMm}mm`,
  });

  checks.push({
    name: "colour-space",
    ok: config.print.colour !== "greyscale" || options.greyscaleApplied,
    severity: "warning",
    detail: options.greyscaleApplied
      ? "converted to DeviceGray"
      : "still RGB — the printer will convert it, and the result is their call",
  });

  const megabytes = pdf.byteLength / 1_000_000;
  checks.push({
    name: "file-size",
    ok: megabytes < 300,
    severity: "warning",
    detail: `${megabytes.toFixed(1)} MB`,
  });

  return checks;
}

export function preflightPassed(checks: Check[]): boolean {
  return !checks.some((check) => !check.ok && check.severity === "error");
}

export function formatChecks(checks: Check[]): string {
  return checks
    .map((check) => {
      const mark = check.ok ? "PASS" : check.severity === "error" ? "FAIL" : "WARN";
      return `  ${mark}  ${check.name.padEnd(18)} ${check.detail}`;
    })
    .join("\n");
}
