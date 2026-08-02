import { task, logger } from "@trigger.dev/sdk";

/**
 * Finds small-to-medium businesses in the NJ / NY metro area using the
 * OpenStreetMap Overpass API — no signup, no API key, no billing account of
 * any kind. Both Google Places and Foursquare required a credit card to get
 * past their sandbox tier, so discovery runs on OSM instead.
 *
 * Trade-off: OSM has no ratings or review counts, and fewer small businesses
 * have their website tagged than on Google or Foursquare, so some weeks
 * fewer than the target lead count will survive the domain filter.
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

type Bbox = [south: number, west: number, north: number, east: number];

/**
 * Cities across the NJ / NY metro area, rotated weekly. Bounding boxes are
 * approximate (roughly a 5-8km radius around the city center) — precision
 * doesn't matter here, just reasonable coverage of the town.
 */
const CITIES: Array<{ label: string; bbox: Bbox }> = [
  { label: "Newark NJ", bbox: [40.69, -74.23, 40.78, -74.11] },
  { label: "Jersey City NJ", bbox: [40.68, -74.1, 40.76, -73.98] },
  { label: "Hoboken NJ", bbox: [40.72, -74.06, 40.77, -74.0] },
  { label: "Montclair NJ", bbox: [40.79, -74.25, 40.86, -74.16] },
  { label: "Morristown NJ", bbox: [40.75, -74.53, 40.84, -74.43] },
  { label: "Princeton NJ", bbox: [40.31, -74.71, 40.4, -74.62] },
  { label: "Edison NJ", bbox: [40.47, -74.46, 40.57, -74.36] },
  { label: "New Brunswick NJ", bbox: [40.45, -74.5, 40.53, -74.4] },
  { label: "Hackensack NJ", bbox: [40.85, -74.09, 40.92, -74.0] },
  { label: "Paramus NJ", bbox: [40.9, -74.12, 40.98, -74.03] },
  { label: "Cherry Hill NJ", bbox: [39.89, -75.08, 39.98, -74.98] },
  // Brooklyn/Queens are narrowed to specific neighborhoods rather than the
  // whole borough — the full-borough boxes returned so many tagged
  // businesses for common categories that Overpass repeatedly timed out.
  { label: "Park Slope, Brooklyn NY", bbox: [40.66, -73.99, 40.68, -73.96] },
  { label: "Astoria, Queens NY", bbox: [40.75, -73.94, 40.78, -73.9] },
  { label: "White Plains NY", bbox: [41.0, -73.8, 41.07, -73.73] },
  { label: "Yonkers NY", bbox: [40.9, -73.94, 40.97, -73.85] },
  { label: "New Rochelle NY", bbox: [40.87, -73.82, 40.95, -73.74] },
  { label: "Long Island City NY", bbox: [40.73, -73.97, 40.76, -73.92] },
  { label: "Huntington NY", bbox: [40.83, -73.47, 40.91, -73.38] },
];

/**
 * Business categories per vertical, mapped to OpenStreetMap tag filters.
 * `label` is the human-readable category shown in the digest; `filter` is
 * the Overpass QL tag match used to actually query OSM.
 */
