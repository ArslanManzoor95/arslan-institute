import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { log } from "../log.js";
import { mapLimit } from "../http.js";
import { truncateWords, sentences } from "../text.js";
import type { Config } from "../config.js";
import type { EnrichedItem, IssuePiece, Treatment, Verdict } from "../types.js";
import type { MonthWindow } from "../sources/index.js";

const VerdictSchema = z.object({
  id: z.string().describe("The candidate id, copied exactly"),
  score: z
    .number()
    .min(0)
    .max(100)
    .describe("How much this deserves ink this month"),
  durability: z.number().min(0).max(10),
  density: z.number().min(0).max(10),
  printFit: z.number().min(0).max(10),
  personalPull: z.number().min(0).max(10),
  section: z.string().describe("One of the section names given"),
  treatment: z.enum(["full", "extract", "summary-card"]),
  pitch: z
    .string()
    .describe("One sentence to the editor: why this is or is not worth ink"),
  duplicateOf: z
    .string()
    .nullable()
    .describe("Id of another candidate this substantially repeats, else null"),
});

const ScoreBatchSchema = z.object({
  verdicts: z.array(VerdictSchema),
});

const PieceCopySchema = z.object({
  headline: z.string().describe("6-10 words, newspaper register, no clickbait"),
  standfirst: z
    .string()
    .describe("One sentence, 15-30 words, saying what the reader will get"),
  pullQuotes: z
    .array(z.string())
    .describe("0-2 verbatim sentences from the text, each under 25 words"),
  summary: z
    .string()
    .describe(
      "Only for summary-card pieces: 250-400 words of original editorial " +
        "summary. Empty string for every other treatment.",
    ),
});

const EditorsNoteSchema = z.object({
  editorsNote: z
    .string()
    .describe("120-180 words, front page, addressed to the one reader"),
  strapline: z.string().describe("Under 12 words, sits under the masthead"),
});

/** Stable across every call in a run, so the prefix caches. */
function rubricSystemPrompt(config: Config): string {
  return [
    "You are the editor of a one-copy monthly newspaper. It is printed on real",
    "newsprint and posted to exactly one reader: the person who saved these",
    "links over the past month. They will read it in a chair, on paper, with no",
    "screen nearby.",
    "",
    "Your job is to say no. The reader saved far more than they can read. A",
    "paper of 12 good pieces gets read; a paper of 40 becomes another backlog",
    "sitting on the side table. Printing something mediocre is worse than",
    "leaving it out, because it costs the reader attention they cannot get back.",
    "",
    "Score each candidate 0-100 on these four dimensions (0-10 each, then form",
    "an overall score — the dimensions inform it, they do not average into it):",
    "",
    "- durability: will this still be worth reading a month from now? News that",
    "  has already resolved, launch announcements, and hot takes score near 0.",
    "  Arguments, explanations, and reported pieces score high.",
    "- density: is there thinking per paragraph? Listicles, SEO filler, content",
    "  marketing, and anything that restates its own headline for 1,200 words",
    "  score near 0.",
    "- printFit: does it work on paper? Prose works. Things that need you to",
    "  click, run code, scrub a video, or see colour do not. Interactive pieces",
    "  and reference material you would want to search score low even when",
    "  excellent.",
    "- personalPull: does it match what this reader keeps coming back to? Their",
    "  own note at save time is the strongest single signal you have — it is",
    "  them telling you why they cared. Weigh it above your own taste.",
    "",
    "Treatments:",
    "- full: print the whole piece. For self-contained prose that fits.",
    "- extract: print an edited extract and a QR code to the rest. For very",
    "  long pieces where the opening movement stands on its own.",
    "- summary-card: a single card — your own summary, the key lines, and a QR",
    "  code. This is the right treatment for every video and podcast, for",
    "  social posts, and for anything whose text we could not retrieve. Never",
    "  print a raw transcript.",
    "",
    `Sections, in printing order: ${config.curation.sections.join(", ")}.`,
    "File each piece into exactly one of these names.",
    "",
    "If two candidates cover substantially the same ground, set duplicateOf on",
    "the weaker one to the stronger one's id.",
    "",
    "Be blunt in the pitch. The editor reading it wants the case, not manners.",
    config.curation.tasteNotes
      ? `\nThe reader has said this about their own taste:\n${config.curation.tasteNotes}`
      : "",
  ].join("\n");
}

interface Candidate {
  id: string;
  title: string;
  author?: string;
  site?: string;
  kind: string;
  savedAt: string;
  words: number;
  minutes: number;
  tags: string[];
  note?: string;
  retrieval: string;
  excerpt: string;
}

