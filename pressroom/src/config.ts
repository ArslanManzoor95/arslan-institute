import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Layout numbers default to Newspaper Club's digital tabloid spec:
 * 289 x 380mm, 15mm margins on top/bottom/outside, 4-64 pages in
 * multiples of 4, greyscale or CMYK. Change these together with the
 * print vendor, not on their own.
 */
const LayoutSchema = z.object({
  /**
   * Four columns, not two. A tabloid page is 289mm wide; two columns give a
   * 126mm measure, about 110 characters a line — roughly double what anyone
   * reads comfortably. Real tabloids run four to six. Change it if you like,
   * but read a printed proof before you commit to two.
   */
  pageWidthMm: z.number().positive().default(289),
  pageHeightMm: z.number().positive().default(380),
  marginMm: z.number().nonnegative().default(15),
  columns: z.number().int().min(1).max(6).default(4),
  bodyPt: z.number().positive().default(9.8),
  leadingPt: z.number().positive().default(13.2),
  /**
   * Used only for the first-pass page estimate. The renderer measures the
   * real page count and re-fits, so a rough number here is fine.
   */
  wordsPerPage: z.number().int().positive().default(1800),
  minPages: z.number().int().min(4).default(4),
  maxPages: z.number().int().max(64).default(64),
  /** Print vendors that impose signatures need pages in multiples of this. */
  pageMultiple: z.number().int().positive().default(4),
});

const CurationSchema = z.object({
  /** The hard cap. Past ~15 pieces the paper stops being read. */
  maxPieces: z.number().int().positive().default(14),
  /** Below this we say so rather than padding the issue with filler. */
  minPieces: z.number().int().positive().default(5),
  /** Page budget for editorial content, before front/back matter. */
  pageBudget: z.number().int().positive().default(24),
  /** Stop one kind of thing from eating the whole issue. */
  maxPerKind: z.record(z.string(), z.number().int().nonnegative()).prefault({
    video: 3,
    post: 3,
    thread: 2,
  }),
  model: z.string().default("claude-opus-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /** How many candidates go into one scoring call. */
  batchSize: z.number().int().positive().default(20),
  /**
   * Free text appended to the scoring rubric. This is where you say what
   * you actually want to read — it is the highest-leverage knob here.
   */
  tasteNotes: z.string().default(""),
  /** Anything tagged with one of these is printed regardless of score. */
  alwaysPrintTags: z.array(z.string()).default(["print", "must-read"]),
  /** Anything tagged with one of these never reaches the scorer. */
  neverPrintTags: z.array(z.string()).default(["skip", "reference"]),
  /**
   * The paper's sections, in printing order. Claude files each piece into
   * one of these; anything it invents is filed under the last entry.
   */
  sections: z
    .array(z.string())
    .default([
      "The Long Read",
      "Ideas",
      "Technology",
      "Business",
      "Culture",
      "Watch & Listen",
      "Shorts",
    ]),
  /** Pieces longer than this are printed as an edited extract plus a QR code. */
  extractWordLimit: z.number().int().positive().default(3200),
});

const SourcesSchema = z.object({
  readwise: z
    .object({
      enabled: z.boolean().default(false),
      /** Reader locations to pull from. `feed` is usually noise. */
      locations: z
        .array(z.enum(["new", "later", "shortlist", "archive", "feed"]))
        .default(["new", "later", "shortlist", "archive"]),
      /** Ask Reader for the stored HTML so we can skip re-fetching. */
      withHtmlContent: z.boolean().default(true),
    })
    .prefault({}),
  inbox: z
    .object({
      enabled: z.boolean().default(false),
      /** Base URL of your deployed capture Worker. */
      endpoint: z.string().url().optional(),
    })
    .prefault({}),
  /**
   * Forward a link to an address and it is captured. Nothing to deploy and
   * nothing to install, at the cost of a mailbox password in your secrets.
   * Read-only: the pipeline never modifies the mailbox.
   */
  email: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default("imap.gmail.com"),
      port: z.number().int().positive().default(993),
      /** The mailbox to sign in as. */
      user: z.string().optional(),
      /** IMAP folder to read. A dedicated folder lets you drop toFilter. */
      mailbox: z.string().default("INBOX"),
      /**
       * Only mail addressed to something containing this fragment is
       * captured — e.g. "+paper" for you+paper@gmail.com. Without it every
       * newsletter in the mailbox becomes a candidate.
       */
      toFilter: z.string().default("+paper"),
      maxUrlsPerMessage: z.number().int().positive().default(5),
    })
    .prefault({}),
});

