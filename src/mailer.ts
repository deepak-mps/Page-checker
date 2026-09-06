import fs from "fs";
import { db } from "./db";

export interface PageSummary {
  url: string;
  status: string;
  screenshotAbsPath: string | null;
  reasons: string[]; // empty when the page passed cleanly
}

function isEmailEnabled(): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'email_enabled'").get() as
    | { value: string }
    | undefined;
  return row?.value === "true";
}

function getApiKey(): string | undefined {
  return process.env.SENDGRID_API_KEY;
}

function getFromAddress(): string {
  return process.env.SENDGRID_FROM ?? "pagechecker@example.com";
}

interface SendGridAttachment {
  content: string; // base64
  filename: string;
  type: string;
  disposition: "inline" | "attachment";
  content_id?: string;
}

/** Low-level SendGrid v3 API call. No API key configured → behaves like a no-op transport
 *  (resolves successfully without contacting SendGrid), same fallback behavior the old SMTP
 *  no-op transport had, so the app still runs fine in dev without credentials. */
async function sendViaSendGrid(params: {
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: SendGridAttachment[];
}): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log(`[mailer] SENDGRID_API_KEY not set — skipping actual send (no-op). Subject: "${params.subject}"`);
    return;
  }

  const body = {
    personalizations: [{ to: params.to.map((email) => ({ email })) }],
    from: { email: getFromAddress() },
    subject: params.subject,
    content: [
      { type: "text/plain", value: params.text },
      { type: "text/html", value: params.html },
    ],
    ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
  };

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      detail = JSON.stringify(errBody);
    } catch {
      detail = await res.text().catch(() => "");
    }
    const err: any = new Error(`SendGrid returned ${res.status}: ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
}

export async function sendTestEmail(to: string): Promise<{ sent: boolean; reason?: string }> {
  if (!isEmailEnabled()) {
    return { sent: false, reason: "Email sending is currently disabled in settings." };
  }
  try {
    await sendViaSendGrid({
      to: [to],
      subject: "Page Checker — test email",
      text: "This is a test email from Page Checker. If you received this, delivery is configured correctly.",
      html: `<meta charset="utf-8" /><p style="font-family:Arial,Helvetica,sans-serif;">This is a test email from Page Checker. If you received this, delivery is configured correctly.</p>`,
    });
    return { sent: true };
  } catch (e: any) {
    const reason = describeSendGridError(e);
    console.error("sendTestEmail failed:", reason);
    return { sent: false, reason };
  }
}

/** Shared report email — used both for the internal group's every-run complete report
 *  (all pages, pass or fail) and the client group's once-daily digest (the last scan of
 *  the previous day). `pages` should be every scanned page for "complete report" sends. */
export async function sendScanReportEmail(
  recipients: string[],
  siteName: string,
  scanId: number,
  pages: PageSummary[],
  opts: { violationsCount: number; subjectPrefix: string; introLine: string }
): Promise<{ sent: boolean; reason?: string }> {
  if (!isEmailEnabled()) {
    return { sent: false, reason: "Email sending is currently disabled in settings." };
  }
  if (recipients.length === 0) return { sent: false, reason: "No recipients configured." };

  const MAX_ROWS = 30; // hard cap so a huge scan can't produce an unbounded email
  const MAX_INLINE_SCREENSHOTS = 15; // keep total message size sane — beyond this, rows still show but without an inline image
  const rows = pages.slice(0, MAX_ROWS);

  const attachments: SendGridAttachment[] = [];
  let inlineCount = 0;

  const tableRowsHtml = rows
    .map((p, i) => {
      let imgHtml = `<span style="color:#9a9a9a; font-size:12px;">No screenshot</span>`;
      if (p.screenshotAbsPath && inlineCount < MAX_INLINE_SCREENSHOTS) {
        const cid = `shot${i}_${scanId}@pagechecker`;
        try {
          const content = fs.readFileSync(p.screenshotAbsPath).toString("base64");
          attachments.push({
            content,
            filename: `screenshot-${i + 1}.png`,
            type: "image/png",
            disposition: "inline",
            content_id: cid,
          });
          imgHtml = `<img src="cid:${cid}" width="220" style="display:block; border:1px solid #e6e6e9; border-radius:8px;" alt="Screenshot" />`;
          inlineCount++;
        } catch {
          imgHtml = `<span style="color:#9a9a9a; font-size:12px;">Screenshot unavailable</span>`;
        }
      } else if (p.screenshotAbsPath) {
        imgHtml = `<span style="color:#9a9a9a; font-size:12px;">See dashboard</span>`;
      }

      const statusColor = p.reasons.length === 0 ? { bg: "#dcfce7", fg: "#15803d" } : { bg: "#fef3c7", fg: "#92400e" };
      const reasonsHtml = p.reasons.length
        ? p.reasons.map((r) => `<div style="margin-bottom:4px;">• ${escapeHtml(r)}</div>`).join("")
        : `<span style="color:#15803d;">All checks passed</span>`;

      return `
        <tr>
          <td style="padding:12px 16px; border-bottom:1px solid #eeeeee; vertical-align:top; font-family:ui-monospace,Menlo,monospace; font-size:12px; word-break:break-all; max-width:260px;">
            <a href="${escapeHtml(p.url)}" style="color:#16161a; text-decoration:none;">${escapeHtml(p.url)}</a><br/>
            <span style="display:inline-block; margin-top:6px; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; background:${statusColor.bg}; color:${statusColor.fg};">${escapeHtml(p.status)}</span>
          </td>
          <td style="padding:12px 16px; border-bottom:1px solid #eeeeee; vertical-align:top; font-family:Arial,Helvetica,sans-serif; font-size:13px; color:#333333; max-width:320px;">${reasonsHtml}</td>
          <td style="padding:12px 16px; border-bottom:1px solid #eeeeee; vertical-align:top;">${imgHtml}</td>
        </tr>`;
    })
    .join("");

  const truncatedNote =
    pages.length > MAX_ROWS
      ? `<p style="color:#71717a; font-size:12px;">…and ${pages.length - MAX_ROWS} more page(s). See the full report in the dashboard.</p>`
      : "";

  const html = `
  <meta charset="utf-8" />
  <div style="font-family:Arial,Helvetica,sans-serif; color:#16161a; max-width:900px;">
    <h2 style="margin:0 0 4px;">${escapeHtml(opts.subjectPrefix)} — ${escapeHtml(siteName)}</h2>
    <p style="margin:0 0 20px; color:#71717a; font-size:13px;">${escapeHtml(opts.introLine)} · Scan #${scanId} · ${pages.length} page(s) · ${opts.violationsCount} violation(s)</p>
    <table style="border-collapse:collapse; width:100%;">
      <thead>
        <tr style="background:#f7f7f8;">
          <th style="text-align:left; padding:10px 16px; border-bottom:2px solid #e6e6e9; font-size:12px; text-transform:uppercase; letter-spacing:0.03em; color:#71717a;">URL</th>
          <th style="text-align:left; padding:10px 16px; border-bottom:2px solid #e6e6e9; font-size:12px; text-transform:uppercase; letter-spacing:0.03em; color:#71717a;">Result</th>
          <th style="text-align:left; padding:10px 16px; border-bottom:2px solid #e6e6e9; font-size:12px; text-transform:uppercase; letter-spacing:0.03em; color:#71717a;">Screenshot</th>
        </tr>
      </thead>
      <tbody>${tableRowsHtml}</tbody>
    </table>
    ${truncatedNote}
  </div>`;

  const text = [
    `${opts.subjectPrefix} — ${siteName}`,
    `${opts.introLine} — Scan #${scanId}, ${pages.length} page(s), ${opts.violationsCount} violation(s).`,
    "",
    ...rows.flatMap((p) => [
      `${p.url}  [${p.status}]`,
      ...(p.reasons.length ? p.reasons.map((r) => `  - ${r}`) : ["  All checks passed"]),
    ]),
    ...(pages.length > MAX_ROWS ? ["", `…and ${pages.length - MAX_ROWS} more page(s). See the full report in the dashboard.`] : []),
  ].join("\n");

  try {
    await sendViaSendGrid({
      to: recipients,
      subject: `${opts.subjectPrefix} — ${siteName} (${opts.violationsCount} violation(s))`,
      text,
      html,
      attachments,
    });
    return { sent: true };
  } catch (e: any) {
    const reason = describeSendGridError(e);
    console.error("sendScanReportEmail failed:", reason);
    return { sent: false, reason };
  }
}

function escapeHtml(str: string): string {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Turn a raw SendGrid API error into a short, actionable message instead of a stack trace. */
function describeSendGridError(e: any): string {
  const status = e?.status;
  const detail = String(e?.detail ?? e?.message ?? e);

  if (status === 401) {
    return `SendGrid rejected the API key (401). Double-check SENDGRID_API_KEY is correct and hasn't been revoked. Raw: ${detail.slice(0, 300)}`;
  }
  if (status === 403) {
    return `SendGrid rejected the request as forbidden (403) — usually means the "from" address (SENDGRID_FROM) isn't a verified sender. In SendGrid: Settings → Sender Authentication. Raw: ${detail.slice(0, 300)}`;
  }
  if (status === 400) {
    return `SendGrid rejected the request as malformed (400) — check SENDGRID_FROM is a valid, verified email address. Raw: ${detail.slice(0, 300)}`;
  }
  return detail.slice(0, 500);
}