function toCandidate(item: EnrichedItem): Candidate {
  return {
    id: item.id,
    title: item.title,
    author: item.author,
    site: item.siteName,
    kind: item.kind,
    savedAt: item.savedAt.slice(0, 10),
    words: item.wordCount,
    minutes: item.readingMinutes,
    tags: item.tags,
    note: item.note,
    retrieval: item.enrichment.status,
    excerpt: truncateWords(item.text, 400),
  };
}

function client(apiKey?: string): Anthropic {
  // A bare constructor also resolves an `ant auth login` profile, so an unset
  // ANTHROPIC_API_KEY is not necessarily an error.
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

export async function scoreCandidates(
  items: EnrichedItem[],
  config: Config,
  apiKey?: string,
): Promise<Verdict[]> {
  if (items.length === 0) return [];
  const anthropic = client(apiKey);
  const system = rubricSystemPrompt(config);
  const batches = chunk(items, config.curation.batchSize);
  log.step(
    `Scoring ${items.length} candidate(s) in ${batches.length} batch(es) with ${config.curation.model}`,
  );

  // Two at a time: enough to keep the run short, gentle enough on rate limits.
  const scored = await mapLimit(batches, 2, async (batch, index) => {
    const candidates = batch.map(toCandidate);
    const response = await anthropic.messages.parse({
      model: config.curation.model,
      max_tokens: 16000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      output_config: {
        effort: config.curation.effort,
        format: zodOutputFormat(ScoreBatchSchema),
      },
      messages: [
        {
          role: "user",
          content:
            `Score every candidate below. Return one verdict per candidate, ` +
            `with the id copied exactly.\n\n` +
            JSON.stringify(candidates, null, 1),
        },
      ],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`Scoring batch ${index + 1} returned no parsable output`);
    }
    log.info(`scored batch ${index + 1}/${batches.length} (${parsed.verdicts.length} verdicts)`);
    return parsed.verdicts;
  });

  const byId = new Map(items.map((item) => [item.id, item]));
  const verdicts: Verdict[] = [];

  for (const raw of scored.flat()) {
    if (!byId.has(raw.id)) {
      log.warn(`scorer returned an unknown id, ignoring: ${raw.id}`);
      continue;
    }
    verdicts.push({
      id: raw.id,
      score: raw.score,
      pitch: raw.pitch,
      section: normaliseSection(raw.section, config),
      treatment: raw.treatment as Treatment,
      rubric: {
        durability: raw.durability,
        density: raw.density,
        printFit: raw.printFit,
        personalPull: raw.personalPull,
      },
      duplicateOf: raw.duplicateOf ?? undefined,
    });
  }

  const missing = items.filter((item) => !verdicts.some((v) => v.id === item.id));
  for (const item of missing) {
    // Never silently drop a save. An unscored item goes to the spike with a
    // reason, so a bad batch shows up in the report instead of vanishing.
    log.warn(`no verdict returned for ${item.id}`);
    verdicts.push({
      id: item.id,
      score: 0,
      pitch: "The scorer did not return a verdict for this item.",
      section: config.curation.sections.at(-1) ?? "Shorts",
      treatment: "summary-card",
      rubric: { durability: 0, density: 0, printFit: 0, personalPull: 0 },
    });
  }

  return verdicts;
}

function normaliseSection(section: string, config: Config): string {
  const sections = config.curation.sections;
  const match = sections.find(
    (s) => s.toLowerCase() === section.trim().toLowerCase(),
  );
  return match ?? sections.at(-1) ?? "Shorts";
}

/**
 * Write the furniture around a piece: headline, standfirst, pull quotes, and —
 * for summary cards only — the summary itself.
 *
 * We never rewrite someone else's article. For `full` and `extract`, the body
 * printed is their words. Claude writes original copy only where there is no
 * publishable body to begin with: a video transcript, a login-walled post.
 */
export async function composePiece(
  item: EnrichedItem,
  verdict: Verdict,
  config: Config,
  apiKey?: string,
): Promise<Pick<IssuePiece, "headline" | "standfirst" | "body" | "pullQuotes">> {
  const anthropic = client(apiKey);
  const isCard = verdict.treatment === "summary-card";

  const source = isCard
    ? truncateWords(item.transcript ?? item.text, 6000)
    : truncateWords(item.text, 3000);

  const brief = [
    `Title as saved: ${item.title}`,
    item.author ? `Author: ${item.author}` : "",
    item.siteName ? `Publication: ${item.siteName}` : "",
    `Kind: ${item.kind}`,
    `Treatment: ${verdict.treatment}`,
    `Section: ${verdict.section}`,
    item.note ? `The reader's note when saving: ${item.note}` : "",
    item.durationSeconds
      ? `Runtime: ${Math.round(item.durationSeconds / 60)} minutes`
      : "",
    "",
    isCard
      ? "Write a 250-400 word summary in your own words. Lead with the single " +
        "most useful idea, not with what the piece is 'about'. Include the " +
        "concrete specifics — numbers, names, the actual argument — so the " +
        "reader gets the value without watching. No throat-clearing, no " +
        "'in this video'. Then headline, standfirst and up to two pull quotes."
      : "Write only the furniture: headline, standfirst, and up to two pull " +
        "quotes taken VERBATIM from the source text. Return an empty string " +
        "for summary. Do not rewrite or paraphrase the body — it is printed " +
        "as the author wrote it.",
    "",
    "Source text:",
    source || "(no body text was retrievable)",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await anthropic.messages.parse({
    model: config.curation.model,
    max_tokens: 8000,
    system: [
      {
        type: "text",
        text:
          "You are the sub-editor of a one-copy monthly newspaper printed on " +
          "newsprint. House style: plain, concrete, no hype, British spelling. " +
          "Headlines are informative, not teasing.",
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      effort: config.curation.effort,
      format: zodOutputFormat(PieceCopySchema),
    },
    messages: [{ role: "user", content: brief }],
  });

  const copy = response.parsed_output;
  if (!copy) {
    // Losing the furniture must not lose the piece. Fall back to the source.
    log.warn(`no copy returned for ${item.id}, falling back to source title`);
    return {
      headline: item.title,
      standfirst: truncateWords(item.summary ?? item.text, 28),
      body: bodyFor(item, verdict, config, ""),
      pullQuotes: [],
    };
  }

  return {
    headline: copy.headline.trim() || item.title,
    standfirst: copy.standfirst.trim(),
    body: bodyFor(item, verdict, config, copy.summary),
    pullQuotes: verifyPullQuotes(copy.pullQuotes, item),
  };
}

/** The text that actually gets typeset. */
function bodyFor(
  item: EnrichedItem,
  verdict: Verdict,
  config: Config,
  summary: string,
): string {
  if (verdict.treatment === "summary-card") {
    return summary.trim() || item.summary || truncateWords(item.text, 300);
  }
  if (verdict.treatment === "extract") {
    return truncateWords(item.text, config.curation.extractWordLimit);
  }
  return item.text;
}

/**
 * A pull quote that is not in the piece is a fabricated quotation in print.
 * Drop anything we cannot find in the source.
 */
function verifyPullQuotes(quotes: string[], item: EnrichedItem): string[] {
  const haystack = normalise(item.transcript ?? item.text);
  return quotes
    .map((q) => q.trim().replace(/^["“]|["”]$/g, ""))
    .filter((q) => q.length > 20 && q.length < 220)
    .filter((q) => {
      if (haystack.includes(normalise(q))) return true;
      log.warn(`dropped an unverifiable pull quote on ${item.id}`);
      return false;
    })
    .slice(0, 2);
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function writeEditorsNote(
  pieces: IssuePiece[],
  window: MonthWindow,
  config: Config,
  apiKey?: string,
): Promise<{ editorsNote: string; strapline: string }> {
  const anthropic = client(apiKey);
  const contents = pieces
    .map(
      (p) =>
        `- [${p.verdict.section}] ${p.headline} — ${p.standfirst} (${p.verdict.pitch})`,
    )
    .join("\n");

  const response = await anthropic.messages.parse({
    model: config.curation.model,
    max_tokens: 4000,
    system: [
      {
        type: "text",
        text:
          "You write the front-page editor's note of a newspaper with one " +
          "reader. Address them directly. Say what this month's saves add up " +
          "to and what to read first. Plain, warm, unsentimental. No " +
          "'welcome to this issue'. British spelling.",
        cache_control: { type: "ephemeral" },
      },
    ],
    output_config: {
      effort: config.curation.effort,
      format: zodOutputFormat(EditorsNoteSchema),
    },
    messages: [
      {
        role: "user",
        content: `Issue: ${window.monthLabel}.\n\nContents:\n${contents}`,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (parsed) return parsed;

  return {
    editorsNote: `${pieces.length} pieces from ${window.monthLabel}, in the order they are worth your time.`,
    strapline: `Everything worth keeping from ${window.monthLabel}`,
  };
}

/** Pull quotes for a piece when we skip the model entirely (`--no-ai`). */
export function fallbackCopy(
  item: EnrichedItem,
  verdict: Verdict,
  config: Config,
): Pick<IssuePiece, "headline" | "standfirst" | "body" | "pullQuotes"> {
  const first = sentences(item.text)[0] ?? item.summary ?? "";
  return {
    headline: item.title,
    standfirst: truncateWords(first, 28),
    body:
      verdict.treatment === "extract"
        ? truncateWords(item.text, config.curation.extractWordLimit)
        : verdict.treatment === "summary-card"
          ? item.summary || truncateWords(item.text, 300)
          : item.text,
    pullQuotes: [],
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
