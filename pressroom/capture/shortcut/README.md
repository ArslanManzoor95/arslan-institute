# Saving from your phone

The whole system is worth nothing if saving a link takes more than two taps.
Set up one of these once and never think about it again.

## Option A — Readwise Reader (recommended)

Reader already has the share sheet extension, native X/Twitter sync, YouTube
with transcripts, and an email address for newsletters. If you use it, you get
capture for free and `pressroom` just reads its API.

1. Install Reader on your phone and sign in.
2. Share sheet → **Reader**. That is the whole flow.
3. Turn on the integrations you want in Reader's settings: X/Twitter sync,
   the newsletter address, RSS.
4. Get your API token from <https://readwise.io/access_token> and put it in
   the environment as `READWISE_TOKEN`.
5. In `pressroom.config.json`, set `sources.readwise.enabled` to `true`.

**Tag as you save.** Reader lets you add tags from the share sheet. Two tags
carry weight in curation:

- `print` — always printed, whatever the scorer thinks.
- `skip` — never printed, never scored.

Anything else you type is treated as a topic hint.

## Option B — the self-hosted inbox (free, yours)

`capture/worker` is a Cloudflare Worker with a D1 table behind it. Two useful
endpoints: `POST /save` for your phone, `GET /items` for the pipeline. It will
also mirror each save into Reader if you give it a Readwise token, so you can
run both.

### Deploy it

```bash
npm install -g wrangler          # or use npx
wrangler login

wrangler d1 create pressroom-inbox
# Copy the printed database_id into capture/worker/wrangler.toml

wrangler d1 execute pressroom-inbox --remote \
  --file capture/worker/schema.sql

# A shared secret your phone sends on every save.
openssl rand -hex 32             # keep this, you need it twice
wrangler secret put INBOX_TOKEN --config capture/worker/wrangler.toml

# Optional: mirror saves into Readwise Reader as well.
wrangler secret put READWISE_TOKEN --config capture/worker/wrangler.toml

wrangler deploy --config capture/worker/wrangler.toml
```

Then set `sources.inbox.enabled` and `sources.inbox.endpoint` in
`pressroom.config.json`, and export the same token as `INBOX_TOKEN` wherever
the pipeline runs.

### The iOS Shortcut (share sheet, two taps)

Shortcuts app → **+** → rename it "Add to the paper" → shortcut settings
(ⓘ) → **Show in Share Sheet**, accept types **URLs** and **Safari web pages**.

Then add these actions in order:

| # | Action | Settings |
|---|--------|----------|
| 1 | **Receive** *URLs* from *Share Sheet* | Also accept: Safari web pages, Text |
| 2 | **Text** | `https://pressroom-inbox.<your-subdomain>.workers.dev/save` |
| 3 | **Get Contents of URL** | URL: the Text from step 2 |
| | ↳ Method | `POST` |
| | ↳ Headers | `Authorization` → `Bearer <your INBOX_TOKEN>` |
| | ↳ Request Body | `JSON` |
| | ↳ JSON field | `url` (Text) → **Shortcut Input** |
| 4 | **Show Notification** *(optional)* | `Saved.` |

Save. Now: share sheet → "Add to the paper" → done.

**Add the note prompt only if you will actually use it.** A one-line reason
for saving is the single strongest curation signal — Claude weighs it above
everything else. If you want it, insert an **Ask for Input** (Text, "Why?",
allow empty) before step 3 and add a `note` field to the JSON body. If you
know you will tap through it, leave it out; friction here costs you more than
the signal gains.

### Android

Use [HTTP Shortcuts](https://http-shortcuts.rmy.ch/): new shortcut, method
`POST`, URL as above, header `Authorization: Bearer <token>`, body type JSON,
body `{"url": "{{text}}"}`, then enable "Add to share menu" in the shortcut's
trigger settings.

### Desktop

Open the Worker's root URL in a browser. It serves a one-field form; the token
is remembered in local storage.

### Command line

```bash
curl -X POST "$INBOX_URL/save" \
  -H "Authorization: Bearer $INBOX_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/piece","tags":"print","note":"for the essay"}'
```
