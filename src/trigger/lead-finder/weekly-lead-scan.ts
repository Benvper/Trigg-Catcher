import { schedules, logger } from "@trigger.dev/sdk";
import { discoverBusinesses } from "./discover-businesses.js";
import { enrichContacts } from "./enrich-contact.js";
import { generatePitch, type PitchedLead } from "./generate-pitch.js";
import { sendDigest } from "./send-digest.js";

/**
 * Runs every Monday at 8:00 AM Eastern.
 *
 * discover (Google Places) -> enrich (Hunter.io) -> pitch (Claude Opus 5)
 * -> digest email (Resend)
 */

const VALID_VERTICALS = [
  "professional",
  "home_services",
  "healthcare",
  "retail",
];

export const weeklyLeadScan = schedules.task({
  id: "weekly-lead-scan",
  cron: {
    pattern: "0 8 * * 1",
    // Handles EST/EDT automatically — 8 AM local year round.
    timezone: "America/New_York",
  },
  maxDuration: 900,

  run: async () => {
    const targetCount = Number(process.env.LEADS_PER_WEEK ?? 10);

    const verticals = (
      process.env.TARGET_VERTICALS ??
      "professional,home_services,healthcare,retail"
    )
      .split(",")
      .map((v) => v.trim())
      .filter((v) => VALID_VERTICALS.includes(v));

    if (verticals.length === 0) {
      throw new Error(
        `TARGET_VERTICALS contained no valid entries. Valid options: ${VALID_VERTICALS.join(", ")}`,
      );
    }

    logger.info("Starting weekly lead scan", { targetCount, verticals });

    // --- 1. Find businesses -----------------------------------------
    const discovery = await discoverBusinesses.triggerAndWait({
      targetCount,
      verticals,
    });

    if (!discovery.ok) {
      logger.error("Discovery failed", { error: discovery.error });
      throw new Error(`Business discovery failed: ${discovery.error}`);
    }

    const { businesses, totalFound, week } = discovery.output;

    if (businesses.length === 0) {
      logger.warn("No businesses found this week — sending an empty digest");
      await sendDigest.triggerAndWait({
        leads: [],
        creditsRemaining: null,
        creditsSpent: 0,
        totalFound: 0,
      });
      return { leads: 0, note: "No businesses matched this week's searches." };
    }

    // --- 2. Find contact details ------------------------------------
    const enrichment = await enrichContacts.triggerAndWait({ businesses });

    if (!enrichment.ok) {
      logger.error("Enrichment failed", { error: enrichment.error });
      throw new Error(`Contact enrichment failed: ${enrichment.error}`);
    }

    const { leads, creditsSpent, creditsRemaining } = enrichment.output;

    // --- 3. Generate pitches in parallel ----------------------------
    // Never wrap triggerAndWait in Promise.all — batchTriggerAndWait is the
    // supported way to fan out and wait.
    const batch = await generatePitch.batchTriggerAndWait(
      leads.map((lead) => ({
        payload: { lead },
        options: {
          // Same business in the same week reuses the run instead of paying
          // for a second Claude call on retry.
          idempotencyKey: `pitch-${week}-${lead.placeId}`,
        },
      })),
    );

    // The SDK returns { runs: [...] }; older shapes return the array directly.
    const runs = Array.isArray(batch) ? batch : batch.runs;

    const pitched: PitchedLead[] = [];
    let failed = 0;

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.ok) {
        pitched.push(run.output);
      } else {
        // A failed pitch shouldn't cost you the whole lead — keep the
        // contact details and flag it in the digest.
        failed += 1;
        logger.warn("Pitch generation failed for a lead", {
          business: leads[i]?.name,
          error: run.error,
        });
        if (leads[i]) pitched.push({ ...leads[i], pitch: null });
      }
    }

    logger.info("Pitches complete", {
      total: pitched.length,
      failed,
    });

    // --- 4. Send the digest -----------------------------------------
    const digest = await sendDigest.triggerAndWait({
      leads: pitched,
      creditsRemaining,
      creditsSpent,
      totalFound,
    });

    if (!digest.ok) {
      logger.error("Digest send failed", { error: digest.error });
      throw new Error(`Digest email failed: ${digest.error}`);
    }

    return {
      week,
      businessesScreened: totalFound,
      leadsDelivered: pitched.length,
      withEmail: pitched.filter((l) => l.contactEmail).length,
      pitchesFailed: failed,
      hunterCreditsSpent: creditsSpent,
      emailId: digest.output.emailId,
    };
  },
});
