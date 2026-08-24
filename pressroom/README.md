# pressroom

Save links from your phone all month. On the 1st, a newspaper is laid out,
curated down to what is actually worth reading, and sent to you as a proof.
Approve it and it goes to print. Ignore it and nothing happens.

```
  phone (share sheet)          the 1st of the month              you
        │                              │                          │
        ▼                              ▼                          ▼
  forward to email ──┐        fetch ─ read ─ score ─          approve the
  Readwise Reader    ├──────▶ select ─ typeset ─ ▶ proof ──▶  purchase
  your own inbox   ──┘        preflight              email     (one click)
                                                                  │
                                                                  ▼
                                                          289×380mm newsprint
```

## What it actually does

- **Captures** anything with a URL: articles, YouTube, X, LinkedIn,
  newsletters, papers. One share-sheet tap.
- **Reads** each save — full article text via Readability, YouTube transcripts,
  Open Graph for the login-walled ones — so curation is based on the thing
  itself, not the headline.
- **Says no.** Claude scores every save on durability, density, print fit and
  how well it matches what you keep coming back to, then a deterministic
  solver fills a fixed page budget. The cap is 14 pieces, because a paper of
  40 is just a heavier backlog.
- **Typesets** a real newspaper: four columns, drop caps, pull quotes verified
  against the source text, QR codes on the pieces you can only finish online.
- **Preflights** to the printer's spec — 289×380mm, multiples of four pages,
  greyscale — and refuses to order a file that would be rejected.
- **Waits for you.** The proof arrives by email; the order runs only after you
  approve it.

Everything that did not make the cut is printed on the back page under
"The spike", with the reason. Nothing you saved disappears silently.

**Setting this up for the first time? Read [SETUP.md](SETUP.md)** — four steps,
about fifteen minutes, and then it runs itself.

## Quick start

```bash
cd pressroom
npm install
npx playwright install chromium          # the renderer
cp pressroom.config.example.json pressroom.config.json
cp .env.example .env                      # then fill it in

npm run pressroom -- doctor               # tells you what is still missing
```

Then pick a capture route — all three can run at once, and everything they
collect is merged and de-duplicated:

| Route | Setup | How you save |
|---|---|---|
| **Email** | An app password. Nothing to deploy. | Share → Mail → send to `you+paper@…` |
| **Readwise Reader** | An account (~$10/mo) and an API token. | Share → Reader |
| **Self-hosted inbox** | Deploy the bundled Worker (~10 min). | Share → your Shortcut |

Details for each are in
[`capture/shortcut/README.md`](capture/shortcut/README.md).

Build last month's issue:

```bash
npm run pressroom -- run
open out/issue-2026-07.proof.pdf
```

## Commands

| Command | What it does |
|---|---|
| `pressroom doctor` | Checks config, tokens, Chromium, Ghostscript. Start here. |
| `pressroom fetch` | Pulls the month's saves and reads them → `out/saves-<month>.json` |
| `pressroom curate` | Scores, selects, writes the copy → `out/issue-<month>.draft.json` |
| `pressroom build` | Typesets and preflights → `out/issue-<month>.print.pdf` |
| `pressroom order` | Hands the file to the printer (or gives you the checklist) |
| `pressroom run` | All of the above, then emails the proof |

Every step writes its output to `out/`, so you can stop after any of them,
edit the JSON by hand, and pick up where you left off. `--month YYYY-MM`
selects the month; it defaults to last month. `--no-ai` skips every model call
and ranks with a transparent heuristic, which is useful for a dry run.

## The monthly ritual

`.github/workflows/monthly-paper.yml` runs at 08:00 UTC on the 1st:

1. **build** pulls the month, curates, typesets, preflights, and emails you the
   proof PDF with the contents list and each piece's one-line case for
   inclusion.
2. **order** is gated on the `print-approval` environment. Add yourself as a
   required reviewer under **Settings → Environments → print-approval**.
   Approving is the purchase decision. It expires on its own if you never
   click, and nothing is spent.

