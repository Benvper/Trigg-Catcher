import { task, logger } from "@trigger.dev/sdk";
import type { PitchedLead } from "./generate-pitch.js";

/**
 * Formats the week's leads into an HTML email and sends it via Resend.
 * Each lead is a card: who they are, how to reach them, what to sell them,
 * and the ready-to-copy outreach email.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapes, then converts newlines to <br> for email-body display. */
function toHtmlBlock(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function renderLead(lead: PitchedLead, index: number): string {
  const { pitch } = lead;

  const contactLine = lead.contactEmail
    ? `<a href="mailto:${escapeHtml(lead.contactEmail)}" style="color:#1a56db;text-decoration:none;font-weight:600;">${escapeHtml(lead.contactEmail)}</a>${
        lead.emailConfidence !== null
          ? ` <span style="color:#6b7280;font-size:12px;">(${lead.emailConfidence}% confidence)</span>`
          : ""
      }`
    : `<span style="color:#b45309;">No email found</span>`;

  const linkedinHref = lead.linkedinUrl ?? lead.linkedinSearchUrl;
  const linkedinLabel = lead.linkedinUrl
    ? "LinkedIn profile"
    : "Search LinkedIn";

  const automations =
    pitch?.automations
      .map(
        (a) => `
        <li style="margin-bottom:10px;">
          <strong>${escapeHtml(a.name)}</strong>
          <span style="color:#047857;font-weight:600;">— saves ~${a.hoursSavedPerWeek} hrs/week</span><br>
          <span style="color:#374151;">${escapeHtml(a.whatItDoes)}</span><br>
          <span style="color:#6b7280;font-size:13px;">Build: ${escapeHtml(a.howYouWouldBuildIt)}</span>
        </li>`,
      )
      .join("") ?? "";

  const painPoints =
    pitch?.painPoints
      .map((p) => `<li style="color:#374151;">${escapeHtml(p)}</li>`)
      .join("") ?? "";

  const pitchSection = pitch
    ? `
      <div style="margin-top:16px;">
        <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Likely pain points</div>
        <ul style="margin:6px 0 16px 20px;padding:0;">${painPoints}</ul>

        <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">What to sell them</div>
        <ul style="margin:6px 0 16px 20px;padding:0;">${automations}</ul>

        <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Ready to send</div>
        <div style="margin-top:6px;padding:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
          <div style="color:#111827;font-weight:600;margin-bottom:10px;">Subject: ${escapeHtml(pitch.emailSubject)}</div>
          <div style="color:#374151;line-height:1.6;font-size:14px;">${toHtmlBlock(pitch.emailBody)}</div>
        </div>
      </div>`
    : `<div style="margin-top:14px;padding:12px;background:#fef3c7;border-radius:6px;color:#92400e;">
         No pitch generated for this lead. The business details above are still accurate — write to them manually.
       </div>`;

  const note = lead.enrichmentNote
    ? `<div style="margin-top:10px;padding:10px;background:#fffbeb;border-left:3px solid #f59e0b;color:#92400e;font-size:13px;">${escapeHtml(lead.enrichmentNote)}</div>`
    : "";

  const scoreBadge = pitch
    ? `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${
        pitch.fitScore >= 8 ? "#d1fae5" : pitch.fitScore >= 6 ? "#dbeafe" : "#f3f4f6"
      };color:${
        pitch.fitScore >= 8 ? "#065f46" : pitch.fitScore >= 6 ? "#1e40af" : "#4b5563"
      };font-size:12px;font-weight:700;">Fit ${pitch.fitScore}/10</span>`
    : "";

  return `
  <div style="border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:20px;background:#ffffff;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;">
      <div>
        <div style="font-size:12px;color:#9ca3af;font-weight:600;">LEAD ${index + 1}</div>
        <div style="font-size:19px;font-weight:700;color:#111827;margin-top:2px;">${escapeHtml(lead.name)}</div>
        <div style="color:#6b7280;font-size:14px;margin-top:3px;">
          ${escapeHtml(lead.category)} &middot; ${escapeHtml(lead.city)}
          ${lead.rating !== null ? ` &middot; ${lead.rating}★ (${lead.reviewCount ?? 0} reviews)` : ""}
        </div>
      </div>
      <div>${scoreBadge}</div>
    </div>

    ${pitch ? `<div style="margin-top:10px;color:#4b5563;font-size:14px;font-style:italic;">${escapeHtml(pitch.fitReason)}</div>` : ""}

    <table style="width:100%;margin-top:14px;font-size:14px;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 0;color:#6b7280;width:110px;">Contact</td>
        <td style="padding:4px 0;color:#111827;">${
          lead.contactName ? escapeHtml(lead.contactName) : "Unknown"
        }${lead.contactPosition ? ` <span style="color:#6b7280;">— ${escapeHtml(lead.contactPosition)}</span>` : ""}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280;">Email</td>
        <td style="padding:4px 0;">${contactLine}</td>
      </tr>
      <tr>
        <td style="padding:4px 0;color:#6b7280;">LinkedIn</td>
        <td style="padding:4px 0;"><a href="${escapeHtml(linkedinHref)}" style="color:#1a56db;text-decoration:none;">${linkedinLabel}</a></td>
      </tr>
      ${
        lead.phone
          ? `<tr><td style="padding:4px 0;color:#6b7280;">Phone</td><td style="padding:4px 0;color:#111827;">${escapeHtml(lead.phone)}</td></tr>`
          : ""
      }
      <tr>
        <td style="padding:4px 0;color:#6b7280;">Website</td>
        <td style="padding:4px 0;"><a href="${escapeHtml(lead.website)}" style="color:#1a56db;text-decoration:none;">${escapeHtml(lead.domain)}</a></td>
      </tr>
    </table>

    ${note}
    ${pitchSection}
  </div>`;
}

export const sendDigest = task({
  id: "send-digest",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2_000 },
  run: async (payload: {
    leads: PitchedLead[];
    creditsRemaining: number | null;
    creditsSpent: number;
    totalFound: number;
  }) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("RESEND_API_KEY is not set");

    const from = process.env.DIGEST_FROM_EMAIL;
    if (!from) throw new Error("DIGEST_FROM_EMAIL is not set");

    const to = process.env.DIGEST_TO_EMAIL;
    if (!to) throw new Error("DIGEST_TO_EMAIL is not set");

    const { leads, creditsRemaining, creditsSpent, totalFound } = payload;

    // Best-fit leads first so the top of the email is the best use of time.
    const sorted = [...leads].sort(
      (a, b) => (b.pitch?.fitScore ?? 0) - (a.pitch?.fitScore ?? 0),
    );

    const withEmail = sorted.filter((l) => l.contactEmail).length;
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "America/New_York",
    });

    const creditLine =
      creditsRemaining === null
        ? `${creditsSpent} Hunter lookups used this run.`
        : `${creditsSpent} Hunter lookups used &middot; about ${Math.max(0, creditsRemaining - creditsSpent)} left this month.`;

    const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:680px;margin:0 auto;">
    <div style="background:#111827;color:#ffffff;padding:24px;border-radius:10px 10px 0 0;">
      <div style="font-size:22px;font-weight:700;">Weekly Leads — NJ / NY</div>
      <div style="color:#9ca3af;font-size:14px;margin-top:4px;">${today}</div>
    </div>

    <div style="background:#ffffff;padding:16px 24px;border-bottom:1px solid #e5e7eb;color:#374151;font-size:14px;">
      <strong>${sorted.length}</strong> leads &middot; <strong>${withEmail}</strong> with a verified email
      &middot; ${totalFound} businesses screened<br>
      <span style="color:#6b7280;font-size:13px;">${creditLine}</span>
    </div>

    <div style="background:#f3f4f6;padding:20px 0;">
      ${sorted.map((lead, i) => renderLead(lead, i)).join("")}
    </div>

    <div style="background:#ffffff;padding:20px 24px;border-radius:0 0 10px 10px;color:#6b7280;font-size:13px;line-height:1.6;">
      Read each email before you send it. Check the hours-saved figure against what you
      would actually build — you are personally guaranteeing that number.<br><br>
      Generated automatically by your Trigger.dev lead finder.
    </div>
  </div>
</body></html>`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `${sorted.length} AI automation leads — week of ${today}`,
        html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Resend send failed (${response.status}): ${body}`);
    }

    const result = (await response.json()) as { id?: string };
    logger.info("Digest sent", { emailId: result.id, leads: sorted.length });

    return { sent: true, emailId: result.id ?? null, leadCount: sorted.length };
  },
});
