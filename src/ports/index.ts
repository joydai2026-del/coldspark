// Provider contracts.
//
// Every external service the pipeline touches sits behind one of these six
// interfaces. Swapping a vendor is a new file in src/providers plus one line
// in the provider registry. No stage imports a vendor SDK.

import type {
  DiscoveredCompany,
  EnrichedContact,
  EmailVerdict,
  InboundReply,
  Lead,
} from "../core/types.js";

export interface LeadSource {
  readonly providerId: string;
  readonly available: boolean;
  search(query: string, location: string, limit: number): Promise<DiscoveredCompany[]>;
}

export interface ContactEnricher {
  readonly providerId: string;
  readonly available: boolean;
  /** Best decision maker at a domain, or null when no complete contact exists. */
  findContact(domain: string): Promise<EnrichedContact | null>;
}

export interface EmailVerifier {
  readonly providerId: string;
  /** False when no API key is configured. The verify stage fails closed on this. */
  readonly available: boolean;
  /** Never throws. Transient failures map to "api_failed". */
  verify(email: string): Promise<EmailVerdict>;
}

export interface ResearchResult {
  /** Plain-language summary of what the company does, grounded in a source. */
  summary: string;
  /** Placeholder values keyed by placeholder name. */
  placeholders: Record<string, string>;
  /** Where the summary came from, e.g. a URL or "fixture". */
  source: string;
}

export interface Personalizer {
  readonly providerId: string;
  readonly available: boolean;
  research(lead: Lead, placeholders: string[], brief: string): Promise<ResearchResult | null>;
}

export interface Mailer {
  readonly providerId: string;
  /** True when nothing actually leaves the machine. */
  readonly dryRun: boolean;
  /**
   * Dispatch one message and return the Message-ID the provider assigned.
   * The engine owns the rest of the record, so a provider cannot report a
   * send time or a body that differs from what the pipeline scheduled.
   */
  send(input: {
    to: string;
    subject: string;
    body: string;
    /** Message-IDs of the thread so far, oldest first. */
    references: string[];
  }): Promise<{ messageId: string }>;
}

export interface Inbox {
  readonly providerId: string;
  readonly available: boolean;
  /** Replies received since a timestamp, for the given recipient addresses. */
  fetchReplies(sinceIso: string, addresses: string[]): Promise<InboundReply[]>;
}
