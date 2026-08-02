import { task, logger } from "@trigger.dev/sdk";
import type { Business } from "./discover-businesses.js";

/**
 * Finds a decision-maker's name, email, and (when available) LinkedIn URL for
 * each business.
 *
 * Small local businesses frequently have no email indexed in Hunter's
 * database at all — only a phone number is public. So each business gets a
 * free pass first: fetch its own homepage and look for a listed email
 * address directly, at zero cost. Only when that fails does it spend a
 * Hunter.io domain-search credit, and only until enough emailed leads have
 * already been found for the week — phone-only businesses are dropped
 * before the digest is built, since a lead with no email is not usable for
 * an email outreach campaign.
 */

export type EnrichedLead = Business & {
  contactName: string | null;
  contactPosition: string | null;
  contactEmail: string | null;
  emailConfidence: number | null;
  emailType: "personal" | "generic" | null;
  emailSource: "website" | "hunter" | null;
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

/** Generic role addresses to deprioritize when a better option exists. */
const GENERIC_LOCAL_PARTS = [
  "noreply",
  "no-reply",
  "donotreply",
  "webmaster",
  "postmaster",
  "privacy",
  "abuse",
  "unsubscribe",
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

/**
 * Fetches a business's own homepage and looks for a listed email address on
 * the same domain — free, no Hunter credit spent. Many small business sites
 * publish an email directly (footer, contact section) that Hunter's index
 * doesn't have.
 */
async function scrapeEmailFromWebsite(
  website: string,
  domain: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(website, {
      signal: controller.signal,
      headers: { "User-Agent": "trigger-lead-finder/1.0" },
    });
    if (!response.ok) return null;

    const html = await response.text();
    const matches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];

    // Only trust addresses on the business's own domain — a page can easily
    // reference third-party emails (widgets, social share links, etc.).
    const ownDomainMatches = matches.filter((email) =>
      email.toLowerCase().endsWith(`@${domain.toLowerCase()}`),
    );
    if (ownDomainMatches.length === 0) return null;

    const preferred = ownDomainMatches.find(
      (email) =>
        !GENERIC_LOCAL_PARTS.some((generic) =>
          email.toLowerCase().startsWith(`${generic}@`),
        ),
    );
    return preferred ?? ownDomainMatches[0];
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

async function tryHunter(
  business: Business,
  apiKey: string,
): Promise<{
  contactEmail: string | null;
  contactName: string | null;
  contactPosition: string | null;
  emailConfidence: number | null;
  emailType: "personal" | "generic" | null;
  linkedinUrl: string | null;
  organization: string | null;
  note: string;
}> {
  try {
    const url = new URL("https://api.hunter.io/v2/domain-search");
    url.searchParams.set("domain", business.domain);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("limit", "10");

    const response = await fetch(url);
    const body = (await response.json()) as HunterDomainSearch;

    if (!response.ok) {
      const detail = body.errors?.[0]?.details ?? `HTTP ${response.status}`;
      logger.warn("Hunter lookup failed", { domain: business.domain, detail });
      return {
        contactEmail: null,
        contactName: null,
        contactPosition: null,
        emailConfidence: null,
        emailType: null,
        linkedinUrl: null,
        organization: null,
        note: `Email lookup failed (${detail}) — use the phone number or contact form.`,
      };
    }

    const emails = body.data?.emails ?? [];
    if (emails.length === 0) {
      return {
        contactEmail: null,
        contactName: null,
        contactPosition: null,
        emailConfidence: null,
        emailType: null,
        linkedinUrl: null,
        organization: body.data?.organization ?? null,
        note: "No public email on this domain — use the phone number or the site's contact form.",
      };
    }

    const best = [...emails].sort((a, b) => scoreContact(b) - scoreContact(a))[0];
    const contactName =
      [best.first_name, best.last_name].filter(Boolean).join(" ") || null;

    return {
      contactEmail: best.value ?? null,
      contactName,
      contactPosition: best.position ?? null,
      emailConfidence: best.confidence ?? null,
      emailType:
        best.type === "personal" || best.type === "generic" ? best.type : null,
      linkedinUrl: best.linkedin ?? null,
      organization: body.data?.organization ?? null,
      note: contactName ? "" : "Generic inbox only — no named contact found on this domain.",
    };
  } catch (error) {
    logger.warn("Hunter lookup threw", { domain: business.domain, error: String(error) });
    return {
      contactEmail: null,
      contactName: null,
      contactPosition: null,
      emailConfidence: null,
      emailType: null,
      linkedinUrl: null,
      organization: null,
      note: "Email lookup errored — use the phone number or the site's contact form.",
    };
  }
}

export const enrichContacts = task({
  id: "enrich-contacts",
  run: async (payload: { businesses: Business[]; targetCount: number }) => {
    const apiKey = process.env.HUNTER_API_KEY;
    if (!apiKey) throw new Error("HUNTER_API_KEY is not set");

    const reserve = Number(process.env.HUNTER_CREDIT_RESERVE ?? 0);
    const remaining = await getRemainingCredits(apiKey);
    const budget =
      remaining === null ? payload.businesses.length : Math.max(0, remaining - reserve);

    logger.info("Enrichment starting", {
      businesses: payload.businesses.length,
      targetCount: payload.targetCount,
      hunterBudget: budget,
    });

    const leads: EnrichedLead[] = [];
    let hunterSpent = 0;
    let emailedCount = 0;

    for (const business of payload.businesses) {
      // Once enough emailed leads exist for the week, stop spending Hunter
      // credits — a free scrape attempt still runs (it's free), but a miss
      // there just drops the business rather than burning a credit on it.
      const enoughAlready = emailedCount >= payload.targetCount;

      const scraped = await scrapeEmailFromWebsite(business.website, business.domain);

      const base: EnrichedLead = {
        ...business,
        contactName: null,
        contactPosition: null,
        contactEmail: null,
        emailConfidence: null,
        emailType: null,
        emailSource: null,
        linkedinUrl: null,
        linkedinSearchUrl: linkedinSearch(null, business.name),
        organization: null,
        enriched: false,
        enrichmentNote: "",
      };

      if (scraped) {
        emailedCount += 1;
        leads.push({
          ...base,
          contactEmail: scraped,
          emailSource: "website",
          linkedinSearchUrl: linkedinSearch(null, business.name),
          enriched: true,
        });
        continue;
      }

      if (enoughAlready || hunterSpent >= budget) {
        leads.push({
          ...base,
          enrichmentNote:
            hunterSpent >= budget
              ? "Hunter credits exhausted for this month — no email found."
              : "No email found — skipped further lookup, enough leads already found this week.",
        });
        continue;
      }

      hunterSpent += 1;
      const result = await tryHunter(business, apiKey);
      if (result.contactEmail) emailedCount += 1;

      leads.push({
        ...base,
        contactName: result.contactName,
        contactPosition: result.contactPosition,
        contactEmail: result.contactEmail,
        emailConfidence: result.emailConfidence,
        emailType: result.emailType,
        emailSource: result.contactEmail ? "hunter" : null,
        linkedinUrl: result.linkedinUrl,
        linkedinSearchUrl: linkedinSearch(result.contactName, business.name),
        organization: result.organization,
        enriched: Boolean(result.contactEmail),
        enrichmentNote: result.note,
      });
    }

    // A phone-only lead can't be used for an email outreach campaign — drop
    // it rather than sending an unusable lead in the digest.
    const emailedLeads = leads
      .filter((l) => l.contactEmail)
      .slice(0, payload.targetCount);

    logger.info("Enrichment complete", {
      processed: leads.length,
      withEmail: leads.filter((l) => l.contactEmail).length,
      delivered: emailedLeads.length,
      hunterSpent,
    });

    return { leads: emailedLeads, creditsSpent: hunterSpent, creditsRemaining: remaining };
  },
});
