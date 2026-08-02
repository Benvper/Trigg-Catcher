import { task, logger } from "@trigger.dev/sdk";

/**
 * Finds small-to-medium businesses in the NJ / NY metro area using the
 * Google Places API (New) Text Search endpoint.
 *
 * Search targets rotate week to week so consecutive Mondays surface
 * different businesses instead of the same top results every time.
 */

export type Business = {
  placeId: string;
  name: string;
  address: string;
  website: string;
  domain: string;
  phone: string | null;
  rating: number | null;
  reviewCount: number | null;
  vertical: string;
  category: string;
  city: string;
};

/** Cities across the NJ / NY metro area, rotated weekly. */
const CITIES = [
  "Newark NJ",
  "Jersey City NJ",
  "Hoboken NJ",
  "Montclair NJ",
  "Morristown NJ",
  "Princeton NJ",
  "Edison NJ",
  "New Brunswick NJ",
  "Hackensack NJ",
  "Paramus NJ",
  "Cherry Hill NJ",
  "Brooklyn NY",
  "Queens NY",
  "White Plains NY",
  "Yonkers NY",
  "New Rochelle NY",
  "Long Island City NY",
  "Huntington NY",
];

/** Business categories per vertical, phrased as Google Places search terms. */
const VERTICALS: Record<string, string[]> = {
  professional: [
    "law firm",
    "accounting firm",
    "insurance agency",
    "real estate brokerage",
    "financial advisor office",
    "title company",
  ],
  home_services: [
    "HVAC contractor",
    "plumbing company",
    "electrical contractor",
    "roofing contractor",
    "landscaping company",
    "pest control company",
  ],
  healthcare: [
    "dental practice",
    "med spa",
    "chiropractor",
    "physical therapy clinic",
    "veterinary clinic",
    "optometrist office",
  ],
  retail: [
    "hair salon",
    "gym",
    "restaurant",
    "auto repair shop",
    "florist",
    "dry cleaner",
  ],
};

/**
 * National chains and franchises. These have corporate IT departments and no
 * authority to buy at the location level, so they are not sellable leads.
 */
const CHAIN_DOMAINS = [
  "statefarm.com",
  "allstate.com",
  "geico.com",
  "farmers.com",
  "remax.com",
  "coldwellbanker.com",
  "century21.com",
  "kw.com",
  "compass.com",
  "sothebysrealty.com",
  "aspendental.com",
  "smiledirectclub.com",
  "massageenvy.com",
  "supercuts.com",
  "greatclips.com",
  "planetfitness.com",
  "anytimefitness.com",
  "orangetheory.com",
  "jiffylube.com",
  "midas.com",
  "meineke.com",
  "aamco.com",
  "servpro.com",
  "rotorooter.com",
  "terminix.com",
  "orkin.com",
  "hrblock.com",
  "jacksonhewitt.com",
  "mcdonalds.com",
  "starbucks.com",
  "subway.com",
  "dunkindonuts.com",
  "chipotle.com",
  "bankofamerica.com",
  "chase.com",
  "wellsfargo.com",
];

/** Free website builders and social pages — no real domain to enrich. */
const NON_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "wixsite.com",
  "squarespace.com",
  "godaddysites.com",
  "business.site",
  "wordpress.com",
  "weebly.com",
  "yelp.com",
  "google.com",
];

type PlacesResponse = {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    websiteUri?: string;
    nationalPhoneNumber?: string;
    rating?: number;
    userRatingCount?: number;
    primaryTypeDisplayName?: { text?: string };
  }>;
};

/** ISO week number — drives the deterministic weekly rotation. */
function isoWeek(date: Date): number {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Extracts a bare registrable domain from a website URL. */
function toDomain(websiteUri: string): string | null {
  try {
    const host = new URL(websiteUri).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

async function searchPlaces(
  apiKey: string,
  textQuery: string,
): Promise<PlacesResponse> {
  const response = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Field mask controls both the response shape and the billing SKU.
        // Volume here is ~32 calls/month, far inside the free allowance.
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.websiteUri",
          "places.nationalPhoneNumber",
          "places.rating",
          "places.userRatingCount",
          "places.primaryTypeDisplayName",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery,
        pageSize: 20,
        regionCode: "US",
        languageCode: "en",
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Google Places search failed (${response.status}) for "${textQuery}": ${body}`,
    );
  }

  return (await response.json()) as PlacesResponse;
}

export const discoverBusinesses = task({
  id: "discover-businesses",
  run: async (payload: { targetCount: number; verticals: string[] }) => {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_PLACES_API_KEY is not set");

    const week = isoWeek(new Date());
    const verticals = payload.verticals.filter((v) => v in VERTICALS);
    if (verticals.length === 0) {
      throw new Error(
        `No valid verticals. Got "${payload.verticals.join(",")}", expected some of: ${Object.keys(VERTICALS).join(", ")}`,
      );
    }

    // Build this week's search list: one city+category pair per vertical,
    // stepped by week number so the targets move every Monday.
    const searches = verticals.flatMap((vertical, vIndex) => {
      const categories = VERTICALS[vertical];
      return [0, 1].map((offset) => {
        const seed = week * 3 + vIndex * 5 + offset * 7;
        const city = CITIES[seed % CITIES.length];
        const category = categories[seed % categories.length];
        return { vertical, category, city, query: `${category} in ${city}` };
      });
    });

    logger.info("Searching Google Places", {
      week,
      searchCount: searches.length,
      queries: searches.map((s) => s.query),
    });

    const seenDomains = new Set<string>();
    const businesses: Business[] = [];

    for (const search of searches) {
      const result = await searchPlaces(apiKey, search.query);
      const places = result.places ?? [];

      for (const place of places) {
        const website = place.websiteUri;
        const name = place.displayName?.text;
        if (!website || !name || !place.id) continue;

        const domain = toDomain(website);
        if (!domain) continue;

        // One lead per company, even if it appears in several searches.
        if (seenDomains.has(domain)) continue;

        // Skip national chains — no local buying authority.
        if (CHAIN_DOMAINS.some((c) => domain === c || domain.endsWith(`.${c}`)))
          continue;

        // Skip social pages and site builders — nothing for Hunter to search.
        if (NON_DOMAINS.some((n) => domain === n || domain.endsWith(`.${n}`)))
          continue;

        seenDomains.add(domain);
        businesses.push({
          placeId: place.id,
          name,
          address: place.formattedAddress ?? "",
          website,
          domain,
          phone: place.nationalPhoneNumber ?? null,
          rating: place.rating ?? null,
          reviewCount: place.userRatingCount ?? null,
          vertical: search.vertical,
          category: search.category,
          city: search.city,
        });
      }
    }

    // An established business with real reviews is more likely to have budget
    // and a real operational workload. Sort by review count, richest first.
    businesses.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));

    // Interleave verticals so one category can't monopolise the whole digest.
    const byVertical = new Map<string, Business[]>();
    for (const b of businesses) {
      const list = byVertical.get(b.vertical) ?? [];
      list.push(b);
      byVertical.set(b.vertical, list);
    }

    const balanced: Business[] = [];
    let exhausted = false;
    while (balanced.length < payload.targetCount && !exhausted) {
      exhausted = true;
      for (const list of byVertical.values()) {
        const next = list.shift();
        if (!next) continue;
        exhausted = false;
        balanced.push(next);
        if (balanced.length >= payload.targetCount) break;
      }
    }

    logger.info("Discovery complete", {
      found: businesses.length,
      selected: balanced.length,
    });

    return { businesses: balanced, totalFound: businesses.length, week };
  },
});
