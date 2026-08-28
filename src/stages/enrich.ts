// Stage 2: enrich.
//
// Ask the enricher for a named decision maker at each domain. A role mailbox
// from the directory is kept as the fallback address, but the two are never
// mixed: if the person's address does not survive verification, the person's
// name is dropped along with it, because writing "Hi Sarah" to info@ is the
// fastest way to get a domain burned.

import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import { canTransition } from "../core/lifecycle.js";
import type { EnrichedContact, StageResult } from "../core/types.js";
import type { ContactEnricher } from "../ports/index.js";

export async function enrich(
  enricher: ContactEnricher,
  store: LeadStore,
): Promise<{ result: StageResult; contacts: Map<string, EnrichedContact | null> }> {
  const stats = { considered: 0, contacts_found: 0, no_contact: 0, provider_errors: 0 };
  const notes: string[] = [];
  const contacts = new Map<string, EnrichedContact | null>();

  if (!enricher.available) {
    notes.push(
      `contact enricher "${enricher.providerId}" is not configured, every lead falls back to its role mailbox`,
    );
  }

  for (const lead of store.all()) {
    if (lead.lifecycle !== "new") continue;
    stats.considered += 1;

    let contact: EnrichedContact | null = null;
    if (enricher.available) {
      try {
        contact = await enricher.findContact(lead.domain);
      } catch (err) {
        stats.provider_errors += 1;
        log.warn("enricher lookup failed", {
          domain: lead.domain,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    contacts.set(lead.id, contact);
    if (contact) stats.contacts_found += 1;
    else stats.no_contact += 1;

    if (canTransition(lead.lifecycle, "enriched")) {
      store.update(lead.id, { lifecycle: "enriched" });
    }
  }

  log.info("enrich complete", stats);
  return { result: { stage: "enrich", stats, notes }, contacts };
}
