// Reply classification.
//
// The production system asks a small model for this, using the taxonomy
// below. The taxonomy is the part worth keeping: "stop emailing me" is an
// unsubscribe, not a negative, because the two have different obligations.
//
// This repo ships a deterministic rule classifier as the default so the dry
// run needs no API key, and puts a model behind the same interface for anyone
// who wants one.

import type { ReplyClass } from "../core/types.js";

export interface ReplyClassifier {
  readonly providerId: string;
  classify(text: string): Promise<ReplyClass>;
}

const UNSUBSCRIBE = [
  "unsubscribe",
  "stop emailing",
  "stop sending",
  "stop contacting",
  "remove me",
  "take me off",
  "do not contact",
  "don't contact me",
  "opt out",
  "no longer wish to receive",
] as const;

const NEGATIVE = [
  "not interested",
  "no thanks",
  "no thank you",
  "not a good fit",
  "not a fit",
  "we already have",
  "we're all set",
  "we are all set",
  "pass on this",
  "not at this time",
  "no budget",
] as const;

const POSITIVE = [
  "interested",
  "sounds good",
  "sounds great",
  "tell me more",
  "learn more",
  "happy to chat",
  "happy to talk",
  "let's set",
  "lets set",
  "book a time",
  "send over",
  "what does it cost",
  "how much",
  "what's the pricing",
  "next week works",
  "can we talk",
  "worth a call",
  "yes",
] as const;

/** Strip the quoted original so only the human's own words are classified. */
export function stripQuotedText(raw: string): string {
  const cut = raw.split(/\n?On .+ wrote:\s*\n/)[0] ?? raw;
  return cut
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

export function classifyByRules(raw: string): ReplyClass {
  const text = stripQuotedText(raw).toLowerCase();
  for (const p of UNSUBSCRIBE) if (text.includes(p)) return "unsubscribe";
  for (const p of NEGATIVE) if (text.includes(p)) return "negative";
  for (const p of POSITIVE) if (text.includes(p)) return "positive";
  // Unknown is treated as negative on purpose: it stops the sequence and puts
  // the thread in front of a human rather than continuing to send.
  return "negative";
}

export const ruleClassifier: ReplyClassifier = {
  providerId: "rules",
  classify: async (text: string) => classifyByRules(text),
};
