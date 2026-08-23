#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { log } from "./log.js";
import { loadConfig, loadSecrets, type Config, type Secrets } from "./config.js";
import { monthWindow, previousMonth } from "./sources/index.js";
import {
  loadDraft,
  loadIssue,
  loadSaves,
  runCurate,
  runFetch,
  savesPath,
  summariseIssue,
} from "./pipeline.js";
import { buildIssue, readPdf } from "./render/build.js";
import { formatChecks, preflight, preflightPassed } from "./preflight.js";
import { placeOrder } from "./print/index.js";
import { sendProofEmail } from "./notify/email.js";
import { hasGhostscript } from "./render/pdf.js";

const USAGE = `pressroom — one month of saved links, one printed paper

  pressroom run      [--month YYYY-MM] [--no-ai] [--no-email]
  pressroom fetch    [--month YYYY-MM]
  pressroom curate   [--month YYYY-MM] [--no-ai]
  pressroom build    [--month YYYY-MM]
  pressroom order    [--month YYYY-MM] [--dry-run]
  pressroom doctor

Options
  --month YYYY-MM   Which month to print. Defaults to last month.
  --config PATH     Config file. Defaults to ./pressroom.config.json.
  --out DIR         Where files are written. Defaults to print.outDir.
  --no-ai           Skip every model call; rank with a plain heuristic.
  --no-email        Do not send the proof email.
  --dry-run         For order: print the request instead of sending it.

Steps write their output to --out, so you can stop after any of them,
look at the file, and pick up where you left off.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      month: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      "no-ai": { type: "boolean", default: false },
      "no-email": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return;
  }

  const config = loadConfig(values.config);
  const secrets = loadSecrets();
  const outDir = values.out ?? config.print.outDir;
  const month = values.month ?? previousMonth(config.timezone);
  const window = monthWindow(month, config.timezone);
  const noAi = values["no-ai"] === true;

  switch (command) {
    case "doctor":
      await doctor(config, secrets);
      return;

    case "fetch": {
      const items = await runFetch(config, secrets, window, outDir);
      log.info(`wrote ${items.length} item(s) to ${savesPath(outDir, month)}`);
      return;
    }

    case "curate": {
      const items = await ensureSaves(config, secrets, window, outDir);
      const issue = await runCurate(items, config, secrets, window, outDir, { noAi });
      process.stdout.write(summariseIssue(issue) + "\n");
      return;
    }

    case "build": {
      const draft = await loadDraft(outDir, month);
      const result = await buildIssue(draft, config, outDir);
      const checks = await preflight(await readPdf(result.printPath), config, {
        greyscaleApplied: result.greyscaleApplied,
      });
      log.step("Preflight");
      process.stdout.write(formatChecks(checks) + "\n");
      if (!preflightPassed(checks)) process.exitCode = 1;
      return;
    }

    case "order": {
      const issue = await loadIssue(outDir, month);
      const printPath = `${outDir}/issue-${month}.print.pdf`;
      if (!existsSync(printPath)) {
        throw new Error(`No built issue at ${printPath}. Run \`pressroom build\` first.`);
      }
      const checks = await preflight(await readPdf(printPath), config, {
        greyscaleApplied: issue.greyscaleApplied ?? false,
      });
      if (!preflightPassed(checks)) {
        process.stdout.write(formatChecks(checks) + "\n");
        throw new Error("Preflight failed; refusing to order.");
      }
      const result = await placeOrder(issue, config, secrets, printPath, {
        dryRun: values["dry-run"] === true,
      });
      log.step(result.placed ? "Ordered" : "Ready to order");
      if (result.instructions) process.stdout.write(result.instructions + "\n");
      return;
    }

    case "run": {
      const items = await runFetch(config, secrets, window, outDir);
      if (items.length === 0) {
        log.warn("nothing to print this month; stopping before the build");
        return;
      }
      const draft = await runCurate(items, config, secrets, window, outDir, { noAi });
      if (draft.pieces.length === 0) {
        log.warn("nothing cleared the bar; stopping before the build");
        return;
      }
      const result = await buildIssue(draft, config, outDir);
      const checks = await preflight(await readPdf(result.printPath), config, {
        greyscaleApplied: result.greyscaleApplied,
      });

      log.step("Preflight");
      process.stdout.write(formatChecks(checks) + "\n");
      process.stdout.write("\n" + summariseIssue(result.issue) + "\n");

      if (!values["no-email"]) {
        await sendProofEmail(config, secrets, {
          issue: result.issue,
          proofPath: result.proofPath,
          checks,
          approvalUrl: process.env.APPROVAL_URL,
        });
      }

      log.step("Done");
      log.info(`print-ready: ${result.printPath} (${result.pageCount} pages)`);
      log.info(`approve, then: pressroom order --month ${month}`);
      if (!preflightPassed(checks)) process.exitCode = 1;
      return;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

/** Reuse a previous fetch if one is sitting in the out directory. */
async function ensureSaves(
  config: Config,
  secrets: Secrets,
  window: ReturnType<typeof monthWindow>,
  outDir: string,
) {
  if (existsSync(savesPath(outDir, window.month))) {
    log.info(`reusing ${savesPath(outDir, window.month)}`);
    return loadSaves(outDir, window.month);
  }
  return runFetch(config, secrets, window, outDir);
}

async function doctor(config: Config, secrets: Secrets) {
  const rows: [string, boolean, string][] = [];

  const readwise = config.sources.readwise.enabled;
  const inbox = config.sources.inbox.enabled;
  rows.push([
    "a source is enabled",
    readwise || inbox,
    [readwise ? "readwise" : null, inbox ? "inbox" : null].filter(Boolean).join(" + ") ||
      "none — edit sources in pressroom.config.json",
  ]);
  if (readwise) {
    rows.push(["READWISE_TOKEN", Boolean(secrets.readwiseToken), "readwise.io/access_token"]);
  }
  if (inbox) {
    rows.push(["INBOX_TOKEN", Boolean(secrets.inboxToken), "the Worker's shared secret"]);
    rows.push([
      "inbox endpoint",
      Boolean(config.sources.inbox.endpoint),
      config.sources.inbox.endpoint ?? "sources.inbox.endpoint is unset",
    ]);
  }

  rows.push([
    "ANTHROPIC_API_KEY",
    Boolean(secrets.anthropicApiKey),
    secrets.anthropicApiKey
      ? config.curation.model
      : "unset — an `ant auth login` profile also works, or use --no-ai",
  ]);

  let chromium = false;
  try {
    const { chromium: browserType } = await import("playwright");
    const path = browserType.executablePath();
    chromium = existsSync(path);
    rows.push(["chromium", chromium, chromium ? path : `${path} (run: npx playwright install chromium)`]);
  } catch (err) {
    rows.push(["chromium", false, err instanceof Error ? err.message : String(err)]);
  }

  const gs = await hasGhostscript();
  rows.push([
    "ghostscript",
    gs,
    gs ? "greyscale conversion available" : "optional — without it the PDF stays RGB",
  ]);

  const emailMissing = [
    secrets.resendApiKey ? null : "RESEND_API_KEY",
    config.delivery.proofEmail ? null : "delivery.proofEmail",
    config.delivery.fromEmail ? null : "delivery.fromEmail",
  ].filter(Boolean);
  rows.push([
    "proof email",
    emailMissing.length === 0,
    emailMissing.length === 0
      ? `to ${config.delivery.proofEmail}`
      : `optional — missing ${emailMissing.join(", ")}`,
  ]);

  rows.push([
    "print vendor",
    config.print.vendor !== "none",
    `${config.print.vendor}, ${config.print.copies} cop${config.print.copies === 1 ? "y" : "ies"}, ${config.print.colour}`,
  ]);

  log.step("Doctor");
  for (const [name, ok, detail] of rows) {
    process.stdout.write(`  ${ok ? "ok  " : "  ! "} ${name.padEnd(20)} ${detail}\n`);
  }

  const blocking = rows.filter(([name, ok]) => !ok && !OPTIONAL.has(name));
  if (blocking.length > 0) process.exitCode = 1;
}

/** Things that are nice to have but will not stop a run. */
const OPTIONAL = new Set(["ghostscript", "proof email", "ANTHROPIC_API_KEY"]);

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env.PRESSROOM_LOG_LEVEL === "debug" && err instanceof Error) {
    process.stderr.write((err.stack ?? "") + "\n");
  }
  process.exitCode = 1;
});
