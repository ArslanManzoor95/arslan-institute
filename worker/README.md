# Brochure capture Worker

A standalone Cloudflare Worker that backs the brochure capture page at
`/schools/brochure/`. The marketing site stays a static site hosted where it is;
only this function runs on Cloudflare.

On a valid submission the Worker sends two emails via [Resend](https://resend.com):

- **To the visitor:** the brochure, as a hosted link (`BROCHURE_URL`), with reply-to set to `arslan@arslaninstitute.com`.
- **To Arslan:** a formatted notification with the lead's details and a timestamp, with reply-to set to the visitor so he can reply straight to the lead.

## Prerequisites (flagged for setup)

1. **Resend account and API key.** Create one at resend.com and generate an API key.
2. **Verify the sending domain.** `arslaninstitute.com` must be verified in Resend
   with the SPF and DKIM DNS records it provides. Until the domain is verified,
   no email will send.
3. **Hosted brochure PDF.** Upload the brochure and set `BROCHURE_URL` to its public
   link. A placeholder is used until the real URL is provided.

## Configure secrets

Production (per secret):

```sh
cd worker
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put FROM_EMAIL      # e.g. hello@arslaninstitute.com (must be on the verified domain)
npx wrangler secret put NOTIFY_EMAIL    # arslan@arslaninstitute.com
npx wrangler secret put BROCHURE_URL    # hosted brochure PDF link
```

Local development: copy `.dev.vars.example` to `.dev.vars` and fill in real values.

## Run and deploy

```sh
cd worker
npm install
npm run dev      # local: http://127.0.0.1:8787
npm run deploy   # publishes to https://arslan-brochure.<your-subdomain>.workers.dev
```

## Wire up the page

After deploying, copy the Worker URL and set `BROCHURE_ENDPOINT` in
`schools/brochure/index.html` (marked with a `TODO`). A custom route such as
`https://api.arslaninstitute.com/brochure` also works if you prefer.

## CORS

Allowed origins are listed in `src/index.js` (`ALLOWED_ORIGINS`). Update the apex
and www entries to match production before going live; `localhost:8000` is included
for local testing of the static page.
