# Setup — about fifteen minutes, once

Your config is already written for the route you chose: capture by email,
print with Newspaper Club, one copy, approve each issue.

There are four things only you can do. After them, the paper builds itself
every month.

---

## 1. A Gmail app password (5 min)

This is a revocable password that only grants mail access. It is not your
account password, and the pipeline only ever reads.

1. Turn on 2-Step Verification if it is not already on:
   <https://myaccount.google.com/signinoptions/two-step-verification>
2. Create an app password: <https://myaccount.google.com/apppasswords>
   Name it `pressroom`.
3. Copy the 16-character password. You will paste it in step 3 and can then
   forget it — revoke it any time from the same page.

## 2. An Anthropic API key (2 min)

<https://console.anthropic.com> → API keys → Create key.

Curation costs roughly a pound or two a month: scoring every save, then
writing the headline, standfirst and pull quotes for the dozen or so that
make it. Add a spend limit in the console if you want a hard ceiling.

## 3. Put both in the repository (3 min)

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `EMAIL_PASSWORD` | the app password from step 1 |
| `ANTHROPIC_API_KEY` | the key from step 2 |

## 4. Create the approval gate (2 min)

**Settings → Environments → New environment**, name it exactly
`print-approval`. Tick **Required reviewers** and add yourself. Save.

This is the whole approval mechanism. When an issue is ready, GitHub emails
you that a deployment is waiting; you open the run, read the contents list,
download the proof, and click approve. Ignore it and nothing is printed and
nothing is spent.

## 5. Merge to `main`

Scheduled workflows only run from the default branch. Until this branch is
merged, nothing fires on its own — though you can still run it by hand.

---

# Using it

## Saving something

**Share sheet → Mail → send to `arslan.manzoor57+paper@gmail.com`.**

It arrives in your normal inbox and the pipeline reads only the mail
addressed to `+paper`. Nothing else in your mailbox is touched.

- **Type a line above the link** if you have one. Why you saved it is the
  strongest curation signal there is — it outweighs the model's own taste.
- **`#print` in the subject** prints it whatever it scores.
  **`#skip`** keeps it out entirely.
- Several links in one message each become their own candidate.
- Forwarding a newsletter works exactly the same way.

## What happens on the 1st

08:00 UTC, the workflow pulls last month's saves, reads each one, scores
them, typesets the survivors, preflights the file, and stops. GitHub emails
you that `print-approval` is waiting.

You open the run. The summary lists every piece with a one-line case for
printing it, and the proof PDF is in the Artifacts section. Approve, and the
run prints this:

```
Open https://www.newspaperclub.com/print/upload
Choose "Digital Tabloid", 1 copy.
Upload issue-2026-08.print.pdf (24 pages, greyscale).
Pay. One to seven working days by Royal Mail.
```

That upload is the only recurring work, and it is about two minutes.

## Trying it before the 1st

**Actions → Monthly paper → Run workflow**, and set the month to the current
one. Forward yourself three or four links first so it has something to work
with. This is worth doing once before you rely on it.

## Tuning it

The line that matters is `curation.tasteNotes` in `pressroom.config.json`. It
currently holds a placeholder — rewrite it in your own words. Everything else
has a sensible default.

If the paper feels too full, lower `curation.maxPieces` (now 14) before you
raise anything. Twelve good pieces get read; forty become another backlog.
