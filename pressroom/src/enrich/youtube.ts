import { fetchWithRetry, fetchJson } from "../http.js";
import { log } from "../log.js";
import type { SavedItem } from "../types.js";
import type { Extraction } from "./article.js";
import { meta } from "./article.js";

export interface VideoExtraction extends Extraction {
  transcript?: string;
  durationSeconds?: number;
}

interface OEmbed {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}

export function youtubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (!/(^|\.)youtube\.com$/.test(host)) return null;
    const v = parsed.searchParams.get("v");
    if (v) return v;
    const path = /^\/(?:shorts|embed|live|v)\/([\w-]{6,})/.exec(parsed.pathname);
    return path?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Video enrichment: title and author from oEmbed (stable, public), transcript
 * from the watch page's caption tracks (unofficial, breaks periodically).
 * A missing transcript is normal, not an error — the piece just becomes a
 * thinner card in the paper.
 */
export async function extractVideo(item: SavedItem): Promise<VideoExtraction> {
  const id = youtubeId(item.url);
  if (!id) {
    return { text: item.summary ?? "", method: "non-youtube-video" };
  }

  const oembed = await fetchOEmbed(item.url);
  const page = await fetchWatchPage(id);

  const transcript = page ? await fetchTranscript(page) : undefined;
  const description = page ? meta(page, "og:description") : undefined;
  const durationSeconds = page ? parseDuration(page) : undefined;

  const text = transcript ?? description ?? item.summary ?? "";
  return {
    text,
    transcript,
    durationSeconds,
    title: oembed?.title ?? item.title,
    author: oembed?.author_name ?? item.author,
    siteName: "YouTube",
    method: transcript ? "youtube-transcript" : description ? "youtube-description" : "youtube-metadata",
    error: transcript ? undefined : "no transcript available",
  };
}

async function fetchOEmbed(url: string): Promise<OEmbed | null> {
  try {
    return await fetchJson<OEmbed>(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { label: "youtube-oembed", retries: 2, timeoutMs: 15_000 },
    );
  } catch (err) {
    log.debug("youtube oembed failed", err);
    return null;
  }
}

async function fetchWatchPage(id: string): Promise<string | null> {
  try {
    const res = await fetchWithRetry(`https://www.youtube.com/watch?v=${id}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "accept-language": "en-GB,en;q=0.9",
      },
      label: "youtube",
      retries: 2,
      timeoutMs: 25_000,
    });
    return await res.text();
  } catch (err) {
    log.debug("youtube watch page failed", err);
    return null;
  }
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

/** Caption tracks are embedded in the watch page's player response. */
async function fetchTranscript(page: string): Promise<string | undefined> {
  const match = /"captionTracks":(\[.*?\])/s.exec(page);
  if (!match?.[1]) return undefined;

  let tracks: CaptionTrack[];
  try {
    tracks = JSON.parse(match[1].replace(/\\u0026/g, "&")) as CaptionTrack[];
  } catch {
    return undefined;
  }

  // Prefer a human-written English track, then any English, then anything.
  const track =
    tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode?.startsWith("en")) ??
    tracks[0];
  if (!track?.baseUrl) return undefined;

  try {
    const res = await fetchWithRetry(`${track.baseUrl}&fmt=json3`, {
      label: "youtube-captions",
      retries: 2,
      timeoutMs: 20_000,
    });
    const body = (await res.json()) as {
      events?: { segs?: { utf8?: string }[] }[];
    };
    const text = (body.events ?? [])
      .flatMap((event) => event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 200 ? text : undefined;
  } catch (err) {
    log.debug("youtube transcript failed", err);
    return undefined;
  }
}

function parseDuration(page: string): number | undefined {
  const match = /"lengthSeconds":"(\d+)"/.exec(page);
  return match?.[1] ? Number(match[1]) : undefined;
}
