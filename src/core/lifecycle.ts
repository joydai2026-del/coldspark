// Lead lifecycle state machine.
//
// Distilled from the production pipeline. Every stage guards its write with
// `canTransition` so a re-run over already advanced leads is a cheap no-op
// instead of a duplicate send. That property is what makes the whole engine
// safe to run on a cron.

import type { Lifecycle } from "./types.js";

export const LIFECYCLE_STATES: readonly Lifecycle[] = [
  "new",
  "enriched",
  "verified",
  "in_sequence",
  "replied",
  "handed_off",
  "lost",
  "disqualified",
];

/** Valid forward moves. Any state may also short circuit to lost or disqualified. */
export const LIFECYCLE_TRANSITIONS: Record<Lifecycle, Lifecycle[]> = {
  new: ["enriched"],
  enriched: ["verified"],
  verified: ["in_sequence"],
  in_sequence: ["replied"],
  replied: ["handed_off"],
  handed_off: [],
  lost: [],
  disqualified: [],
};

export function canTransition(from: Lifecycle, to: Lifecycle): boolean {
  if (from === to) return true; // idempotent rewrite is allowed
  if (from === "lost" || from === "disqualified") return false;
  if (to === "disqualified" || to === "lost") return true;
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}
