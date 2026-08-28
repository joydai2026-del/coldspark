// Stage 6: track replies.
//
// Thread matching is the point of this stage. A reply is attached to a lead by
// its In-Reply-To or References header, which names an exact message this
// engine sent. The from-address is only a fallback, because a prospect can
// answer from a different mailbox than the one that was contacted, and two
// leads at the same firm can answer the same campaign.
//
// Auto-replies are handled before classification, and they explicitly do NOT
// stop the sequence. They push the next step out to the stated return date.

import { clampToWindow, fromZoned } from "../core/clock.js";
import type { IndustryProfile } from "../core/config.js";
import { canTransition } from "../core/lifecycle.js";
import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import type { InboundReply, Lead, StageResult } from "../core/types.js";
import type { Inbox } from "../ports/index.js";
import { detectAutoReply, normalizeHeaders } from "./autoreply.js";
import type { ReplyClassifier } from "./classify.js";

/** Attach a reply to the lead whose thread it belongs to. Headers win. */
export function matchReplyToLead(reply: InboundReply, leads: Lead[]): Lead | undefined {
  const ids = new Set<string>([reply.inReplyTo ?? "", ...(reply.references ?? [])].filter(Boolean));
  if (ids.size) {
    const threaded = leads.find((lead) => lead.sent.some((m) => ids.has(m.messageId)));
    if (threaded) return threaded;
  }
  const from = reply.fromEmail.trim().toLowerCase();
  return leads.find((lead) => (lead.email ?? "").toLowerCase() === from && lead.sent.length > 0);
}

/**
 * How far back to ask the inbox for replies. Anchored on the oldest message
 * still awaiting an answer, NOT on when this run started: a reply that landed
 * while no run was in progress must still be found, or the lead would keep
 * getting follow-ups after answering. Re-reading is safe because replies are
 * deduplicated by Message-ID and the lifecycle transitions are idempotent.
 */
export function replyCursor(store: LeadStore, now: Date): string {
  const timestamps = store
    .all()
    .filter((l) => l.sent.length > 0 && !l.replyClass)
    .flatMap((l) => l.sent.map((m) => m.sentAt))
    .filter(Boolean);
  if (timestamps.length === 0) return now.toISOString();
  return timestamps.reduce((oldest, t) => (t < oldest ? t : oldest));
}

export async function trackReplies(
  profile: IndustryProfile,
  inbox: Inbox,
  classifier: ReplyClassifier,
  store: LeadStore,
  now: Date,
  sinceIso: string,
): Promise<StageResult> {
  const stats = {
    fetched: 0,
    unmatched: 0,
    auto_reply: 0,
    positive: 0,
    negative: 0,
    unsubscribe: 0,
    duplicates: 0,
  };
  const notes: string[] = [];

  if (!inbox.available) {
    notes.push(`inbox "${inbox.providerId}" is not configured, no replies were checked`);
    return { stage: "track-replies", stats, notes };
  }

  const active = store.all().filter((l) => l.sent.length > 0);
  const addresses = active.map((l) => l.email!).filter(Boolean);
  const replies = await inbox.fetchReplies(sinceIso, addresses);
  stats.fetched = replies.length;

  const seen = new Set<string>();
  const [startHour, endHour] = profile.sequence.sendWindowHours;

  for (const reply of replies) {
    if (seen.has(reply.messageId)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(reply.messageId);

    const lead = matchReplyToLead(reply, store.all());
    if (!lead) {
      stats.unmatched += 1;
      log.warn("reply matched no thread", { subject: reply.subject.slice(0, 40) });
      continue;
    }

    const auto = detectAutoReply({
      subject: reply.subject,
      body: reply.body,
      headers: normalizeHeaders(reply.headers),
      year: now.getUTCFullYear(),
    });

    if (auto.isAutoReply) {
      stats.auto_reply += 1;
      // Lifecycle deliberately unchanged. Defer the next step instead.
      const patch: Partial<Lead> = {
        tags: [...new Set([...lead.tags, `auto_reply:${auto.reason ?? "detected"}`])],
      };
      if (auto.returnsOn) {
        const [y, m, d] = auto.returnsOn.split("-").map(Number) as [number, number, number];
        const resume = clampToWindow(
          fromZoned(y, m, d, startHour, profile.sequence.timezone),
          profile.sequence.sendDays,
          startHour,
          endHour,
          profile.sequence.timezone,
        );
        if (!lead.nextStepDueAt || new Date(lead.nextStepDueAt) < resume) {
          patch.nextStepDueAt = resume.toISOString();
        }
      }
      store.update(lead.id, patch);
      continue;
    }

    const verdict = await classifier.classify(reply.body);
    stats[verdict] += 1;

    const patch: Partial<Lead> = {
      replyClass: verdict,
      repliedAt: reply.receivedAt,
      sequenceStoppedReason: verdict === "unsubscribe" ? "unsubscribed" : "replied",
      nextStepDueAt: undefined,
      tags: [...new Set([...lead.tags, `reply:${verdict}`])],
    };

    if (verdict === "unsubscribe") {
      patch.lifecycle = "disqualified";
    } else if (canTransition(lead.lifecycle, "replied")) {
      patch.lifecycle = "replied";
    }

    store.update(lead.id, patch);
  }

  log.info("track-replies complete", stats);
  return { stage: "track-replies", stats, notes };
}