const PrintSchema = z.object({
  vendor: z.enum(["newspaperclub", "peecho", "none"]).default("newspaperclub"),
  copies: z.number().int().positive().default(1),
  /** Newsprint reproduces greyscale well and colour unpredictably. */
  colour: z.enum(["greyscale", "cmyk"]).default("greyscale"),
  /** Where the print-ready PDF gets written. */
  outDir: z.string().default("out"),
  peecho: z
    .object({
      /** Peecho's sandbox host, swapped for the live one when you go live. */
      baseUrl: z.string().url().default("https://test.www.peecho.com"),
      offeringId: z.string().optional(),
      /** Where the finished paper is posted. */
      shipping: z
        .object({
          name: z.string().optional(),
          address: z.string().optional(),
          city: z.string().optional(),
          postcode: z.string().optional(),
          countryCode: z.string().length(2).default("GB"),
        })
        .prefault({}),
    })
    .prefault({}),
});

const DeliverySchema = z.object({
  /** Where the proof lands for approval. */
  proofEmail: z.string().email().optional(),
  fromEmail: z.string().email().optional(),
});

export const ConfigSchema = z.object({
  masthead: z.string().default("The Monthly"),
  /** Printed under the masthead. */
  motto: z.string().default(""),
  /** Issue numbering starts here and increments once per month. */
  firstIssueNumber: z.number().int().positive().default(1),
  /**
   * The month `firstIssueNumber` refers to, as YYYY-MM. Numbering is derived
   * from the calendar rather than a counter file, so a fresh checkout in CI
   * produces the same issue number as your laptop.
   */
  firstIssueMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  timezone: z.string().default("Europe/London"),
  sources: SourcesSchema.prefault({}),
  curation: CurationSchema.prefault({}),
  layout: LayoutSchema.prefault({}),
  print: PrintSchema.prefault({}),
  delivery: DeliverySchema.prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LayoutConfig = z.infer<typeof LayoutSchema>;
export type CurationConfig = z.infer<typeof CurationSchema>;
export type PrintConfig = z.infer<typeof PrintSchema>;

const DEFAULT_CONFIG_FILES = ["pressroom.config.json", "pressroom.config.jsonc"];

/** Strip `//` and block comments so a .jsonc config is readable. */
function stripJsonComments(input: string): string {
  return input
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function loadConfig(explicitPath?: string): Config {
  const candidates = explicitPath
    ? [explicitPath]
    : DEFAULT_CONFIG_FILES.map((f) => resolve(process.cwd(), f));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    return ConfigSchema.parse(parsed);
  }

  if (explicitPath) {
    throw new Error(`Config file not found: ${explicitPath}`);
  }
  // No config file is a valid state: every field has a default.
  return ConfigSchema.parse({});
}

/** Secrets live in the environment, never in the config file. */
export interface Secrets {
  readwiseToken?: string;
  inboxToken?: string;
  /** IMAP password for the capture mailbox. On Gmail, an app password. */
  emailPassword?: string;
  anthropicApiKey?: string;
  resendApiKey?: string;
  peechoApiKey?: string;
  peechoMerchantId?: string;
  /** Public HTTPS base the print vendor can fetch the PDF from. */
  publicAssetBase?: string;
}

export function loadSecrets(): Secrets {
  return {
    readwiseToken: process.env.READWISE_TOKEN,
    inboxToken: process.env.INBOX_TOKEN,
    emailPassword: process.env.EMAIL_PASSWORD,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    peechoApiKey: process.env.PEECHO_API_KEY,
    peechoMerchantId: process.env.PEECHO_MERCHANT_ID,
    publicAssetBase: process.env.PUBLIC_ASSET_BASE,
  };
}

/** Printable width of one text column, in mm. Used by the estimator. */
export function columnWidthMm(layout: LayoutConfig): number {
  const gutterMm = 6;
  const textWidth = layout.pageWidthMm - layout.marginMm * 2;
  return (textWidth - gutterMm * (layout.columns - 1)) / layout.columns;
}
