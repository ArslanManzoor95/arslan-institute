import { log } from "./log.js";

export interface FetchOptions extends RequestInit {
  /** Total attempts, including the first. */
  retries?: number;
  timeoutMs?: number;
  /** Label used in log lines. */
  label?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fetch with timeouts, exponential backoff, and Retry-After support.
 * Throws on a non-retryable error status so callers can decide per-item
 * whether a failure is fatal or just a thin entry in the paper.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const {
    retries = 4,
    timeoutMs = 30_000,
    label = new URL(url).host,
    ...init
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return res;

      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `${label} responded ${res.status}: ${body.slice(0, 300)}`,
        );
      }

      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffMs(attempt);
      log.warn(`${label} ${res.status}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
    } catch (err) {
      lastError = err;
      const aborted = err instanceof Error && err.name === "AbortError";
      // A thrown non-retryable status from the block above must not be retried.
      if (!aborted && err instanceof Error && /responded \d{3}/.test(err.message)) {
        throw err;
      }
      if (attempt === retries) break;
      const waitMs = backoffMs(attempt);
      log.warn(`${label} ${aborted ? "timed out" : "failed"}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `${label} failed after ${retries} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  // Jitter so parallel item fetches do not retry in lockstep.
  return base + Math.floor(Math.random() * 400);
}

/** Fetch JSON, with the same retry behaviour. */
export async function fetchJson<T>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const res = await fetchWithRetry(url, options);
  return (await res.json()) as T;
}

/** Run tasks with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item, index);
    }
  });

  await Promise.all(workers);
  return results;
}
