// Stage 4: research and personalize.
//
// This is the stage the public ColdSpark app implements as a product
// (https://github.com/joydai2026-del/coldspark): read the company's own site,
// then write the placeholder values for this specific lead. Here it is one
// port with one contract, so the engine can call ColdSpark, a different model,
// or a hand-written rule set without any other stage noticing.
//
// The hard rule: a lead whose placeholders cannot all be filled is held, not
// sent. Shipping a literal "{company_hook}" to a prospect is worse than
// shipping nothing.

import type { IndustryProfile } from "../core/config.js";
import { log } from "../core/logger.js";
import type { LeadStore } from "../core/store.js";
import type { Lead, StageResult } from "../core/types.js";
import type { Personalizer } from "../ports/index.js";

/** Placeholders the engine fills from the lead record itself, not from research. */
export function intrinsicPlaceholders(lead: Lead): Record<string, string> {
  const first = (lead.contactName ?? "").trim().split(/\s+/)[0] ?? "";
  return {
    company: lead.companyName,
    first_name: first,
    contact_title: lead.contactTitle ?? "",
    domain: lead.domain,
    // One greeting placeholder keeps a single sequence usable on both tracks:
    // a named person is greeted by name, a role mailbox never is.
    greeting: lead.contactTrack === "owner" && first ? `Hi ${first}` : "Hi there",
  };
}

export class MissingPlaceholderError extends Error {
  constructor(public readonly missing: string[]) {
    super(`unfilled placeholders: ${missing.join(", ")}`);
  }
}

/** Fill {placeholders}. Throws rather than sending a half-rendered email. */
export function renderTemplate(text: string, values: Record<string, string>): string {
  const missing: string[] = [];
  const out = text.replace(/\{([a-z0-9_]+)\}/g, (_all, name: string) => {
    const value = values[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
      return "";
    }
    return value;
  });
  if (missing.length) throw new MissingPlaceholderError([...new Set(missing)]);
  return out;
}

/** Placeholders actually referenced by a profile's sequence copy. */
export function placeholdersUsedBy(profile: IndustryProfile): string[] {
  const used = new Set<string>();
  for (const step of profile.sequence.steps) {
    for (const field of [step.subject, step.body]) {
      for (const m of field.matchAll(/\{([a-z0-9_]+)\}/g)) used.add(m[1]!);
    }
  }
  return [...used];
}

export async function personalize(
  profile: IndustryProfile,
  personalizer: Personalizer,
  store: LeadStore,
): Promise<StageResult> {
  const stats = { considered: 0, researched: 0, no_research: 0, held_incomplete: 0 };
  const notes: string[] = [];

  if (!personalizer.available) {
    notes.push(
      `personalizer "${personalizer.providerId}" is not configured, no lead can be personalized`,
    );
  }

  const needed = placeholdersUsedBy(profile);

  for (const lead of store.all()) {
    if (lead.lifecycle !== "verified") continue;
    stats.considered += 1;

    let researched: Awaited<ReturnType<Personalizer["research"]>> = null;
    if (personalizer.available) {
      try {
        researched = await personalizer.research(lead, profile.personalization.placeholders, profile.personalization.brief);
      } catch (err) {
        log.warn("personalizer failed", {
          domain: lead.domain,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!researched) {
      stats.no_research += 1;
      store.update(lead.id, {
        contactTrack: "manual_review",
        tags: [...lead.tags, "held:no_research"],
      });
      continue;
    }

    const values = { ...intrinsicPlaceholders(lead), ...researched.placeholders };
    const missing = needed.filter((p) => !values[p] || values[p]!.trim() === "");
    if (missing.length) {
      stats.held_incomplete += 1;
      store.update(lead.id, {
        contactTrack: "manual_review",
        research: researched.summary,
        personalization: values,
        tags: [...lead.tags, `held:missing_${missing[0]}`],
      });
      continue;
    }

    stats.researched += 1;
    store.update(lead.id, { research: researched.summary, personalization: values });
  }

  log.info("personalize complete", stats);
  return { stage: "personalize", stats, notes };
}
