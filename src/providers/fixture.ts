// Fixture providers.
//
// These implement every port against local sample files, which is what makes
// `npm run demo` work with no API keys, no network, and no risk of a real
// email leaving the machine. They are also what the tests run against, so the
// same code path the demo exercises is the one under test.
//
// All data they read is fabricated. See sample-data/README.md.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DiscoveredCompany,
  EmailVerdict,
  EnrichedContact,
  InboundReply,
  Lead,
} from "../core/types.js";
import type {
  ContactEnricher,
  EmailVerifier,
  Inbox,
  LeadSource,
  Mailer,
  Personalizer,
  ResearchResult,
} from "../ports/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const SAMPLE_DIR = resolve(HERE, "../../sample-data");

export interface SampleCompany extends DiscoveredCompany {
  /** Fabricated homepage summary the personalizer reads instead of fetching. */
  siteSummary?: string;
  /** Fabricated decision maker, when the sample says the enricher finds one. */
  contact?: EnrichedContact | null;
  /** Verdict the sample verifier returns for each address. */
  verdicts?: Record<string, EmailVerdict>;
  /** Keywords a discovery query must match. */
  tags?: string[];
}

export interface SampleReply {
  /** Domain of the lead this reply comes from. */
  domain: string;
  subject: string;
  body: string;
  receivedAt: string;
  headers?: Record<string, string>;
  /** When true the reply arrives from a different address than the one contacted. */
  fromEmailOverride?: string;
}

export function loadSampleCompanies(dir = SAMPLE_DIR): SampleCompany[] {
  return JSON.parse(readFileSync(resolve(dir, "sample-companies.json"), "utf-8")) as SampleCompany[];
}

export function loadSampleReplies(dir = SAMPLE_DIR): SampleReply[] {
  return JSON.parse(readFileSync(resolve(dir, "sample-replies.json"), "utf-8")) as SampleReply[];
}

export function fixtureLeadSource(companies: SampleCompany[]): LeadSource {
  return {
    providerId: "fixture-directory",
    available: true,
    async search(query, _location, limit) {
      const needle = query.toLowerCase();
      const words = needle.split(/\s+/).filter((w) => w.length > 3);
      return companies
        .filter((c) => {
          const hay = [c.category ?? "", c.companyName, ...(c.tags ?? [])].join(" ").toLowerCase();
          return words.length === 0 || words.some((w) => hay.includes(w));
        })
        .slice(0, limit)
        .map(({ siteSummary: _s, contact: _c, verdicts: _v, tags: _t, ...company }) => company);
    },
  };
}

export function fixtureEnricher(companies: SampleCompany[]): ContactEnricher {
  const byDomain = new Map(companies.map((c) => [c.domain, c]));
  return {
    providerId: "fixture-enricher",
    available: true,
    async findContact(domain) {
      return byDomain.get(domain)?.contact ?? null;
    },
  };
}

export function fixtureVerifier(companies: SampleCompany[]): EmailVerifier {
  const verdicts = new Map<string, EmailVerdict>();
  for (const c of companies) {
    for (const [email, verdict] of Object.entries(c.verdicts ?? {})) {
      verdicts.set(email.toLowerCase(), verdict);
    }
  }
  return {
    providerId: "fixture-verifier",
    available: true,
    async verify(email) {
      // Unlisted addresses are treated as risky, never as valid. A verifier
      // that guesses "valid" when it does not know is how a domain gets burned.
      return verdicts.get(email.trim().toLowerCase()) ?? "risky";
    },
  };
}

/**
 * Fixture personalizer. Derives placeholder values from the sample homepage
 * summary with string rules instead of a model call, so the demo is free,
 * offline, and byte-for-byte reproducible. The real implementation of this
 * port is the ColdSpark app, which fetches the page and asks a model.
 */
export function fixturePersonalizer(companies: SampleCompany[]): Personalizer {
  const byDomain = new Map(companies.map((c) => [c.domain, c]));
  return {
    providerId: "fixture-personalizer",
    available: true,
    async research(lead: Lead, placeholders: string[]): Promise<ResearchResult | null> {
      const sample = byDomain.get(lead.domain);
      if (!sample?.siteSummary) return null;

      const summary = sample.siteSummary;
      const firstClause = summary.split(/[.;]/)[0]!.trim();
      const values: Record<string, string> = {
        company_hook: firstClause.replace(/^[A-Z]/, (c) => c.toLowerCase()),
        value_prop: `cut the hours your team spends on ${sample.category ?? "back-office work"} every month`,
        proof_point: `firms of ${lead.companyName}'s size usually see the first hour back in week one`,
      };
      const known = Object.fromEntries(
        placeholders.filter((p) => p in values).map((p) => [p, values[p]!]),
      );
      return { summary, placeholders: known, source: `sample-data:${lead.domain}` };
    },
  };
}

/** One message the dry-run mailer captured instead of sending. */
export interface CapturedMessage {
  to: string;
  subject: string;
  body: string;
  references: string[];
  messageId: string;
}

/**
 * Dry-run mailer. Assigns a real RFC 5322 style Message-ID so the threading
 * path is genuinely exercised, and keeps every message in memory instead of
 * sending it. The domain is `.invalid`, which is reserved and unroutable.
 *
 * The id is derived from the recipient and the position in the thread rather
 * than a counter, so it is stable across runs: a resumed run that re-reads
 * persisted state cannot mint an id that collides with an earlier one.
 */
export function dryRunMailer(): Mailer & { outbox: CapturedMessage[] } {
  const outbox: CapturedMessage[] = [];
  return {
    providerId: "dry-run",
    dryRun: true,
    outbox,
    async send({ to, subject, body, references }) {
      const local = `${to.replace(/[^a-zA-Z0-9]+/g, ".")}.${references.length + 1}`;
      const messageId = `<${local}@dry-run.invalid>`;
      outbox.push({ to, subject, body, references, messageId });
      return { messageId };
    },
  };
}

/**
 * Fixture inbox. Resolves each sample reply against the dry-run outbox so the
 * In-Reply-To header points at a message this run actually produced, which is
 * what the thread matcher is supposed to key on.
 */
export function fixtureInbox(
  replies: SampleReply[],
  outbox: CapturedMessage[],
  leadsByDomain: () => Map<string, Lead>,
): Inbox {
  return {
    providerId: "fixture-inbox",
    available: true,
    async fetchReplies(sinceIso, addresses): Promise<InboundReply[]> {
      const allowed = new Set(addresses.map((a) => a.toLowerCase()));
      const leads = leadsByDomain();
      const out: InboundReply[] = [];

      for (const [i, reply] of replies.entries()) {
        const lead = leads.get(reply.domain);
        if (!lead?.email) continue;
        if (!allowed.has(lead.email.toLowerCase())) continue;
        if (new Date(reply.receivedAt) < new Date(sinceIso)) continue;

        const thread = outbox.filter((m) => m.to.toLowerCase() === lead.email!.toLowerCase());
        const answered = thread[thread.length - 1];
        out.push({
          fromEmail: reply.fromEmailOverride ?? lead.email,
          subject: reply.subject,
          body: reply.body,
          receivedAt: reply.receivedAt,
          messageId: `<reply.${String(i + 1).padStart(4, "0")}@sample.invalid>`,
          inReplyTo: answered?.messageId,
          references: answered ? [answered.messageId] : [],
          headers: reply.headers,
        });
      }
      return out;
    },
  };
}
