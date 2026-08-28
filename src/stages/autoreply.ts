// Deterministic auto-reply (out of office) detection.
//
// Runs before any classifier. Vacation responders carry unambiguous RFC 3834
// signals, and treating one as a real reply is expensive twice over: it stops
// the sequence for a prospect who never read the email, and it can fire a
// "great, here is my calendar" answer at an empty desk.

export interface ReplyHeaders {
  [key: string]: string | undefined;
}

export interface AutoReplyResult {
  isAutoReply: boolean;
  /** Short, non-identifying reason, safe to store as a tag. */
  reason?: string;
  /** Date the sender said they return, when the body states one. */
  returnsOn?: string;
}

const SUBJECT_PHRASES = [
  "out of office",
  "out of the office",
  "automatic reply",
  "auto-reply",
  "auto reply",
  "autoreply",
  "on vacation",
  "on holiday",
  "on leave",
  "annual leave",
  "parental leave",
  "maternity leave",
  "paternity leave",
  "currently away",
] as const;

const BODY_PHRASES = [
  "out of office",
  "out of the office",
  "automatic reply",
  "autoresponder",
  "on vacation",
  "on holiday",
  "on leave",
  "annual leave",
  "parental leave",
  "currently away",
  "limited access to email",
  "will respond when i return",
  "will reply when i return",
  "back in the office",
  "returning to the office",
  "in my absence",
  "for urgent matters",
] as const;

export function normalizeHeaders(headers?: Record<string, string>): ReplyHeaders {
  const out: ReplyHeaders = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Pull "back on March 4" or "returning on 2026-03-04" out of a body. */
export function parseReturnDate(body: string, year: number): string | undefined {
  const text = body.toLowerCase();

  const iso = text.match(/(?:return|returning|back)[^.\n]{0,20}?(\d{4}-\d{2}-\d{2})/);
  if (iso?.[1]) return iso[1];

  const named = text.match(
    /(?:return|returning|back)[^.\n]{0,20}?\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/,
  );
  if (named?.[1] && named[2]) {
    const month = MONTHS.indexOf(named[1]) + 1;
    const day = Number(named[2]);
    if (month > 0 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  return undefined;
}

export function detectAutoReply(input: {
  subject?: string;
  body?: string;
  headers?: ReplyHeaders;
  year?: number;
}): AutoReplyResult {
  const h = input.headers ?? {};
  const subject = (input.subject ?? "").toLowerCase();
  const body = (input.body ?? "").toLowerCase();
  const year = input.year ?? new Date().getUTCFullYear();
  const returnsOn = parseReturnDate(body, year);

  // Header signals first. These are machine set and effectively never wrong.
  const autoSubmitted = (h["auto-submitted"] ?? "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { isAutoReply: true, reason: "header:auto-submitted", returnsOn };
  }
  if (h["x-autoreply"] || h["x-autorespond"]) {
    return { isAutoReply: true, reason: "header:x-autoreply", returnsOn };
  }
  const precedence = (h["precedence"] ?? "").toLowerCase();
  if (["auto_reply", "bulk", "junk", "list"].includes(precedence)) {
    return { isAutoReply: true, reason: `header:precedence=${precedence}`, returnsOn };
  }
  if (h["list-id"] || h["list-unsubscribe"]) {
    return { isAutoReply: true, reason: "header:list", returnsOn };
  }

  for (const phrase of SUBJECT_PHRASES) {
    if (subject.includes(phrase)) return { isAutoReply: true, reason: "subject", returnsOn };
  }
  for (const phrase of BODY_PHRASES) {
    if (body.includes(phrase)) return { isAutoReply: true, reason: "body", returnsOn };
  }

  return { isAutoReply: false };
}
