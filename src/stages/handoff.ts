// Stage 8: hand off.
//
// The engine's job ends at a warm thread. This stage packages what a human
// (or a downstream proposal or CRM agent) needs to take the call: who replied,
// what the engine had researched about them, and which message they answered.
//
// Deliberately small. The production system continues into meeting prep,
// proposals, and invoicing. Those are a different product, and dragging them
// in here would make this repo about billing rather than about outreach.

import { canTransition } from "../core/lifecycle.js";
import type { IndustryProfile } from "../core/config.js";
import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import type { StageResult } from "../core/types.js";

export interface HandoffPacket {
  leadId: string;
  companyName: string;
  contact: string;
  email: string;
  repliedAt?: string;
  /** The step whose thread they answered. */
  answeredStep: string;
  research: string;
  destination: string;
  calendarLink: string;
}

export function buildPacket(
  lead: ReturnType<LeadStore["all"]>[number],
  profile: IndustryProfile,
): HandoffPacket {
  const last = lead.sent[lead.sent.length - 1];
  return {
    leadId: lead.id,
    companyName: lead.companyName,
    contact: lead.contactName || "(role mailbox)",
    email: lead.email ?? "",
    repliedAt: lead.repliedAt,
    answeredStep: last?.stepId ?? "(none)",
    research: lead.research ?? "",
    destination: profile.handoff.destination,
    calendarLink: profile.handoff.calendarLink,
  };
}

export async function handOff(
  profile: IndustryProfile,
  store: LeadStore,
): Promise<{ result: StageResult; packets: HandoffPacket[] }> {
  const stats = { replied: 0, handed_off: 0, needs_human: 0 };
  const notes: string[] = [];
  const packets: HandoffPacket[] = [];

  for (const lead of store.all()) {
    if (lead.lifecycle !== "replied") continue;
    stats.replied += 1;

    if (lead.replyClass !== "positive") {
      stats.needs_human += 1;
      continue;
    }

    packets.push(buildPacket(lead, profile));
    if (canTransition(lead.lifecycle, "handed_off")) {
      store.update(lead.id, {
        lifecycle: "handed_off",
        handoffNote: `sent to ${profile.handoff.destination}`,
      });
      stats.handed_off += 1;
    }
  }

  if (stats.needs_human > 0) {
    notes.push(`${stats.needs_human} replies were not positive and stay with a human`);
  }
  log.info("hand-off complete", stats);
  return { result: { stage: "hand-off", stats, notes }, packets };
}
