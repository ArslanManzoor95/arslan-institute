/**
 * Pressroom capture inbox.
 *
 * One endpoint your phone can hit from the share sheet, one endpoint the
 * monthly pipeline reads. Everything else is deliberately absent.
 */

interface Env {
  DB: D1Database;
  INBOX_TOKEN: string;
  /** Optional: mirror every save into Readwise Reader as well. */
  READWISE_TOKEN?: string;
}

interface SaveBody {
  url?: string;
  title?: string;
  note?: string;
  tags?: string | string[];
  kind?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/" && request.method === "GET") return addForm();

    if (!authorised(request, env)) {
      return json({ error: "unauthorised" }, 401);
    }

    try {
      if (url.pathname === "/save" && request.method === "POST") {
        return await handleSave(request, env, ctx);
      }
      if (url.pathname === "/items" && request.method === "GET") {
        return await handleList(url, env);
      }
      const deleteMatch = /^\/items\/([\w-]+)$/.exec(url.pathname);
      if (deleteMatch && request.method === "DELETE") {
        return await handleDelete(deleteMatch[1]!, env);
      }
    } catch (err) {
      return json({ error: (err as Error).message }, 500);
    }

    return json({ error: "not found" }, 404);
  },
};

/** Constant-time bearer comparison. */
function authorised(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "");
  const expected = env.INBOX_TOKEN ?? "";
  if (presented.length !== expected.length || expected.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function handleSave(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await readBody(request);
  const rawUrl = (body.url ?? "").trim();
  if (!rawUrl) return json({ error: "url is required" }, 400);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return json({ error: `not a url: ${rawUrl}` }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ error: "only http(s) urls are accepted" }, 400);
  }

  const canonical = canonicalUrl(parsed);
  const existing = await env.DB.prepare(
    "SELECT id FROM items WHERE canonical_url = ?",
  )
    .bind(canonical)
    .first<{ id: string }>();

  if (existing) {
    return json({ ok: true, id: existing.id, duplicate: true });
  }

  const title = body.title?.trim() || (await lookupTitle(parsed)) || rawUrl;
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const tags = Array.isArray(body.tags) ? body.tags.join(",") : (body.tags ?? "");

  await env.DB.prepare(
    `INSERT INTO items (id, url, canonical_url, title, note, tags, kind, site_name, saved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      rawUrl,
      canonical,
      title,
      body.note?.trim() ?? null,
      tags || null,
      body.kind ?? null,
      parsed.hostname.replace(/^www\./, ""),
      now,
      now,
    )
    .run();

  if (env.READWISE_TOKEN) {
    ctx.waitUntil(mirrorToReadwise(env.READWISE_TOKEN, rawUrl, body));
  }

  return json({ ok: true, id, title }, 201);
}

async function handleList(url: URL, env: Env): Promise<Response> {
  const since = url.searchParams.get("since") ?? "1970-01-01T00:00:00.000Z";
  const until = url.searchParams.get("until") ?? "9999-01-01T00:00:00.000Z";

  const result = await env.DB.prepare(
    `SELECT id, url, title, note, tags, kind, author, site_name, saved_at
     FROM items
     WHERE saved_at >= ? AND saved_at < ?
     ORDER BY saved_at ASC`,
  )
    .bind(since, until)
    .all();

  return json({ items: result.results ?? [] });
}

async function handleDelete(id: string, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function readBody(request: Request): Promise<SaveBody> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as SaveBody;
  }
  // The iOS share sheet posts form-encoded bodies unless told otherwise.
  const form = await request.formData();
  return {
    url: str(form.get("url")),
    title: str(form.get("title")),
    note: str(form.get("note")),
    tags: str(form.get("tags")),
    kind: str(form.get("kind")),
  };
}

function str(value: File | string | null): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Best effort, short leash: a slow page must not stall the share sheet. */
async function lookupTitle(url: URL): Promise<string | null> {
  try {
    const res = await fetch(url.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; pressroom/1.0)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (og?.[1]) return decodeEntities(og[1]);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    return title?.[1] ? decodeEntities(title[1].trim()) : null;
  } catch {
    return null;
  }
}

async function mirrorToReadwise(token: string, url: string, body: SaveBody) {
  try {
    await fetch("https://readwise.io/api/v3/save/", {
      method: "POST",
      headers: { Authorization: `Token ${token}`, ...JSON_HEADERS },
      body: JSON.stringify({
        url,
        tags: Array.isArray(body.tags)
          ? body.tags
          : (body.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
        notes: body.note,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // The inbox is the source of truth; a failed mirror is not worth an error.
  }
}

function canonicalUrl(parsed: URL): string {
  const url = new URL(parsed.toString());
  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|si$|s$|igshid)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, "access-control-allow-origin": "*" },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
    },
  });
}

/** A one-field page for saving from a desktop browser. */
function addForm(): Response {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add to the paper</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100dvh; }
  form { width: min(28rem, 90vw); display: grid; gap: .75rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .5rem; letter-spacing: .02em; text-transform: uppercase; }
  input, textarea, button { font: inherit; padding: .6rem .7rem; border: 1px solid currentColor; border-radius: .3rem; background: transparent; color: inherit; }
  button { cursor: pointer; font-weight: 600; }
  #status { min-height: 1.5em; font-size: .9rem; }
</style>
<form id="f">
  <h1>Add to the paper</h1>
  <input id="token" type="password" placeholder="inbox token" autocomplete="off">
  <input id="url" type="url" placeholder="https://…" required>
  <input id="tags" placeholder="tags, comma separated">
  <textarea id="note" rows="3" placeholder="why you saved it (this weighs on curation)"></textarea>
  <button>Save</button>
  <div id="status"></div>
</form>
<script>
  const $ = (id) => document.getElementById(id);
  $('token').value = localStorage.getItem('pressroom-token') || '';
  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    localStorage.setItem('pressroom-token', $('token').value);
    $('status').textContent = 'Saving…';
    const res = await fetch('/save', {
      method: 'POST',
      headers: { 'authorization': 'Bearer ' + $('token').value, 'content-type': 'application/json' },
      body: JSON.stringify({ url: $('url').value, tags: $('tags').value, note: $('note').value }),
    });
    const body = await res.json().catch(() => ({}));
    $('status').textContent = res.ok
      ? (body.duplicate ? 'Already saved.' : 'Saved: ' + (body.title || ''))
      : 'Failed: ' + (body.error || res.status);
    if (res.ok) { $('url').value = ''; $('note').value = ''; }
  });
</script>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