const VERTICALS: Record<string, Array<{ label: string; filter: string }>> = {
  professional: [
    { label: "law firm", filter: '["office"="lawyer"]' },
    { label: "accounting firm", filter: '["office"="accountant"]' },
    { label: "insurance agency", filter: '["office"="insurance"]' },
    { label: "real estate brokerage", filter: '["office"="estate_agent"]' },
    { label: "financial advisor office", filter: '["office"="financial_advisor"]' },
    { label: "tax preparation service", filter: '["office"="tax_advisor"]' },
  ],
  home_services: [
    { label: "HVAC contractor", filter: '["craft"="hvac"]' },
    { label: "plumbing company", filter: '["craft"="plumber"]' },
    { label: "electrical contractor", filter: '["craft"="electrician"]' },
    { label: "roofing contractor", filter: '["craft"="roofer"]' },
    { label: "landscaping company", filter: '["craft"="gardener"]' },
    { label: "locksmith", filter: '["shop"="locksmith"]' },
  ],
  healthcare: [
    { label: "dental practice", filter: '["amenity"="dentist"]' },
    { label: "med spa", filter: '["shop"="beauty"]' },
    { label: "chiropractor", filter: '["healthcare"="chiropractor"]' },
    { label: "physical therapy clinic", filter: '["healthcare"="physiotherapist"]' },
    { label: "veterinary clinic", filter: '["amenity"="veterinary"]' },
    { label: "optometrist office", filter: '["healthcare"="optometrist"]' },
  ],
  retail: [
    { label: "hair salon", filter: '["shop"="hairdresser"]' },
    { label: "gym", filter: '["leisure"="fitness_centre"]' },
    { label: "restaurant", filter: '["amenity"="restaurant"]' },
    { label: "auto repair shop", filter: '["shop"="car_repair"]' },
    { label: "florist", filter: '["shop"="florist"]' },
    { label: "dry cleaner", filter: '["shop"="dry_cleaning"]' },
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

type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
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
function toDomain(rawUrl: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** Builds a readable address from whatever addr:* tags OSM has on file. */
function formatAddress(tags: Record<string, string>): string {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:city"],
    [tags["addr:state"], tags["addr:postcode"]].filter(Boolean).join(" "),
  ].filter(Boolean);
  return parts.join(", ");
}

// Confirmed by direct testing: overpass-api.de is the one public mirror that
// actually responds from this network. The other common public mirrors
// (kumi.systems, openstreetmap.ru) either hang without responding or are
// unreachable outright — falling through to them only wasted time.
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

async function searchOverpass(
  filter: string,
  bbox: Bbox,
  attempt = 1,
): Promise<OverpassResponse> {
  const [south, west, north, east] = bbox;
  const box = `${south},${west},${north},${east}`;
  const query = `[out:json][timeout:25];(node${filter}(${box});way${filter}(${box}););out center 30;`;

  // A stuck connection with no timeout can hang far longer than any retry
  // backoff accounts for — bound every request explicitly instead.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        // Overpass's public server asks non-browser clients to self-identify.
        "User-Agent": "trigger-lead-finder/1.0",
      },
      body: query,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (attempt < 4) {
      const delayMs = attempt * 6_000;
      logger.warn("Overpass request failed, retrying", {
        filter,
        attempt,
        delayMs,
        error: String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return searchOverpass(filter, bbox, attempt + 1);
    }
    throw error;
  }
  clearTimeout(timeout);

  if (!response.ok) {
    if ((response.status === 429 || response.status === 504) && attempt < 4) {
      const delayMs = attempt * 6_000;
      logger.warn("Overpass busy, retrying", {
        status: response.status,
        filter,
        attempt,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return searchOverpass(filter, bbox, attempt + 1);
    }

    const body = await response.text();
    throw new Error(
      `Overpass search failed (${response.status}) for filter ${filter}: ${body.slice(0, 300)}`,
    );
  }

  return (await response.json()) as OverpassResponse;
}

export const discoverBusinesses = task({
  id: "discover-businesses",
  // More searches per run (scaled to targetCount) means more headroom is
  // needed than the 900s project default, especially if Overpass needs
  // retries on several of them.
  maxDuration: 1500,
  run: async (payload: { targetCount: number; verticals: string[] }) => {
    const week = isoWeek(new Date());
    const verticals = payload.verticals.filter((v) => v in VERTICALS);
    if (verticals.length === 0) {
      throw new Error(
        `No valid verticals. Got "${payload.verticals.join(",")}", expected some of: ${Object.keys(VERTICALS).join(", ")}`,
      );
    }

    // Build this week's search list: several city+category pairs per
    // vertical, stepped by week number so the targets move every Monday.
    // Scales with targetCount — a fixed 2-per-vertical search count caps
    // the raw candidate pool no matter how many leads are requested, since
    // many OSM entries have no website tag and get filtered out downstream.
    // Bounded at 6/vertical so a single discovery run stays well inside
    // the task's maxDuration even when every search needs a retry.
    const offsetsPerVertical = Math.min(
      6,
      Math.max(2, Math.ceil(payload.targetCount / verticals.length / 3)),
    );
    const searches = verticals.flatMap((vertical, vIndex) => {
      const categories = VERTICALS[vertical];
      return Array.from({ length: offsetsPerVertical }, (_, offset) => {
        const seed = week * 3 + vIndex * 5 + offset * 7;
        const city = CITIES[seed % CITIES.length];
        const category = categories[seed % categories.length];
        return { vertical, category, city };
      });
    });

    logger.info("Searching OpenStreetMap", {
      week,
      searchCount: searches.length,
      queries: searches.map((s) => `${s.category.label} near ${s.city.label}`),
    });

    const seenDomains = new Set<string>();
    const businesses: Business[] = [];

    for (const search of searches) {
      const result = await searchOverpass(search.category.filter, search.city.bbox);
      const elements = result.elements ?? [];

      for (const element of elements) {
        const tags = element.tags;
        const name = tags?.name;
        const rawWebsite = tags?.website ?? tags?.["contact:website"];
        if (!tags || !name || !rawWebsite) continue;

        const domain = toDomain(rawWebsite);
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
          placeId: `osm-${element.type}-${element.id}`,
          name,
          address: formatAddress(tags),
          website: /^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`,
          domain,
          phone: tags.phone ?? tags["contact:phone"] ?? null,
          // OSM carries no rating or review data.
          rating: null,
          reviewCount: null,
          vertical: search.vertical,
          category: search.category.label,
          city: search.city.label,
        });
      }

      // Be a polite citizen of the free, shared public Overpass server.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

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
