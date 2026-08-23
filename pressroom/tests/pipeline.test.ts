import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { ConfigSchema, type Config } from "../src/config.js";
import {
  canonicalUrl,
  dedupeByUrl,
  monthWindow,
  previousMonth,
} from "../src/sources/index.js";
import { clampTreatment, estimatePages, selectIssue } from "../src/curate/index.js";
import { issueNumber } from "../src/pipeline.js";
import { preflight, preflightPassed } from "../src/preflight.js";
import { mastheadPt } from "../src/render/html.js";
import type { EnrichedItem, SavedItem, Verdict } from "../src/types.js";

const config: Config = ConfigSchema.parse({});

function saved(overrides: Partial<SavedItem> = {}): SavedItem {
  return {
    id: overrides.id ?? "inbox:1",
    source: "inbox",
    sourceId: "1",
    url: "https://example.com/a",
    title: "A piece",
    savedAt: "2026-07-10T09:00:00.000Z",
    kind: "article",
    tags: [],
    ...overrides,
  };
}

function enriched(overrides: Partial<EnrichedItem> = {}): EnrichedItem {
  const words = overrides.wordCount ?? 1000;
  return {
    ...saved(overrides),
    text: "word ".repeat(words).trim(),
    wordCount: words,
    readingMinutes: Math.max(1, Math.round(words / 230)),
    enrichment: { status: "full", method: "test" },
    ...overrides,
  };
}

function verdict(id: string, overrides: Partial<Verdict> = {}): Verdict {
  return {
    id,
    score: 50,
    pitch: "because",
    section: "Ideas",
    treatment: "full",
    rubric: { durability: 5, density: 5, printFit: 5, personalPull: 5 },
    ...overrides,
  };
}

test("month windows respect the reader's timezone", () => {
  const summer = monthWindow("2026-07", "Europe/London");
  // London is UTC+1 in July, so the month opens an hour before midnight UTC.
  assert.equal(summer.start, "2026-06-30T23:00:00.000Z");
  assert.equal(summer.end, "2026-07-31T23:00:00.000Z");
  assert.equal(summer.monthLabel, "July 2026");

  const winter = monthWindow("2026-01", "Europe/London");
  assert.equal(winter.start, "2026-01-01T00:00:00.000Z");

  const utc = monthWindow("2026-07", "UTC");
  assert.equal(utc.start, "2026-07-01T00:00:00.000Z");
});

test("previousMonth rolls over the year boundary", () => {
  assert.equal(previousMonth("UTC", new Date("2026-01-04T10:00:00Z")), "2025-12");
  assert.equal(previousMonth("UTC", new Date("2026-08-01T00:30:00Z")), "2026-07");
});

test("month strings are validated", () => {
  assert.throws(() => monthWindow("July", "UTC"), /YYYY-MM/);
});

test("canonicalUrl strips tracking noise but keeps meaning", () => {
  assert.equal(
    canonicalUrl("https://www.Example.com/piece/?utm_source=x&id=7#top"),
    "https://example.com/piece?id=7",
  );
  // A real query parameter must survive.
  assert.match(canonicalUrl("https://example.com/watch?v=abc&si=1"), /v=abc/);
  assert.doesNotMatch(canonicalUrl("https://example.com/watch?v=abc&si=1"), /si=1/);
});

