import { task, logger } from "@trigger.dev/sdk";
import type { Business } from "./discover-businesses.js";

/**
 * Finds a decision-maker's name, email, and (when available) LinkedIn URL for
 * each business using Hunter.io's domain-search endpoint.
 *
 * Hunter's free plan allows 25 domain searches per month. This task asks
 * Hunter how many credits are actually left before spending any, then stops
 * cleanly when they run out — businesses past that point are still returned,
 * just without an email, so they stay in the digest with their phone number.
 */

export type EnrichedLead = Business & {
  contactName: string | null;
  contactPosition: string | null;
  contactEmail: string | null;
  emailConfidence: number | null;
  emailType: "personal" | "generic" | null;
  linkedinUrl: string | null;
  linkedinSearchUrl: string;
  organization: string | null;
  enriched: boolean;
  enrichmentNote: string;
};

type HunterAccount = {
  data?: {
    requests?: { searches?: { used?: number; available?: number } };
  };
};

type HunterEmail = {
  value?: string;
  type?: string;
  confidence?: number;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null;
  department?: string | null;
  linkedin?: string | null;
};

type HunterDomainSearch = {
  data?: { organization?: string | null; emails?: HunterEmail[] };
  errors?: Array<{ details?: string }>;
};

/** Titles that indicate someone who can actually approve a purchase. */
const DECISION_MAKER_TITLES = [
  "owner",
  "founder",
  "co-founder",
  "president",
  "principal",
  "partner",
  "ceo",
  "managing director",
  "managing partner",
  "practice manager",
  "office manager",
  "operations manager",
  "general manager",
  "director",
];

/** Ranks a Hunter contact by how likely they are to be the buyer. */
function scoreContact(email: HunterEmail): number {
  let score = 0;

  const position = (email.position ?? "").toLowerCase();
  const titleIndex = DECISION_MAKER_TITLES.findIndex((t) =>
    position.includes(t),
  );
  if (titleIndex !== -1) {
    // Earlier entries in the list outrank later ones.
    score += 100 - titleIndex * 5;
  }

  const seniority = (email.seniority ?? "").toLowerCase();
  if (seniority === "executive") score += 40;
  else if (seniority === "senior") score += 20;

  // A named human beats info@ / contact@ every time.
  if (email.type === "personal") score += 30;
  if (email.first_name) score += 15;
  if (email.linkedin) score += 10;

  score += (email.confidence ?? 0) / 10;

  return score;
}

/** Pre-filled LinkedIn people search — one click to the likely profile. */
function linkedinSearch(name: string | null, company: string): string {
  const query = [name, company].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`;
}

async function getRemainingCredits(apiKey: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(apiKey)}`,
    );
    if (!response.ok) return null;

    const body = (await response.json()) as HunterAccount;
    const searches = body.data?.requests?.searches;
    if (
      typeof searches?.available !== "number" ||
      typeof searches?.used !== "number"
    ) {
      return null;
    }
    return Math.max(0, searches.available - searches.used);
  } catch (error) {
    logger.warn("Could not read Hunter credit balance", { error: String(error) });
    return null;
  }
}

export const enrichContacts = task({
  id: "enrich-contacts",
  run: async (payload: { businesses: Business[] }) => {
    const apiKey = process.env.HUNTER_API_KEY;
    if (!apiKey) throw new Error("HUNTER_API_KEY is not set");

    const reserve = Number(process.env.HUNTER_CREDIT_RESERVE ?? 0);
    const remaining = await getRemainingCredits(apiKey);

    // If the balance can't be read, fall back to the count we want anyway —
    // Hunter returns a clear error per call once credits are exhausted.
    const budget =
      remaining === null
        ? payload.businesses.length
        : Math.max(0, remaining - reserve);

    logger.info("Hunter credit budget", {
      remaining,
      reserve,
      budget,
      businesses: payload.businesses.length,
    });

    const leads: EnrichedLead[] = [];
    let spent = 0;

    for (const business of payload.businesses) {
      const base: EnrichedLead = {
        ...business,
        contactName: null,
        contactPosition: null,
        contactEmail: null,
        emailConfidence: null,
        emailType: null,
        linkedinUrl: null,
        linkedinSearchUrl: linkedinSearch(null, business.name),
        organization: null,
        enriched: false,
        enrichmentNote: "",
      };

      if (spent >= budget) {
        leads.push({
          ...base,
          enrichmentNote:
            "Hunter credits exhausted for this month — use the phone number or the site's contact form.",
        });
        continue;
      }

      spent += 1;

      try {
        const url = new URL("https://api.hunter.io/v2/domain-search");
        url.searchParams.set("domain", business.domain);
        url.searchParams.set("api_key", apiKey);
        url.searchParams.set("limit", "10");

        const response = await fetch(url);
        const body = (await response.json()) as HunterDomainSearch;

        if (!response.ok) {
          const detail = body.errors?.[0]?.details ?? `HTTP ${response.status}`;
          logger.warn("Hunter lookup failed", {
            domain: business.domain,
            detail,
          });
          leads.push({
            ...base,
            enrichmentNote: `Email lookup failed (${detail}) — use the phone number or contact form.`,
          });
          continue;
        }

        const emails = body.data?.emails ?? [];
        if (emails.length === 0) {
          leads.push({
            ...base,
            organization: body.data?.organization ?? null,
            enrichmentNote:
              "No public email on this domain — use the phone number or the site's contact form.",
          });
          continue;
        }

        const best = [...emails].sort((a, b) => scoreContact(b) - scoreContact(a))[0];
        const contactName =
          [best.first_name, best.last_name].filter(Boolean).join(" ") || null;

        leads.push({
          ...base,
          contactName,
          contactPosition: best.position ?? null,
          contactEmail: best.value ?? null,
          emailConfidence: best.confidence ?? null,
          emailType:
            best.type === "personal" || best.type === "generic"
              ? best.type
              : null,
          linkedinUrl: best.linkedin ?? null,
          linkedinSearchUrl: linkedinSearch(contactName, business.name),
          organization: body.data?.organization ?? null,
          enriched: Boolean(best.value),
          enrichmentNote: contactName
            ? ""
            : "Generic inbox only — no named contact found on this domain.",
        });
      } catch (error) {
        logger.warn("Hunter lookup threw", {
          domain: business.domain,
          error: String(error),
        });
        leads.push({
          ...base,
          enrichmentNote:
            "Email lookup errored — use the phone number or the site's contact form.",
        });
      }
    }

    const enrichedCount = leads.filter((l) => l.enriched).length;
    logger.info("Enrichment complete", {
      total: leads.length,
      enriched: enrichedCount,
      creditsSpent: spent,
    });

    return { leads, creditsSpent: spent, creditsRemaining: remaining };
  },
});
