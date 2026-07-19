/**
 * Arslan Institute - brochure capture Worker.
 *
 * The marketing site is static HTML hosted as-is. This standalone Cloudflare Worker
 * is the server side the capture page (/schools/brochure/) POSTs to. It:
 *   1. validates the submission server-side and rejects the honeypot,
 *   2. sends TWO transactional emails via Resend:
 *        A. the brochure to the visitor  (reply-to Arslan, hosted brochure link),
 *        B. a notification to Arslan      (reply-to the visitor),
 *   3. returns JSON for the page's loading / success / error states.
 *
 * Secrets (set with `wrangler secret put <NAME>`; see worker/README.md):
 *   RESEND_API_KEY  - Resend API key.
 *   FROM_EMAIL      - verified sender on arslaninstitute.com, e.g. hello@arslaninstitute.com.
 *   NOTIFY_EMAIL    - where notifications go / reply-to for the brochure, arslan@arslaninstitute.com.
 *   BROCHURE_URL    - hosted link to the brochure PDF.
 *
 * British English throughout. No em-dashes.
 */

// Origins allowed to call this Worker via CORS. Add the production apex/www here.
// localhost is included so the capture page can be tested against a local `wrangler dev`.
const ALLOWED_ORIGINS = [
  'https://arslaninstitute.com',
  'https://www.arslaninstitute.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The brochure email's reply-to is always Arslan's branded address on the verified
// domain, independent of where notifications are routed (NOTIFY_EMAIL may be a
// personal inbox), so visitor replies to the brochure reach him directly.
const BROCHURE_REPLY_TO = 'arslan@arslaninstitute.com';

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Email bodies -----------------------------------------------------------

function brochureEmailHtml(name, brochureUrl) {
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(brochureUrl);
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#f8f5ef;font-family:Arial,Helvetica,sans-serif;color:#2e3d4f;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f5ef;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border:1px solid #e3dbd0;border-radius:10px;padding:36px;">
          <tr>
            <td style="font-size:20px;font-weight:bold;color:#1b2a3b;padding-bottom:20px;">Arslan Institute</td>
          </tr>
          <tr>
            <td style="font-size:16px;line-height:1.7;color:#2e3d4f;">
              <p style="margin:0 0 16px;">Hello ${safeName},</p>
              <p style="margin:0 0 16px;">Thank you for requesting the Arslan Institute programme brochure. It provides a detailed overview of the key workshops for teachers and students, which can be tailored for school and teacher needs.</p>
              <p style="margin:0 0 24px;">You can read and download it here:</p>
              <p style="margin:0 0 24px;">
                <a href="${safeUrl}" style="display:inline-block;background-color:#bf8c52;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:6px;">View the brochure</a>
              </p>
              <p style="margin:0 0 16px;">Arslan will be in touch shortly with a couple of suggested times to talk. If it is easier, just reply to this email and it will reach him directly.</p>
              <p style="margin:24px 0 0;">Best wishes,<br>Arslan Institute</p>
            </td>
          </tr>
        </table>
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <tr>
            <td style="font-size:12px;color:#6b7c8e;padding:18px 4px 0;">Arslan Institute, London. AI fluency workshops for schools.</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function notifyEmailHtml(lead) {
  const rows = [
    ['Name', lead.full_name],
    ['Role', lead.role],
    ['Organisation', lead.organisation],
    ['Email', lead.email],
    ['Submitted', lead.timestamp],
  ];
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e3dbd0;font-weight:bold;color:#1b2a3b;white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e3dbd0;color:#2e3d4f;">${escapeHtml(value)}</td>
        </tr>`
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background-color:#f8f5ef;font-family:Arial,Helvetica,sans-serif;color:#2e3d4f;">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background-color:#ffffff;border:1px solid #e3dbd0;border-radius:10px;padding:28px;">
    <tr><td style="font-size:18px;font-weight:bold;color:#1b2a3b;padding-bottom:16px;">New brochure request</td></tr>
    <tr>
      <td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">
          ${rowsHtml}
        </table>
      </td>
    </tr>
    <tr><td style="font-size:13px;color:#6b7c8e;padding-top:18px;line-height:1.6;">Reply to this email to respond straight to the lead.</td></tr>
  </table>
</body>
</html>`;
}

// Plain-text alternatives. Sending multipart (text + html) improves deliverability;
// HTML-only messages are more likely to be filtered as spam.
function brochureEmailText(name, brochureUrl) {
  return `Hello ${name},

Thank you for requesting the Arslan Institute programme brochure. It provides a detailed overview of the key workshops for teachers and students, which can be tailored for school and teacher needs.

You can read and download it here:
${brochureUrl}

Arslan will be in touch shortly with a couple of suggested times to talk. If it is easier, just reply to this email and it will reach him directly.

Best wishes,
Arslan Institute

Arslan Institute, London. AI fluency workshops for schools.`;
}

function notifyEmailText(lead) {
  return `New brochure request

Name: ${lead.full_name}
Role: ${lead.role}
Organisation: ${lead.organisation}
Email: ${lead.email}
Submitted: ${lead.timestamp}

Reply to this email to respond straight to the lead.`;
}

// --- Resend -----------------------------------------------------------------

async function sendEmail(apiKey, message) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  return res.json().catch(() => ({}));
}

// --- Worker -----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed.' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid request body.' }, 400, origin);
    }

    // Honeypot: bots fill it, real users cannot see it. Silently discard so bots
    // believe it worked and do not retry; no email is sent.
    if (body.website && String(body.website).trim() !== '') {
      console.log('Brochure honeypot triggered; submission discarded.');
      return json({ ok: true }, 200, origin);
    }

    const full_name = (body.full_name || '').toString().trim();
    const role = (body.role || '').toString().trim();
    const organisation = (body.organisation || '').toString().trim();
    const email = (body.email || '').toString().trim();

    if (!full_name || !role || !organisation || !email) {
      return json({ ok: false, error: 'All fields are required.' }, 400, origin);
    }
    if (!EMAIL_RE.test(email)) {
      return json({ ok: false, error: 'Please provide a valid email address.' }, 400, origin);
    }

    // Fail fast with a clear server log if configuration is missing.
    const { RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL, BROCHURE_URL } = env;
    if (!RESEND_API_KEY || !FROM_EMAIL || !BROCHURE_URL) {
      console.error('Brochure Worker missing required config (RESEND_API_KEY / FROM_EMAIL / BROCHURE_URL).');
      return json({ ok: false, error: 'The brochure service is not configured. Please email us directly.' }, 500, origin);
    }
    const notifyTo = NOTIFY_EMAIL || 'arslan@arslaninstitute.com';

    const timestamp = new Date().toLocaleString('en-GB', {
      timeZone: 'Europe/London',
      dateStyle: 'full',
      timeStyle: 'short',
    });

    // A friendly display name reads better and helps deliverability. The address must
    // still be on the verified sending domain (FROM_EMAIL).
    const fromAddress = `Arslan Institute <${FROM_EMAIL}>`;

    // Email A: brochure to the visitor. Reply-to Arslan's branded address so replies reach him.
    const brochureEmail = {
      from: fromAddress,
      to: email,
      reply_to: BROCHURE_REPLY_TO,
      subject: 'Your Arslan Institute programme brochure',
      html: brochureEmailHtml(full_name, BROCHURE_URL),
      text: brochureEmailText(full_name, BROCHURE_URL),
      // A valid unsubscribe path improves inbox placement (Gmail/Yahoo favour it).
      headers: { 'List-Unsubscribe': '<mailto:arslan@arslaninstitute.com?subject=unsubscribe>' },
    };

    // Email B: notification to Arslan. Reply-to the visitor so he can reply to the lead.
    const notifyEmail = {
      from: fromAddress,
      to: notifyTo,
      reply_to: email,
      subject: `New brochure request: ${organisation}`,
      html: notifyEmailHtml({ full_name, role, organisation, email, timestamp }),
      text: notifyEmailText({ full_name, role, organisation, email, timestamp }),
    };

    try {
      // Send both; if either fails, surface an error rather than failing silently.
      await Promise.all([
        sendEmail(RESEND_API_KEY, brochureEmail),
        sendEmail(RESEND_API_KEY, notifyEmail),
      ]);
    } catch (err) {
      console.error('Brochure email send failed:', err && err.message ? err.message : err);
      return json(
        { ok: false, error: 'We could not send the brochure just now. Please try again shortly.' },
        502,
        origin
      );
    }

    return json({ ok: true }, 200, origin);
  },
};
