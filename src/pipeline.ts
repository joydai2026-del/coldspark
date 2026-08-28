// The pipeline.
//
// Eight stages, one direction, no stage reaching into another's state. Each
// stage reads leads in a given lifecycle, does one job, and writes the lead
// back. That is what lets the whole thing run on a schedule: a re-run over
// already-processed leads is a no-op, so there is no "did it already send?"
// bookkeeping anywhere in the business logic.

import type { IndustryProfile } from "./core/config.js";
import { DroppedDomains } from "./core/icp.js";
import type { LeadStore } from "./core/store.js";
import type { RunReport, StageResult } from "./core/types.js";
import type { ContactEnricher, EmailVerifier, Inbox, LeadSource, Mailer, Personalizer } from "./ports/index.js";
import type { ReplyClassifier } from "./stages/classify.js";
import { discover } from "./stages/discover.js";
import { enrich } from "./stages/enrich.js";
import { followUp } from "./stages/followup.js";
import { handOff, type HandoffPacket } from "./stages/handoff.js";
import { personalize } from "./stages/personalize.js";
import { replyCursor, trackReplies } from "./stages/replies.js";
import { makeBudget, sequence } from "./stages/sequence.js";
import { verify } from "./stages/verify.js";

export interface Providers {
  leadSource: LeadSource;
  enricher: ContactEnricher;
  verifier: EmailVerifier;
  personalizer: Personalizer;
  mailer: Mailer;
  inbox: Inbox;
  classifier: ReplyClassifier;
}

export interface RunOptions {
  profile: IndustryProfile;
  providers: Providers;
  store: LeadStore;
  /** When the outbound half of the run happens. */
  now: Date;
  /**
   * When the inbound half happens. Replies can only exist after a send, so a
   * single run that also demonstrates reply handling needs a later tick. In
   * production these are two separate scheduled invocations.
   */
  checkAt?: Date;
  droppedDomainsPath?: string | null;
}

export async function runPipeline(opts: RunOptions): Promise<RunReport & { packets: HandoffPacket[] }> {
  const { profile, providers: p, store, now } = opts;
  const checkAt = opts.checkAt ?? now;
  const stages: StageResult[] = [];

  const dropped = new DroppedDomains(
    opts.droppedDomainsPath ?? null,
    profile.verification.droppedDomainTtlDays,
    now.getTime(),
  );

  stages.push(await discover(profile, p.leadSource, store, dropped));

  const enriched = await enrich(p.enricher, store);
  stages.push(enriched.result);

  stages.push(await verify(profile, p.verifier, store, enriched.contacts, dropped));
  stages.push(await personalize(profile, p.personalizer, store));

  const budget = makeBudget(profile);
  stages.push(await sequence(profile, p.mailer, store, now, budget));

  // Look back to the oldest unanswered send, not to the start of this run.
  stages.push(await trackReplies(profile, p.inbox, p.classifier, store, checkAt, replyCursor(store, checkAt)));
  stages.push(await followUp(profile, p.mailer, store, checkAt, budget));

  const handed = await handOff(profile, store);
  stages.push(handed.result);

  dropped.flush();
  store.flush?.();

  return {
    industry: profile.id,
    startedAt: now.toISOString(),
    dryRun: p.mailer.dryRun,
    stages,
    leads: store.all(),
    packets: handed.packets,
  };
}
