// Shared domain types for the pipeline.
//
// Everything the stages pass to each other is defined here. Providers
// (lead sources, enrichers, verifiers, mailers, inboxes) speak these types
// so a vendor swap never reaches into business logic.

/** Canonical lead lifecycle. See core/lifecycle.ts for the transition rules. */
export type Lifecycle =
  | "new"
  | "enriched"
  | "verified"
  | "in_sequence"
  | "replied"
  | "handed_off"
  | "lost"
  | "disqualified";

/**
 * How a lead is addressed.
 *  - "owner":         a named decision maker with a verified personal mailbox
 *  - "general":       a verified role mailbox (info@, hello@) with no name
 *  - "manual_review": human triage required before anything is sent
 */
export type ContactTrack = "owner" | "general" | "manual_review";

/** A company as returned by a lead source, before any enrichment. */
export interface DiscoveredCompany {
  companyName: string;
  website: string;
  domain: string;
  phone?: string;
  address?: string;
  rating?: number;
  reviewCount?: number;
  category?: string;
  /** Role mailbox the directory listed, if any. Often info@ or contact@. */
  email?: string;
}

/** A decision maker returned by a contact enricher. */
export interface EnrichedContact {
  email: string;
  firstName: string;
  lastName: string;
  title: string;
}

/** Four class verdict every verifier maps its raw API response onto. */
export type EmailVerdict = "valid" | "invalid" | "risky" | "api_failed";

/** One outbound message the engine has produced. */
export interface SentMessage {
  stepId: string;
  stepIndex: number;
  subject: string;
  body: string;
  /** RFC 5322 Message-ID assigned at send time. Threading key. */
  messageId: string;
  /** Message-IDs this message threads under, oldest first. */
  references: string[];
  sentAt: string;
  /** True when the mailer was a dry run and nothing left the machine. */
  dryRun: boolean;
}

/** A reply pulled from the inbox, normalized. */
export interface InboundReply {
  fromEmail: string;
  subject: string;
  body: string;
  receivedAt: string;
  messageId: string;
  /** Message-ID this reply answers, if the client set it. */
  inReplyTo?: string;
  references?: string[];
  /** Lowercased header map. Used by the deterministic auto-reply detector. */
  headers?: Record<string, string>;
}

export type ReplyClass = "positive" | "negative" | "auto_reply" | "unsubscribe";

/** The record the engine carries end to end. One per company. */
export interface Lead {
  id: string;
  companyName: string;
  domain: string;
  website: string;
  phone?: string;
  rating?: number;
  reviewCount?: number;

  lifecycle: Lifecycle;
  contactTrack: ContactTrack;
  score: number;

  email?: string;
  contactName?: string;
  contactTitle?: string;

  /** Verifier verdict, kept for auditability. */
  verdict?: EmailVerdict;

  /** Research summary the personalizer grounded its copy in. */
  research?: string;
  /** Placeholder values the personalizer produced, e.g. company_hook. */
  personalization?: Record<string, string>;

  sent: SentMessage[];
  /** ISO date the next sequence step is due. Undefined when finished. */
  nextStepDueAt?: string;
  /** Set when a reply, unsubscribe, or handoff stopped the sequence. */
  sequenceStoppedReason?: string;

  replyClass?: ReplyClass;
  repliedAt?: string;
  handoffNote?: string;

  /** Short machine tags, e.g. verdict:risky, auto_reply:2026-03-04. No PII. */
  tags: string[];
}

export interface StageResult {
  stage: string;
  /** Counters the CLI prints and the tests assert on. */
  stats: Record<string, number>;
  notes: string[];
}

export interface RunReport {
  industry: string;
  startedAt: string;
  dryRun: boolean;
  stages: StageResult[];
  leads: Lead[];
}