test("duplicate saves merge, keeping the richer copy and earliest date", () => {
  const merged = dedupeByUrl([
    saved({ id: "a", url: "https://example.com/x?utm_source=t", savedAt: "2026-07-20T00:00:00.000Z", tags: ["later"] }),
    saved({ id: "b", url: "https://www.example.com/x", savedAt: "2026-07-02T00:00:00.000Z", note: "why", html: "<p>".padEnd(50, "x"), tags: ["print"] }),
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.id, "b", "the copy with more content wins");
  assert.equal(merged[0]!.savedAt, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(merged[0]!.tags.sort(), ["later", "print"]);
});

test("treatment is clamped by mechanical facts, not the model's opinion", () => {
  assert.equal(
    clampTreatment(enriched({ kind: "video", wordCount: 5000 }), "full", config),
    "summary-card",
    "a video is never printed as an article",
  );
  assert.equal(
    clampTreatment(enriched({ wordCount: 80 }), "full", config),
    "summary-card",
    "there is no article to set",
  );
  assert.equal(
    clampTreatment(enriched({ wordCount: 9000 }), "full", config),
    "extract",
    "a piece over the extract limit cannot run in full",
  );
  assert.equal(clampTreatment(enriched({ wordCount: 1500 }), "full", config), "full");
});

test("page estimates scale with length and treatment", () => {
  const long = enriched({ wordCount: 3000 });
  assert.ok(estimatePages(long, "full", config) > estimatePages(long, "extract", config) - 0.01);
  assert.equal(estimatePages(enriched({ kind: "video" }), "summary-card", config), 1);
  assert.equal(estimatePages(enriched({ kind: "post" }), "summary-card", config), 0.5);
});

test("selection honours the piece cap and spikes the rest with a reason", () => {
  const items = Array.from({ length: 20 }, (_, i) =>
    enriched({ id: `i${i}`, url: `https://example.com/${i}`, wordCount: 1200 }),
  );
  const verdicts = items.map((item, i) => verdict(item.id, { score: 100 - i }));

  const { selected, spike } = selectIssue(items, verdicts, {
    ...config,
    curation: { ...config.curation, maxPieces: 5, pageBudget: 99 },
  });

  assert.equal(selected.length, 5);
  assert.equal(spike.length, 15);
  assert.ok(spike.every((entry) => entry.reason.length > 0));
  // Highest scores first, so the top five ids are i0..i4.
  assert.deepEqual(
    selected.map((s) => s.item.id).sort(),
    ["i0", "i1", "i2", "i3", "i4"],
  );
});

test("selection honours the page budget", () => {
  const items = Array.from({ length: 10 }, (_, i) =>
    enriched({ id: `i${i}`, url: `https://example.com/${i}`, wordCount: 3000 }),
  );
  const verdicts = items.map((item, i) => verdict(item.id, { score: 100 - i }));

  const { selected } = selectIssue(items, verdicts, {
    ...config,
    curation: { ...config.curation, maxPieces: 99, pageBudget: 6 },
  });

  const pages = selected.reduce(
    (total, s) => total + estimatePages(s.item, s.verdict.treatment, config),
    0,
  );
  assert.ok(pages <= 6, `selected ${pages} pages, budget was 6`);
  assert.ok(selected.length > 0);
});

test("one kind cannot eat the issue", () => {
  const items = Array.from({ length: 8 }, (_, i) =>
    enriched({ id: `v${i}`, url: `https://example.com/v${i}`, kind: "video", wordCount: 2000 }),
  );
  const verdicts = items.map((item) => verdict(item.id, { score: 90 }));

  const { selected } = selectIssue(items, verdicts, config);
  assert.equal(selected.length, config.curation.maxPerKind.video);
});

test("tags override the scorer in both directions", () => {
  const items = [
    enriched({ id: "skip-me", url: "https://example.com/1", tags: ["skip"] }),
    enriched({ id: "force-me", url: "https://example.com/2", tags: ["print"] }),
    enriched({ id: "normal", url: "https://example.com/3" }),
  ];
  const verdicts = [
    verdict("skip-me", { score: 100 }),
    verdict("force-me", { score: 1 }),
    verdict("normal", { score: 60 }),
  ];

  const { selected, spike } = selectIssue(items, verdicts, {
    ...config,
    curation: { ...config.curation, maxPieces: 1 },
  });

  const ids = selected.map((s) => s.item.id);
  assert.ok(ids.includes("force-me"), "a print tag beats a low score");
  assert.ok(!ids.includes("skip-me"), "a skip tag beats a high score");
  assert.ok(spike.some((entry) => entry.reason === "tagged never-print"));
});

test("near-duplicates are spiked once the stronger one is in", () => {
  const items = [
    enriched({ id: "strong", url: "https://example.com/1" }),
    enriched({ id: "weak", url: "https://example.com/2" }),
  ];
  const verdicts = [
    verdict("strong", { score: 90 }),
    verdict("weak", { score: 40, duplicateOf: "strong" }),
  ];

  const { selected, spike } = selectIssue(items, verdicts, config);
  assert.deepEqual(selected.map((s) => s.item.id), ["strong"]);
  assert.equal(spike.length, 1);
});

test("issue numbers come from the calendar, not a counter file", () => {
  const numbered = { ...config, firstIssueNumber: 1, firstIssueMonth: "2026-09" };
  assert.equal(issueNumber(numbered, "2026-09"), 1);
  assert.equal(issueNumber(numbered, "2026-12"), 4);
  assert.equal(issueNumber(numbered, "2027-09"), 13);
  // A month before the first issue never produces a number below the first.
  assert.equal(issueNumber(numbered, "2026-01"), 1);
});

test("the masthead is sized to fit the measure", () => {
  const measurePt = (config.layout.pageWidthMm - config.layout.marginMm * 2) * (72 / 25.4);
  for (const name of ["The Monthly", "THE ARSLAN REVIEW", "M", "A Very Long Newspaper Name Indeed"]) {
    const size = mastheadPt(name, config);
    const estimatedWidth = size * name.length * 0.92;
    assert.ok(size > 0 && size <= 96, `${name}: ${size}pt out of range`);
    assert.ok(
      estimatedWidth >= measurePt * 0.3 || name.length < 4,
      `${name} should still fill the page`,
    );
  }
  assert.ok(mastheadPt("M", config) <= 96, "a one-letter masthead is capped");
  assert.ok(
    mastheadPt("A Very Long Newspaper Name Indeed", config) <
      mastheadPt("The Monthly", config),
    "longer names get smaller type",
  );
});

test("preflight blocks a page count the printer will reject", async () => {
  const doc = await PDFDocument.create();
  const width = config.layout.pageWidthMm * (72 / 25.4);
  const height = config.layout.pageHeightMm * (72 / 25.4);
  for (let i = 0; i < 6; i++) doc.addPage([width, height]);

  const checks = await preflight(await doc.save(), config, { greyscaleApplied: true });
  assert.equal(preflightPassed(checks), false);
  assert.equal(checks.find((c) => c.name === "page-multiple")?.ok, false);
  assert.equal(checks.find((c) => c.name === "page-size")?.ok, true);
});

test("preflight passes a well-formed issue", async () => {
  const doc = await PDFDocument.create();
  const width = config.layout.pageWidthMm * (72 / 25.4);
  const height = config.layout.pageHeightMm * (72 / 25.4);
  for (let i = 0; i < 16; i++) doc.addPage([width, height]);

  const checks = await preflight(await doc.save(), config, { greyscaleApplied: true });
  assert.equal(preflightPassed(checks), true);
});

test("preflight catches a page at the wrong size", async () => {
  const doc = await PDFDocument.create();
  const width = config.layout.pageWidthMm * (72 / 25.4);
  const height = config.layout.pageHeightMm * (72 / 25.4);
  for (let i = 0; i < 3; i++) doc.addPage([width, height]);
  doc.addPage([595, 842]); // A4 slipped in

  const checks = await preflight(await doc.save(), config, { greyscaleApplied: true });
  assert.equal(checks.find((c) => c.name === "page-size")?.ok, false);
});
