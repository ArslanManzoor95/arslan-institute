import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { PDFDocument } from "pdf-lib";
import { log } from "../log.js";
import type { LayoutConfig } from "../config.js";

const run = promisify(execFile);

const MM_TO_PT = 72 / 25.4;

/** Render one HTML document to a PDF at the configured page size. */
export async function htmlToPdf(
  html: string,
  layout: LayoutConfig,
): Promise<Uint8Array> {
  let browser: Browser | undefined;
  try {
    // PRESSROOM_CHROMIUM_PATH covers pinned CI images and distro builds where
    // Playwright's own download is absent or a different revision.
    const executablePath = process.env.PRESSROOM_CHROMIUM_PATH || undefined;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    const page = await browser.newPage();
    // No network: everything is inlined, and a stray request would only
    // add latency and non-determinism.
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:")) return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    const buffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      width: `${layout.pageWidthMm}mm`,
      height: `${layout.pageHeightMm}mm`,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return new Uint8Array(buffer);
  } finally {
    await browser?.close();
  }
}

export async function countPages(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPageCount();
}

/** Concatenate rendered parts into the final issue. */
export async function mergePdfs(parts: Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const part of parts) {
    const doc = await PDFDocument.load(part);
    const pages = await merged.copyPages(doc, doc.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return merged.save();
}

/**
 * Printers impose in signatures, so the page count has to land on a multiple
 * of four. Anything still short after the notes pages gets a genuinely blank
 * leaf — better an empty page than a padded one.
 */
export async function padToMultiple(
  pdf: Uint8Array,
  layout: LayoutConfig,
  multiple: number,
  minPages: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const target = Math.max(
    minPages,
    Math.ceil(doc.getPageCount() / multiple) * multiple,
  );
  const width = layout.pageWidthMm * MM_TO_PT;
  const height = layout.pageHeightMm * MM_TO_PT;

  while (doc.getPageCount() < target) doc.addPage([width, height]);
  return doc.save();
}

/** Set the PDF's title and author so the file is identifiable in a queue. */
export async function stampMetadata(
  pdf: Uint8Array,
  meta: { title: string; author: string; subject: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  doc.setTitle(meta.title);
  doc.setAuthor(meta.author);
  doc.setSubject(meta.subject);
  doc.setProducer("pressroom");
  doc.setCreator("pressroom");
  return doc.save();
}

export async function hasGhostscript(): Promise<boolean> {
  try {
    await run("gs", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Chromium only emits RGB. Print shops want greyscale or CMYK, so convert
 * before handing the file over. Ghostscript is the only dependency here and
 * it is optional — without it we ship RGB and say so loudly.
 */
export async function toGreyscale(
  inputPath: string,
  outputPath: string,
): Promise<boolean> {
  if (!(await hasGhostscript())) {
    log.warn(
      "ghostscript not found — the PDF stays RGB. Most printers convert it " +
        "for you, but the result is theirs, not yours. Install with " +
        "`brew install ghostscript` or `apt-get install ghostscript`.",
    );
    return false;
  }

  await run("gs", [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dPDFSETTINGS=/prepress",
    "-dNOPAUSE",
    "-dBATCH",
    "-dSAFER",
    "-dAutoRotatePages=/None",
    "-sColorConversionStrategy=Gray",
    "-dProcessColorModel=/DeviceGray",
    "-dOverrideICC",
    `-sOutputFile=${outputPath}`,
    inputPath,
  ]);
  log.info("converted to greyscale");
  return true;
}
