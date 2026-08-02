import { task, logger } from "@trigger.dev/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { EnrichedLead } from "./enrich-contact.js";

/**
 * Uses Claude Opus 5 to turn a raw business record into a sellable lead:
 * specific AI automations worth pitching to that business, and a complete
 * outreach email asking for a short call.
 */

const PitchSchema = z.object({
  fitScore: z
    .number()
    .describe("How good a fit this business is for AI automation, 1-10."),
  fitReason: z
    .string()
    .describe("One sentence on why this business scored the way it did."),
  painPoints: z
    .array(z.string())
    .describe(
      "2-3 specific operational problems this type of business plausibly has.",
    ),
  automations: z
    .array(
      z.object({
        name: z.string().describe("Short name for the automation."),
        whatItDoes: z
          .string()
          .describe("Plain-English description a non-technical owner follows."),
        hoursSavedPerWeek: z
          .number()
          .describe("Realistic hours saved per week. Do not inflate."),
        howYouWouldBuildIt: z
          .string()
          .describe("One line on the tools and approach, for the seller only."),
      }),
    )
    .describe("2-3 automations, most compelling first."),
  emailSubject: z.string().describe("Subject line under 60 characters."),
  emailBody: z
    .string()
    .describe("The full outreach email as plain text, including the sign-off."),
});

export type Pitch = z.infer<typeof PitchSchema>;
export type PitchedLead = EnrichedLead & { pitch: Pitch | null };

function buildSystemPrompt(): string {
  const senderName = process.env.SENDER_NAME || "[Your name]";
  const senderTitle = process.env.SENDER_TITLE || "AI Automation Consultant";
  const senderCompany = process.env.SENDER_COMPANY || "";
  const senderEmail = process.env.SENDER_EMAIL || "";
  const senderPhone = process.env.SENDER_PHONE || "";
  const calendarUrl = process.env.SENDER_CALENDAR_URL || "";
  const guaranteeHours = process.env.GUARANTEE_HOURS || "5";
  const guaranteePeriod = process.env.GUARANTEE_PERIOD || "per week";
  const guaranteeTerms =
    process.env.GUARANTEE_TERMS ||
    `If the automation I build doesn't save you at least ${guaranteeHours} hours ${guaranteePeriod} within 30 days of going live, I refund your payment in full.`;

  const callToAction = calendarUrl
    ? `Ask for 15-20 minutes on Zoom or a phone call, and include this booking link: ${calendarUrl}`
    : `Ask for 15-20 minutes on Zoom or a phone call, and ask them to reply with two or three times that work.`;

  return `You write cold outreach emails for ${senderName}, ${senderTitle}${senderCompany ? ` at ${senderCompany}` : ""}. ${senderName} builds custom AI automations for small and medium businesses in the New Jersey and New York area.

Your job for each business: identify what actually eats their staff's time, propose specific automations worth selling them, and write one outreach email.

## Rules for the automations

Be concrete and specific to THIS business type. "Use AI to improve efficiency" is worthless. "Answer after-hours calls, capture the job details, and text the on-call tech" is sellable.

Estimate hours saved honestly. A solo dental office does not save 40 hours a week on appointment reminders. If you cannot justify the number to a skeptical owner, lower it. Credibility matters more than an impressive figure — the seller is personally guaranteeing these results.

Favor automations that are genuinely buildable with today's tools: call handling and transcription, intake and lead-response, appointment reminders and no-show reduction, quote and proposal drafting, review requests and responses, document and form processing, scheduling and dispatch, follow-up sequences, reporting.

## Rules for the email

- Under 150 words. Owners skim on a phone between jobs.
- Open with something specific to their business — their trade, their town, the nature of their work. Never "I hope this email finds you well" or "I came across your website."
- Name ONE concrete problem and the automation that fixes it. Do not list all of them; save those for the call.
- State the time saving plainly, using the number you estimated.
- Include this guarantee verbatim, as its own sentence: "${guaranteeTerms}"
- ${callToAction}
- Be direct about what the call is: you want to ask about their current process and where time goes, then explain what you would build.
- No hype, no emoji, no exclamation marks, no buzzwords ("leverage", "synergy", "revolutionary", "game-changer", "cutting-edge").
- Do not claim you have used their service, know them, or were referred. Never invent facts about their business.
- Address them by first name if one is provided; otherwise open without a name rather than writing "Dear Owner".
- Sign off as:
${senderName}${senderTitle ? `\n${senderTitle}` : ""}${senderCompany ? `\n${senderCompany}` : ""}${senderEmail ? `\n${senderEmail}` : ""}${senderPhone ? `\n${senderPhone}` : ""}

Write in plain, confident, human English — like a competent contractor explaining what they would do, not a marketer.`;
}

export const generatePitch = task({
  id: "generate-pitch",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 3_000 },
  run: async (payload: { lead: EnrichedLead }): Promise<PitchedLead> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

    const client = new Anthropic({ apiKey });
    const { lead } = payload;

    const businessBrief = [
      `Business name: ${lead.name}`,
      `Type: ${lead.category} (${lead.vertical.replace("_", " ")})`,
      `Location: ${lead.address || lead.city}`,
      `Website: ${lead.website}`,
      lead.organization ? `Organization name on file: ${lead.organization}` : null,
      lead.rating !== null
        ? `Google rating: ${lead.rating} from ${lead.reviewCount ?? 0} reviews`
        : null,
      lead.contactName ? `Contact: ${lead.contactName}` : "Contact: unknown",
      lead.contactPosition ? `Their role: ${lead.contactPosition}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const response = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      output_config: {
        effort: "high",
        format: zodOutputFormat(PitchSchema),
      },
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: `Analyze this business and write the outreach email.\n\n${businessBrief}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      logger.warn("Model declined to generate a pitch", {
        business: lead.name,
        category: response.stop_details?.category,
      });
      return { ...lead, pitch: null };
    }

    const pitch = response.parsed_output;
    if (!pitch) {
      throw new Error(`No structured pitch returned for ${lead.name}`);
    }

    logger.info("Pitch generated", {
      business: lead.name,
      fitScore: pitch.fitScore,
      automations: pitch.automations.length,
    });

    return { ...lead, pitch };
  },
});
