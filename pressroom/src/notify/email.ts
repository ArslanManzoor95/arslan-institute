import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fetchWithRetry } from "../http.js";
import { log } from "../log.js";
import { escapeHtml } from "../text.js";
import type { Config, Secrets } from "../config.js";
import type { Issue } from "../types.js";
import type { Check } from "../preflight.js";

/** Resend rejects anything over 40MB including the base64 overhead. */
const MAX_ATTACHMENT_BYTES = 25_000_000;

export interface ProofEmail {
  issue: Issue;
  proofPath: string;
  checks: Check[];
  /** Where the approval happens, if the run knows. */
  approvalUrl?: string;
  estimatedCost?: string;
}

/**
 * The one message you get each month: here is the paper, here is what it
 * cost you in attention, approve or do not.
 */
export async function sendProofEmail(
  config: Config,
  secrets: Secrets,
  proof: ProofEmail,
): Promise<boolean> {
  const to = config.delivery.proofEmail;
  const from = config.delivery.fromEmail;

  if (!secrets.resendApiKey || !to || !from) {
    log.warn(
      "skipping the proof email: set RESEND_API_KEY and delivery.proofEmail / delivery.fromEmail",
    );
    return false;
  }

  const attachments = [];
  const pdf = await readFile(proof.proofPath);
  if (pdf.byteLength <= MAX_ATTACHMENT_BYTES) {
    attachments.push({
      filename: basename(proof.proofPath),
      content: pdf.toString("base64"),
    });
  } else {
    log.warn(
      `proof is ${(pdf.byteLength / 1e6).toFixed(1)}MB — too large to attach, sending the summary only`,
    );
  }

  await fetchWithRetry("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secrets.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: `${proof.issue.masthead} No. ${proof.issue.number} — ${proof.issue.monthLabel} — ready to print`,
      html: proofHtml(proof),
      attachments,
    }),
    label: "resend",
    retries: 3,
  });

  log.info(`proof emailed to ${to}`);
  return true;
}

function proofHtml(proof: ProofEmail): string {
  const { issue } = proof;

  const contents = issue.pieces
    .map(
      (piece, index) =>
        `<tr>
           <td style="padding:6px 10px 6px 0;color:#888;">${index + 1}</td>
           <td style="padding:6px 0;">
             <strong>${escapeHtml(piece.headline)}</strong><br>
             <span style="color:#666;font-size:13px;">
               ${escapeHtml(piece.verdict.section)} ·
               ${escapeHtml(piece.item.siteName ?? "")} ·
               ${escapeHtml(piece.verdict.pitch)}
             </span>
           </td>
         </tr>`,
    )
    .join("");

  const problems = proof.checks.filter((c) => !c.ok);
  const problemHtml = problems.length
    ? `<p style="padding:12px;border:1px solid #c00;color:#c00;">
         ${problems
           .map((c) => `${c.severity === "error" ? "Blocking" : "Warning"}: ${escapeHtml(c.detail)}`)
           .join("<br>")}
       </p>`
    : `<p style="color:#2a7;">Preflight passed. The file is ready for the printer.</p>`;

  return `<div style="font-family:Georgia,serif;max-width:640px;line-height:1.5;color:#111;">
  <h1 style="font-size:22px;margin:0 0 4px;">${escapeHtml(issue.masthead)} No. ${issue.number}</h1>
  <p style="margin:0 0 18px;color:#666;">${escapeHtml(issue.monthLabel)} · ${issue.pageCount} pages · ${issue.pieces.length} pieces${proof.estimatedCost ? ` · about ${escapeHtml(proof.estimatedCost)}` : ""}</p>

  ${problemHtml}

  <p>You saved <strong>${issue.stats.captured}</strong> things this month.
  <strong>${issue.stats.printed}</strong> made the paper; the other
  ${issue.stats.captured - issue.stats.printed} are listed on the spike page at the back.</p>

  <h2 style="font-size:15px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #111;padding-bottom:4px;">Inside</h2>
  <table style="width:100%;border-collapse:collapse;font-size:15px;">${contents}</table>

  ${
    proof.approvalUrl
      ? `<p style="margin:24px 0;">
           <a href="${escapeHtml(proof.approvalUrl)}"
              style="background:#111;color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">
             Approve the print run
           </a>
         </p>
         <p style="color:#666;font-size:13px;">Do nothing and no paper is printed.</p>`
      : `<p style="color:#666;font-size:13px;">The print-ready file is attached to this message.</p>`
  }
</div>`;
}
