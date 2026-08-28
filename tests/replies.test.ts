import { describe, expect, it } from "vitest";
import { detectAutoReply, parseReturnDate } from "../src/stages/autoreply.js";
import { classifyByRules, stripQuotedText } from "../src/stages/classify.js";
import { matchReplyToLead } from "../src/stages/replies.js";
import type { InboundReply, Lead } from "../src/core/types.js";

function lead(id: string, email: string, messageIds: string[]): Lead {
  return {
    id,
    companyName: id,
    domain: `${id}.example`,
    website: `https://${id}.example`,
    lifecycle: "in_sequence",
    contactTrack: "general",
    score: 60,
    email,
    sent: messageIds.map((messageId, i) => ({
      stepId: `step${i}`,
      stepIndex: i,
      subject: "s",
      body: "b",
      messageId,
      references: [],
      sentAt: "2026-03-02T13:00:00.000Z",
      dryRun: true,
    })),
    tags: [],
  };
}

function reply(partial: Partial<InboundReply>): InboundReply {
  return {
    fromEmail: "someone@elsewhere.example",
    subject: "Re: hello",
    body: "sure",
    receivedAt: "2026-03-03T09:00:00.000Z",
    messageId: "<r1@sample.invalid>",
    ...partial,
  };
}

describe("matchReplyToLead", () => {
  const a = lead("alpha", "a@alpha.example", ["<m1@dry-run.invalid>"]);
  const b = lead("beta", "b@beta.example", ["<m2@dry-run.invalid>"]);

  it("matches on In-Reply-To even when the reply comes from a different mailbox", () => {
    const matched = matchReplyToLead(
      reply({ fromEmail: "assistant@alpha.example", inReplyTo: "<m1@dry-run.invalid>" }),
      [a, b],
    );
    expect(matched?.id).toBe("alpha");
  });

  it("matches on References when In-Reply-To is absent", () => {
    const matched = matchReplyToLead(reply({ references: ["<m2@dry-run.invalid>"] }), [a, b]);
    expect(matched?.id).toBe("beta");
  });

  it("falls back to the recipient address when no threading headers survive", () => {
    const matched = matchReplyToLead(reply({ fromEmail: "B@BETA.example" }), [a, b]);
    expect(matched?.id).toBe("beta");
  });

  it("returns nothing for a reply that belongs to no thread", () => {
    expect(matchReplyToLead(reply({}), [a, b])).toBeUndefined();
  });

  it("does not match a lead that was never emailed", () => {
    const never = lead("gamma", "g@gamma.example", []);
    expect(matchReplyToLead(reply({ fromEmail: "g@gamma.example" }), [never])).toBeUndefined();
  });
});

describe("detectAutoReply", () => {
  it("trusts the Auto-Submitted header", () => {
    expect(detectAutoReply({ headers: { "auto-submitted": "auto-replied" } }).isAutoReply).toBe(true);
  });

  it("ignores Auto-Submitted: no, which every normal mail may carry", () => {
    expect(detectAutoReply({ headers: { "auto-submitted": "no" }, body: "sounds good" }).isAutoReply).toBe(false);
  });

  it("catches a subject-line vacation responder with no headers", () => {
    expect(detectAutoReply({ subject: "Automatic reply: your note" }).isAutoReply).toBe(true);
  });

  it("catches a body-only responder", () => {
    const r = detectAutoReply({ body: "I am out of the office and will return on March 16." });
    expect(r.isAutoReply).toBe(true);
    expect(r.returnsOn).toBe(`${new Date().getUTCFullYear()}-03-16`);
  });

  it("leaves an ordinary interested reply alone", () => {
    expect(detectAutoReply({ subject: "Re: your note", body: "This is interesting, happy to chat." }).isAutoReply).toBe(
      false,
    );
  });

  it("reads an ISO return date", () => {
    expect(parseReturnDate("back on 2026-04-01, thanks", 2026)).toBe("2026-04-01");
  });
});

describe("classifyByRules", () => {
  it("calls a stop request an unsubscribe, not a negative", () => {
    expect(classifyByRules("Please stop emailing me.")).toBe("unsubscribe");
    expect(classifyByRules("remove me from this list")).toBe("unsubscribe");
  });

  it("recognizes a decline", () => {
    expect(classifyByRules("Not interested, thanks.")).toBe("negative");
  });

  it("recognizes interest", () => {
    expect(classifyByRules("This is interesting, happy to chat next week.")).toBe("positive");
  });

  it("prefers the unsubscribe reading when both signals appear", () => {
    expect(classifyByRules("Not interested. Please remove me from this list.")).toBe("unsubscribe");
  });

  it("defaults unknown text to negative so the sequence stops rather than continues", () => {
    expect(classifyByRules("k")).toBe("negative");
  });

  it("classifies only the sender's own words, not the quoted original", () => {
    const raw = "Not interested.\n\nOn Mon, 2 Mar 2026, Sender wrote:\n> happy to chat, sounds good, interested?";
    expect(stripQuotedText(raw)).toBe("Not interested.");
    expect(classifyByRules(raw)).toBe("negative");
  });
});
