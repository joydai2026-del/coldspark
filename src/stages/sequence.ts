// Stage 5: sequence.
//
// Enrolls a personalized lead and sends step 1. Every send is threaded: the
// Message-ID of each outbound message is kept on the lead, and later steps
// reference it, so a reply arriving days later can be matched to the exact
// thread rather than guessed at by subject line.
//
// Two limits are enforced here and shared with the follow-up stage:
//   - a per-run send cap, so a big discovery batch cannot turn into a blast
//   - a send window, checked again at dispatch time, not only at scheduling

import { addSendDays, clampToWindow, zonedDate } from "../core/clock.js";
import type { IndustryProfile, SequenceStep } from "../core/config.js";
import { canTransition } from "../core/lifecycle.js";
import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import type { Lead, SentMessage, StageResult } from "../core/types.js";
import type { Mailer } from "../ports/index.js";
import { MissingPlaceholderError, renderTemplate } from "./personalize.js";

export interface SendBudget {
  remaining: number;
}

export function makeBudget(profile: IndustryProfile): SendBudget {
  return { remaining: profile.sequence.sendCapPerRun };
}

/** Schedule for the step after `stepIndex`, or undefined when the sequence ends. */
export function nextDueAfter(
  profile: IndustryProfile,
  stepIndex: number,
  from: Date,
): string | undefined {
  const next = profile.sequence.steps[stepIndex + 1];
  if (!next) return undefined;
  const [startHour, endHour] = profile.sequence.sendWindowHours;
  return addSendDays(
    from,
    next.delayBusinessDays,
    profile.sequence.sendDays,
    startHour,
    endHour,
    profile.sequence.timezone,
  ).toISOString();
}

/**
 * Is this instant inside the profile's send window? Checked again at dispatch
 * time, not only when a step was scheduled, because a run can start late: a
 * follow-up that came due at 09:00 must not go out at 23:00 because the cron
 * was delayed.
 */
export function isInsideSendWindow(at: Date, profile: IndustryProfile): boolean {
  const [startHour, endHour] = profile.sequence.sendWindowHours;
  return (
    clampToWindow(at, profile.sequence.sendDays, startHour, endHour, profile.sequence.timezone).getTime() ===
    at.getTime()
  );
}

/**
 * Render and send one step. Never throws: it reports why a lead was not sent
 * so the reason survives into the run report.
 */
export async function sendStep(
  lead: Lead,
  step: SequenceStep,
  stepIndex: number,
  profile: IndustryProfile,
  mailer: Mailer,
  store: LeadStore,
  now: Date,
  budget: SendBudget,
): Promise<"sent" | "capped" | "blocked" | "outside_window"> {
  if (!isInsideSendWindow(now, profile)) return "outside_window";
  if (budget.remaining <= 0) return "capped";
  if (!lead.email) return "blocked";

  const values = lead.personalization ?? {};
  let subject: string;
  let body: string;
  try {
    subject = renderTemplate(step.subject, values);
    body = renderTemplate(step.body, values);
  } catch (err) {
    const missing = err instanceof MissingPlaceholderError ? err.missing.join(",") : "unknown";
    log.warn("send blocked by unfilled copy", { leadId: lead.id, missing });
    store.update(lead.id, {
      contactTrack: "manual_review",
      sequenceStoppedReason: "unfilled_copy",
      tags: [...lead.tags, `held:unfilled_${missing}`],
    });
    return "blocked";
  }

  const references = lead.sent.map((m) => m.messageId);
  const { messageId } = await mailer.send({ to: lead.email, subject, body, references });
  budget.remaining -= 1;

  const withStep: SentMessage = {
    stepId: step.id,
    stepIndex,
    subject,
    body,
    messageId,
    references,
    sentAt: now.toISOString(),
    dryRun: mailer.dryRun,
  };
  const dueNext = nextDueAfter(profile, stepIndex, now);
  // The lifecycle advance rides in the SAME write as the send record. If it
  // were a second update, a crash between the two would leave a lead that has
  // been emailed still sitting in `verified`, and the next run would send the
  // intro again.
  store.update(lead.id, {
    sent: [...lead.sent, withStep],
    nextStepDueAt: dueNext,
    sequenceStoppedReason: dueNext ? undefined : "sequence_complete",
    ...(canTransition(lead.lifecycle, "in_sequence") ? { lifecycle: "in_sequence" as const } : {}),
  });
  // Persist immediately. The remaining window (provider accepted, local write
  // not yet durable) is what a provider-side idempotency key would close.
  store.flush?.();
  return "sent";
}

export async function sequence(
  profile: IndustryProfile,
  mailer: Mailer,
  store: LeadStore,
  now: Date,
  budget: SendBudget,
): Promise<StageResult> {
  const stats = { eligible: 0, sent: 0, capped: 0, blocked: 0 };
  const notes: string[] = [];
  const step = profile.sequence.steps[0]!;
  const [startHour, endHour] = profile.sequence.sendWindowHours;
  const tz = profile.sequence.timezone;

  if (!isInsideSendWindow(now, profile)) {
    const opens = clampToWindow(now, profile.sequence.sendDays, startHour, endHour, tz);
    notes.push(`outside the send window, the next opening is ${zonedDate(opens, tz)} ${startHour}:00 ${tz}`);
    return { stage: "sequence", stats, notes };
  }

  for (const lead of store.all()) {
    if (lead.lifecycle !== "verified") continue;
    if (lead.contactTrack === "manual_review") continue;
    if (!lead.personalization) continue;
    stats.eligible += 1;

    const outcome = await sendStep(lead, step, 0, profile, mailer, store, now, budget);
    if (outcome === "sent") {
      stats.sent += 1;
    } else if (outcome === "capped") {
      stats.capped += 1;
    } else {
      stats.blocked += 1;
    }
  }

  if (stats.capped > 0) {
    notes.push(
      `per-run cap of ${profile.sequence.sendCapPerRun} reached, ${stats.capped} leads wait for the next run`,
    );
  }
  log.info("sequence complete", stats);
  return { stage: "sequence", stats, notes };
}
