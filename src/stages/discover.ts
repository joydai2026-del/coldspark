// Stage 1: discover.
//
// Ask the lead source for companies matching the profile's queries, then drop
// anything the ICP filter rejects, anything already in the store, and any
// domain a previous run gave up on.

import type { IndustryProfile } from "../core/config.js";
import { DroppedDomains, passesIcpFilter } from "../core/icp.js";
import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import type { Lead, StageResult } from "../core/types.js";
import type { LeadSource } from "../ports/index.js";

export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
}

export async function discover(
  profile: IndustryProfile,
  source: LeadSource,
  store: LeadStore,
  dropped: DroppedDomains,
): Promise<StageResult> {
  const stats = {
    returned: 0,
    icp_rejected: 0,
    below_rating_floor: 0,
    already_known: 0,
    previously_dropped: 0,
    added: 0,
  };
  const notes: string[] = [];

  if (!source.available) {
    notes.push(`lead source "${source.providerId}" is not configured, nothing discovered`);
    return { stage: "discover", stats, notes };
  }

  const seenThisRun = new Set(store.all().map((l) => l.domain));

  for (const query of profile.discovery.queries) {
    const found = await source.search(query, profile.discovery.location, profile.discovery.limit);
    stats.returned += found.length;

    for (const company of found) {
      const domain = normalizeDomain(company.domain || company.website || "");
      if (!domain) continue;

      if (!passesIcpFilter(company.companyName, profile.icp.blockTokens, profile.icp.blockPhrases)) {
        stats.icp_rejected += 1;
        continue;
      }
      const minRating = profile.icp.minRating;
      const minReviews = profile.icp.minReviews;
      if (
        (minRating !== undefined && (company.rating ?? 0) < minRating) ||
        (minReviews !== undefined && (company.reviewCount ?? 0) < minReviews)
      ) {
        stats.below_rating_floor += 1;
        continue;
      }
      if (dropped.has(domain)) {
        stats.previously_dropped += 1;
        continue;
      }
      if (seenThisRun.has(domain)) {
        stats.already_known += 1;
        continue;
      }

      const lead: Lead = {
        id: `lead_${domain.replace(/[^a-z0-9]+/g, "_")}`,
        companyName: company.companyName,
        domain,
        website: company.website,
        phone: company.phone,
        rating: company.rating,
        reviewCount: company.reviewCount,
        lifecycle: "new",
        contactTrack: "manual_review",
        score: 0,
        email: company.email,
        sent: [],
        tags: [],
      };
      store.upsert(lead);
      seenThisRun.add(domain);
      stats.added += 1;
    }
  }

  log.info("discover complete", stats);
  return { stage: "discover", stats, notes };
}
