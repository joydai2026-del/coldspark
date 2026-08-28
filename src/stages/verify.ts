// Stage 3: verify and route.
//
// This is the safety boundary of the whole engine. It decides, per lead,
// which address is used and whether a human has to look first.
//
// Routing rules, in order:
//   0. Verifier unavailable and the profile is fail-closed  -> manual_review
//      (never silently fall open to sending unverified mail)
//   1. Enriched personal address verifies valid             -> owner track
//   2. Enriched address invalid and no role fallback        -> drop the lead,
//      and remember the domain so the next run does not pay for it again
//   3. Role mailbox verifies valid                          -> general track,
//      name and title cleared, because the person is no longer the recipient
//   4. Anything risky or a provider failure                 -> manual_review
//
// After routing, the lead is scored and either qualified into the sequence or
// disqualified below the profile's threshold.

import type { IndustryProfile } from "../core/config.js";
import type { DroppedDomains } from "../core/icp.js";
import { canTransition } from "../core/lifecycle.js";
import { log } from "../core/logger.js";
import { scoreLead } from "../core/scoring.js";
import type { LeadStore } from "../core/store.js";
import type { ContactTrack, EmailVerdict, EnrichedContact, StageResult } from "../core/types.js";
import type { EmailVerifier } from "../ports/index.js";

export interface RouteDecision {
  decision: "write" | "drop";
  track?: ContactTrack;
  email?: string;
  contactName?: string;
  contactTitle?: string;
  verdict?: EmailVerdict;
  tag?: string;
}

/** Pure routing decision. Exported so the whole rule set is unit testable. */
export async function routeContact(
  enriched: EnrichedContact | null,
  roleEmail: string | undefined,
  verifier: Pick<EmailVerifier, "available" | "verify">,
  policy: { failClosed: boolean; riskyPolicy: "manual_review" | "drop" },
): Promise<RouteDecision> {
  if (!verifier.available) {
    if (!policy.failClosed) {
      return {
        decision: "write",
        track: roleEmail ? "general" : "manual_review",
        email: roleEmail ?? "",
        contactName: "",
        contactTitle: "",
        tag: "verifier:unavailable",
      };
    }
    return {
      decision: "write",
      track: "manual_review",
      email: enriched?.email ?? roleEmail ?? "",
      contactName: "",
      contactTitle: "",
      tag: "verifier:unavailable",
    };
  }

  const risky = (email: string, name: string, title: string, verdict: EmailVerdict): RouteDecision =>
    policy.riskyPolicy === "drop"
      ? { decision: "drop", verdict }
      : {
          decision: "write",
          track: "manual_review",
          email,
          contactName: name,
          contactTitle: title,
          verdict,
          tag: `verdict:${verdict}`,
        };

  if (enriched?.email) {
    const verdict = await verifier.verify(enriched.email);
    const fullName = `${enriched.firstName} ${enriched.lastName}`.trim();
    if (verdict === "valid") {
      return {
        decision: "write",
        track: "owner",
        email: enriched.email,
        contactName: fullName,
        contactTitle: enriched.title,
        verdict,
      };
    }
    if (verdict === "invalid") {
      if (!roleEmail) return { decision: "drop", verdict };
      // Fall through and try the role mailbox.
    } else {
      return risky(enriched.email, fullName, enriched.title, verdict);
    }
  }

  if (roleEmail) {
    const verdict = await verifier.verify(roleEmail);
    if (verdict === "valid") {
      // Name and title are cleared on purpose. The enriched person is not the
      // recipient of a role mailbox, so their name must not reach the copy.
      return {
        decision: "write",
        track: "general",
        email: roleEmail,
        contactName: "",
        contactTitle: "",
        verdict,
      };
    }
    if (verdict === "invalid") return { decision: "drop", verdict };
    return risky(roleEmail, "", "", verdict);
  }

  return {
    decision: "write",
    track: "manual_review",
    email: "",
    contactName: "",
    contactTitle: "",
    tag: "no_address",
  };
}

/**
 * An owner-track lead needs a full name and a title, otherwise "Hi {first_name}"
 * renders hollow. Demote rather than send a broken greeting.
 */
export function ownerTrackIsUsable(contactName?: string, contactTitle?: string): boolean {
  return Boolean(contactName?.trim().includes(" ") && contactTitle?.trim());
}

export async function verify(
  profile: IndustryProfile,
  verifier: EmailVerifier,
  store: LeadStore,
  contacts: Map<string, EnrichedContact | null>,
  dropped: DroppedDomains,
): Promise<StageResult> {
  const stats = {
    considered: 0,
    owner: 0,
    general: 0,
    manual_review: 0,
    dropped: 0,
    demoted_to_general: 0,
    qualified: 0,
    disqualified: 0,
  };
  const notes: string[] = [];

  if (!verifier.available && profile.verification.failClosed) {
    notes.push(
      `verifier "${verifier.providerId}" is unavailable and this profile is fail-closed, so every lead is held for manual review`,
    );
  }

  for (const lead of store.all()) {
    if (lead.lifecycle !== "enriched") continue;
    stats.considered += 1;

    const decision = await routeContact(
      contacts.get(lead.id) ?? null,
      lead.email,
      verifier,
      profile.verification,
    );

    if (decision.decision === "drop") {
      stats.dropped += 1;
      dropped.add(lead.domain);
      store.update(lead.id, {
        lifecycle: "disqualified",
        verdict: decision.verdict,
        tags: [...lead.tags, "dropped:undeliverable"],
      });
      continue;
    }

    let track = decision.track!;
    let contactName = decision.contactName ?? "";
    let contactTitle = decision.contactTitle ?? "";
    if (track === "owner" && !ownerTrackIsUsable(contactName, contactTitle)) {
      track = "general";
      contactName = "";
      contactTitle = "";
      stats.demoted_to_general += 1;
    }

    const tags = [...lead.tags];
    if (decision.tag && !tags.includes(decision.tag)) tags.push(decision.tag);

    const routed = store.update(lead.id, {
      contactTrack: track,
      email: decision.email,
      contactName,
      contactTitle,
      verdict: decision.verdict,
      tags,
    })!;

    stats[track] += 1;

    if (track === "manual_review") {
      // Held on purpose. A human flips the track, and the next run picks it up.
      continue;
    }

    const score = scoreLead(routed, profile.scoring);
    if (score < profile.scoring.qualifyThreshold) {
      stats.disqualified += 1;
      store.update(lead.id, { score, lifecycle: "disqualified", tags: [...tags, "below_threshold"] });
      continue;
    }

    if (canTransition(routed.lifecycle, "verified")) {
      store.update(lead.id, { score, lifecycle: "verified" });
      stats.qualified += 1;
    }
  }

  log.info("verify complete", stats);
  return { stage: "verify", stats, notes };
}
