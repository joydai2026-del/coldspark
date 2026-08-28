// Industry profile loading and validation.
//
// The profile is the only thing that changes between "accounting firms in
// one city" and "dental practices in another". Nothing in src/stages knows
// an industry name. Adding a vertical is a JSON file, not a code change.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const INDUSTRY_DIR = resolve(HERE, "../../config/industries");

export interface ScoringConfig {
  /** Points awarded per signal. Missing key means the signal is not scored. */
  weights: {
    hasEmail?: number;
    trackOwner?: number;
    trackGeneral?: number;
    hasPhone?: number;
    hasWebsite?: number;
    ratingAbove?: Record<string, number>;
    reviewsAbove?: Record<string, number>;
  };
  /** Leads scoring below this are disqualified before any send. */
  qualifyThreshold: number;
}

export interface SequenceStep {
  id: string;
  /** Business days after the previous step. Step 1 must be 0. */
  delayBusinessDays: number;
  subject: string;
  /** Body with {placeholders}. Placeholders are filled by the personalizer. */
  body: string;
}

export interface IndustryProfile {
  id: string;
  label: string;
  discovery: {
    queries: string[];
    location: string;
    limit: number;
  };
  icp: {
    /** Short acronyms matched on word boundaries, e.g. "ey" must not hit "Bayonne". */
    blockTokens: string[];
    /** Longer names matched as substrings. */
    blockPhrases: string[];
    minRating?: number;
    minReviews?: number;
  };
  verification: {
    /** When true, an unavailable verifier routes every lead to manual review. */
    failClosed: boolean;
    /** What to do with a risky verdict (catch-all, role, low confidence). */
    riskyPolicy: "manual_review" | "drop";
    droppedDomainTtlDays: number;
  };
  personalization: {
    /** Placeholders the sequence bodies are allowed to use. */
    placeholders: string[];
    /** Guidance handed to the personalizer provider. */
    brief: string;
  };
  scoring: ScoringConfig;
  sequence: {
    timezone: string;
    /** Local hours [start, end) during which sending is allowed. */
    sendWindowHours: [number, number];
    /** Weekday numbers allowed, 1 = Monday .. 7 = Sunday. */
    sendDays: number[];
    sendCapPerRun: number;
    steps: SequenceStep[];
  };
  handoff: {
    /** Where a positive reply goes next. Free text, printed in the report. */
    destination: string;
    calendarLink: string;
  };
}

export class ConfigError extends Error {}

function req<T>(value: T | undefined, path: string): T {
  if (value === undefined || value === null) throw new ConfigError(`missing field: ${path}`);
  return value;
}

export function validateProfile(raw: unknown, source: string): IndustryProfile {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`${source}: profile must be an object`);
  }
  const p = raw as IndustryProfile;

  req(p.id, `${source}.id`);
  req(p.label, `${source}.label`);
  req(p.discovery, `${source}.discovery`);
  req(p.icp, `${source}.icp`);
  req(p.verification, `${source}.verification`);
  req(p.personalization, `${source}.personalization`);
  req(p.scoring, `${source}.scoring`);
  req(p.sequence, `${source}.sequence`);
  req(p.handoff, `${source}.handoff`);

  if (!Array.isArray(p.discovery.queries) || p.discovery.queries.length === 0) {
    throw new ConfigError(`${source}: discovery.queries must be a non-empty array`);
  }
  if (!Array.isArray(p.sequence.steps) || p.sequence.steps.length === 0) {
    throw new ConfigError(`${source}: sequence.steps must be a non-empty array`);
  }
  if (p.sequence.steps[0]!.delayBusinessDays !== 0) {
    throw new ConfigError(`${source}: the first sequence step must have delayBusinessDays 0`);
  }
  const ids = new Set<string>();
  for (const step of p.sequence.steps) {
    if (ids.has(step.id)) throw new ConfigError(`${source}: duplicate sequence step id "${step.id}"`);
    ids.add(step.id);
    if (step.delayBusinessDays < 0) {
      throw new ConfigError(`${source}: step "${step.id}" has a negative delay`);
    }
  }

  const [open, close] = p.sequence.sendWindowHours ?? [];
  if (typeof open !== "number" || typeof close !== "number" || open >= close) {
    throw new ConfigError(`${source}: sequence.sendWindowHours must be [start, end] with start < end`);
  }
  if (!Array.isArray(p.sequence.sendDays) || p.sequence.sendDays.length === 0) {
    throw new ConfigError(`${source}: sequence.sendDays must be a non-empty array`);
  }
  if (p.sequence.sendCapPerRun <= 0) {
    throw new ConfigError(`${source}: sequence.sendCapPerRun must be positive`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: p.sequence.timezone });
  } catch {
    throw new ConfigError(`${source}: sequence.timezone "${p.sequence.timezone}" is not a known IANA zone`);
  }

  // Every placeholder used in a body must be declared, otherwise a send would
  // ship a literal "{company_hook}" to a prospect.
  const declared = new Set(p.personalization.placeholders ?? []);
  for (const step of p.sequence.steps) {
    for (const field of [step.subject, step.body]) {
      for (const match of field.matchAll(/\{([a-z0-9_]+)\}/g)) {
        const name = match[1]!;
        if (!declared.has(name)) {
          throw new ConfigError(
            `${source}: step "${step.id}" uses {${name}} which is not in personalization.placeholders`,
          );
        }
      }
    }
  }

  return p;
}

export function listIndustries(dir: string = INDUSTRY_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadProfile(industry: string, dir: string = INDUSTRY_DIR): IndustryProfile {
  const file = industry.endsWith(".json") ? industry : join(dir, `${industry}.json`);
  if (!existsSync(file)) {
    const available = listIndustries(dir).join(", ") || "none found";
    throw new ConfigError(`no industry profile "${industry}". Available: ${available}`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  return validateProfile(parsed, file);
}