Repository secrets: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, plus whichever
capture route you use — `EMAIL_PASSWORD`, `READWISE_TOKEN`, `INBOX_TOKEN` —
and `PEECHO_*` for automated ordering. `PUBLIC_ASSET_BASE` goes in repository
*variables*.

## Printing

The defaults match **Newspaper Club's digital tabloid**: 289×380mm, 15mm
margins, 4–64 pages in multiples of four, greyscale, single pages. They print
from one copy, on real newsprint, and post it in one to seven working days —
roughly £15–25 a copy including postage. They have no ordering API, so the
last two minutes are yours: `pressroom order` produces the file and the
checklist, you upload and pay.

If you would rather approve a deployment than upload a file, set
`print.vendor` to `peecho` — their REST API places the order end to end. Read
the caveats at the top of `src/print/peecho.ts` first, and run
`pressroom order --dry-run` against their test host before you go live.

`print.vendor: "none"` just leaves the file in `out/` for any printer you like.

## Tuning what gets printed

Two settings do most of the work:

**`curation.tasteNotes`** — plain prose about what you want on paper and what
you always regret printing. It goes into the scoring prompt and outweighs the
model's own taste. This is the highest-leverage line in the config.

**Tags at save time** — `print` forces a piece in whatever it scores; `skip`
keeps it out of the scoring entirely. Configure the tag names under
`curation.alwaysPrintTags` / `neverPrintTags`.

After that: `maxPieces` (default 14) and `pageBudget` (default 24) set how
ruthless the cut is. Lower them before you raise them.

## Choices worth knowing about

**Four columns, not two.** A tabloid page is 289mm wide. Two columns give a
126mm measure — about 110 characters a line, roughly double what anyone reads
comfortably. Real tabloids run four to six. `layout.columns` is yours to change,
but print a proof before you commit to two.

**Videos become one-page summaries, never transcripts.** A printed transcript
is unreadable and enormous. Each video gets original summary copy — the actual
argument, the numbers, the names — plus a QR code if you want to watch it.

**Articles are printed as the author wrote them.** Claude writes the headline,
the standfirst, the pull quotes and the editor's note. It does not rewrite
anyone's article. Pull quotes are checked against the source text and dropped
if they cannot be found, so nothing invented ends up in quotation marks.

**No images.** Web images reproduce badly on newsprint and every one is a
fetch that can fail or a licence you do not have. The paper is type and rules.

**Greyscale.** Newsprint is absorbent and low contrast; colour on it is a
gamble and costs more. Ghostscript converts the file to DeviceGray at the end.
Without Ghostscript installed the PDF stays RGB and preflight says so — most
printers will convert it, but then the result is their call, not yours.

**A thin month is allowed to be thin.** If fewer than `minPieces` clear the
bar, you get a warning rather than a padded issue. Skipping a month is a real
answer.

## Layout

```
src/
  sources/     email + readwise + self-hosted inbox → one normalised list
  enrich/      article extraction, YouTube transcripts, Open Graph fallback
  curate/      claude.ts scores and writes copy; index.ts does the selecting
  render/      newsprint.css, HTML assembly, Playwright → PDF, QR codes
  print/       newspaperclub (manual handoff) and peecho (API) adapters
  preflight.ts the checks a print shop would run before charging you twice
capture/
  worker/      Cloudflare Worker + D1: POST /save, GET /items
  shortcut/    the iOS/Android/desktop capture setup
```

The split that matters: **Claude proposes, the code disposes.** Scoring and
treatment are suggestions; `curate/index.ts` clamps them against mechanical
facts (a 9,000-word piece cannot run in full, a video is never an article) and
the page budget, and `render/build.ts` re-measures the real render and spikes
the weakest piece if the issue runs long. Model output never decides how many
pages get printed.

## Tests

```bash
npm test          # selection, page budget, dedupe, timezones, preflight
npm run typecheck
```

## Extracting this into its own repo

It has no dependency on anything above it:

```bash
git subtree split --prefix=pressroom -b pressroom-only
```

Then move `.github/workflows/monthly-paper.yml` to the new repo's root and
drop the `working-directory: pressroom` defaults from it.
