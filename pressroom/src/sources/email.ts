import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { log } from "../log.js";
import type { SavedItem } from "../types.js";
import type { Config, Secrets } from "../config.js";
import type { MonthWindow } from "./index.js";
import { refineKind } from "./readwise.js";

/**
 * Email as the capture inbox. Nothing to deploy and nothing to install:
 * share any link to Mail, send it to your own address, and it is captured.
 *
 * Read-only IMAP. The mailbox is never modified — no flags, no moves, no
 * deletes — so a run can be repeated safely and a mistake here cannot cost
 * you mail.
 */
export async function fetchEmailItems(
  config: Config,
  window: MonthWindow,
  secrets: Secrets,
): Promise<SavedItem[]> {
  const settings = config.sources.email;
  if (!settings.user) {
    throw new Error("sources.email.enabled is true but sources.email.user is not set");
  }
  if (!secrets.emailPassword) {
    throw new Error(
      "sources.email.enabled is true but EMAIL_PASSWORD is unset. For Gmail " +
        "this is an app password (myaccount.google.com/apppasswords), not " +
        "your account password.",
    );
  }

  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: true,
    auth: { user: settings.user, pass: secrets.emailPassword },
    logger: false,
  });

  const items: SavedItem[] = [];
  await client.connect();

  try {
    const lock = await client.getMailboxLock(settings.mailbox);
    try {
      const since = new Date(window.start);
      const until = new Date(window.end).getTime();

      for await (const message of client.fetch(
        { since },
        { source: true, uid: true },
      )) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);

        const sentAt = parsed.date ?? since;
        if (sentAt.getTime() >= until) continue;
        const recipients = `${addressText(parsed.to)} ${addressText(parsed.cc)}`;
        if (!addressedToInbox(recipients, settings.toFilter)) continue;

        const body = parsed.text ?? stripHtml(parsed.html || "");
        const urls = extractUrls(`${parsed.subject ?? ""}\n${body}`);
        if (urls.length === 0) continue;

        for (const [index, url] of urls.slice(0, settings.maxUrlsPerMessage).entries()) {
          items.push(
            toSavedItem({
              url,
              uid: `${message.uid}-${index}`,
              subject: parsed.subject ?? "",
              body,
              sentAt,
              // Only the first link inherits the subject as its title; the
              // rest of a multi-link mail are unnamed until enrichment.
              useSubjectAsTitle: index === 0,
            }),
          );
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }

  log.info(`email: ${items.length} link(s) forwarded during ${window.month}`);
  return items;
}

interface MessageFacts {
  url: string;
  uid: string;
  subject: string;
  body: string;
  sentAt: Date;
  useSubjectAsTitle: boolean;
}

function toSavedItem(facts: MessageFacts): SavedItem {
  const { tags, text: subject } = extractTags(facts.subject);
  const note = noteFrom(facts.body);

  return {
    id: `email:${facts.uid}`,
    source: "email",
    sourceId: facts.uid,
    url: facts.url,
    title: facts.useSubjectAsTitle && isMeaningful(subject) ? subject : facts.url,
    savedAt: facts.sentAt.toISOString(),
    kind: refineKind("article", facts.url),
    tags,
    note,
  };
}

/**
 * Only take mail addressed to the capture address. Without this the whole
 * inbox — newsletters, receipts, everything with a link in it — becomes the
 * paper. An empty filter means "everything in this mailbox", which is only
 * sensible when the mailbox is a dedicated folder.
 */
export function addressedToInbox(recipients: string, filter: string): boolean {
  if (!filter) return true;
  return recipients.toLowerCase().includes(filter.toLowerCase());
}

/** mailparser returns one object or an array depending on the header. */
function addressText(field: AddressObject | AddressObject[] | undefined): string {
  if (!field) return "";
  return Array.isArray(field)
    ? field.map((entry) => entry.text).join(" ")
    : field.text;
}

/** Hashtags anywhere in the subject become tags: "#print Some headline". */
export function extractTags(subject: string): { tags: string[]; text: string } {
  const tags: string[] = [];
  const text = subject
    .replace(/(^|\s)#([\w-]+)/g, (_match, _space, tag: string) => {
      tags.push(tag.toLowerCase());
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { tags, text };
}

/** Mail clients and forwards add furniture that is not a note from you. */
const NOTE_NOISE =
  /^(sent from|get outlook|begin forwarded message|-{2,}\s*forwarded|on .+ wrote:|>)/i;

function noteFrom(body: string): string | undefined {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !NOTE_NOISE.test(line))
    .filter((line) => !/^https?:\/\//.test(line));

  const note = lines.join(" ").replace(/https?:\/\/\S+/g, "").trim();
  // A couple of words is furniture; a sentence is a reason for saving.
  return note.length > 12 && note.length < 600 ? note : undefined;
}

function isMeaningful(subject: string): boolean {
  const trimmed = subject.replace(/^(fwd?|re):\s*/i, "").trim();
  return trimmed.length > 3 && !/^https?:\/\//.test(trimmed);
}

/** Hosts that only ever appear as mail furniture, never as something to read. */
const URL_NOISE =
  /(^|\.)(googleusercontent\.com|gstatic\.com|w3\.org|schemas\.microsoft\.com|list-manage\.com|mailchimp\.com|sendgrid\.net|beacon|clicktracking)/i;

const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?)($|\?)/i;

/**
 * Pull the real links out of a message. Mail is full of URLs that are not
 * things to read: unsubscribe footers, tracking pixels, image assets.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`)\]}]+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of matches) {
    // Trailing punctuation belongs to the sentence, not the URL.
    const trimmed = raw.replace(/[.,;:!?)\]}'"]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (URL_NOISE.test(parsed.hostname)) continue;
    if (ASSET_SUFFIX.test(parsed.pathname)) continue;
    if (/unsubscribe|optout|opt-out|email-preferences/i.test(parsed.href)) continue;
    if (parsed.hostname === "mail.google.com") continue;

    const key = parsed.href.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(trimmed);
  }

  return urls;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi, " $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}
