// Deterministic lead scoring. No model call, so it costs nothing and it is
// the same answer every time, which is what makes it testable and auditable.
//
// The weight ladder lives in the industry profile: a dental program can pay
// for review count while an enterprise program pays for a named owner.

import type { ScoringConfig } from "./config.js";
import type { Lead } from "./types.js";

export function scoreLead(lead: Lead, config: ScoringConfig): number {
  const w = config.weights;
  let score = 0;

  if (lead.email) score += w.hasEmail ?? 0;
  if (lead.contactTrack === "owner") score += w.trackOwner ?? 0;
  else if (lead.contactTrack === "general") score += w.trackGeneral ?? 0;
  if (lead.phone) score += w.hasPhone ?? 0;
  if (lead.website) score += w.hasWebsite ?? 0;

  // Tiers stack: a 4.6 rating earns both the 4.0 and the 4.5 band.
  for (const [threshold, points] of Object.entries(w.ratingAbove ?? {})) {
    if ((lead.rating ?? 0) >= Number(threshold)) score += points;
  }
  for (const [threshold, points] of Object.entries(w.reviewsAbove ?? {})) {
    if ((lead.reviewCount ?? 0) >= Number(threshold)) score += points;
  }

  return Math.max(0, Math.min(score, 100));
}
