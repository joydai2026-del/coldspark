// Stage 7: follow up.
//
// Sends the next due step for every lead still in the sequence. A lead is due
// when its scheduled time has arrived, it has not replied, it has not
// unsubscribed, and steps remain. The schedule was written by the previous
// send, so this stage is stateless: it can run every hour, and on a day where
// nothing is due it sends nothing.

import { zonedDate } from "../core/clock.js";
import type { IndustryProfile } from "../core/config.js";
import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import type { StageResult } from "../core/types.js";
import type { Mailer } from "../ports/index.js";
import { isInsideSendWindow, sendStep, type SendBudget } from "./sequence.js";

export function isDue(nextStepDueAt: string | undefined, now: Date): boolean {
  if (!nextStepDueAt) return false;
  return new Date(nextStepDueAt).getTime() <= now.getTime();
}

export async function followUp(
  profile: IndustryProfile,
  mailer: Mailer,
  store: LeadStore,
  now: Date,
  budget: SendBudget,
): Promise<StageResult> {
  const stats = { in_sequence: 0, due: 0, sent: 0, capped: 0, blocked: 0, waiting: 0, finished: 0 };
  const notes: string[] = [];

  // A step being due is not enough. A cron that fires late must not turn a
  // 09:00 follow-up into a 23:00 one, so the window is re-checked here.
  if (!isInsideSendWindow(now, profile)) {
    notes.push("outside the send window, due follow-ups wait for the next opening");
    return { stage: "follow-up", stats, notes };
  }

  for (const lead of store.all()) {
    if (lead.lifecycle !== "in_sequence") continue;
    stats.in_sequence += 1;

    if (lead.sequenceStoppedReason) {
      if (lead.sequenceStoppedReason === "sequence_complete") stats.finished += 1;
      continue;
    }
    if (!isDue(lead.nextStepDueAt, now)) {
      stats.waiting += 1;
      continue;
    }

    const nextIndex = lead.sent.length;
    const step = profile.sequence.steps[nextIndex];
    if (!step) {
      stats.finished += 1;
      store.update(lead.id, { nextStepDueAt: undefined, sequenceStoppedReason: "sequence_complete" });
      continue;
    }

    stats.due += 1;
    const outcome = await sendStep(lead, step, nextIndex, profile, mailer, store, now, budget);
    if (outcome === "sent") stats.sent += 1;
    else if (outcome === "capped") stats.capped += 1;
    else stats.blocked += 1;
  }

  if (stats.due === 0 && stats.waiting > 0) {
    notes.push(
      `nothing due on ${zonedDate(now, profile.sequence.timezone)}, ${stats.waiting} leads are waiting on their next step`,
    );
  }
  log.info("follow-up complete", stats);
  return { stage: "follow-up", stats, notes };
}
