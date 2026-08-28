import { describe, expect, it } from "vitest";
import { DroppedDomains, passesIcpFilter } from "../src/core/icp.js";

const TOKENS = ["ey", "kpmg", "pwc", "bdo"];
const PHRASES = ["deloitte", "h&r block"];

describe("passesIcpFilter", () => {
  it("blocks a short acronym as a whole word", () => {
    expect(passesIcpFilter("EY Global Advisory", TOKENS, PHRASES)).toBe(false);
    expect(passesIcpFilter("KPMG LLP", TOKENS, PHRASES)).toBe(false);
  });

  it("does not blow up a legitimate name that merely contains the letters", () => {
    // This is the bug the word-boundary regex exists to prevent.
    expect(passesIcpFilter("Bayonne Tax Services", TOKENS, PHRASES)).toBe(true);
    expect(passesIcpFilter("Abdo Accounting", TOKENS, PHRASES)).toBe(true);
    expect(passesIcpFilter("Keyes and Company", TOKENS, PHRASES)).toBe(true);
  });

  it("blocks longer names as substrings", () => {
    expect(passesIcpFilter("Deloitte Consulting", TOKENS, PHRASES)).toBe(false);
    expect(passesIcpFilter("H&R Block Downtown", TOKENS, PHRASES)).toBe(false);
  });

  it("passes everything when no blocklist is configured", () => {
    expect(passesIcpFilter("EY Global Advisory", [], [])).toBe(true);
  });

  it("treats regex characters in a blocklist entry as literal text", () => {
    expect(passesIcpFilter("A+B Accounting", ["a+b"], [])).toBe(false);
    expect(passesIcpFilter("AAB Accounting", ["a+b"], [])).toBe(true);
  });
});

describe("DroppedDomains", () => {
  it("remembers a domain within the TTL and forgets it after", () => {
    const now = Date.UTC(2026, 2, 2);
    const store = new DroppedDomains(null, 90, now);
    store.add("quill-cpa.example", now);
    expect(store.has("quill-cpa.example")).toBe(true);
    expect(store.has("QUILL-CPA.EXAMPLE")).toBe(true);
    expect(store.size()).toBe(1);
  });

  it("is a no-op with no path and never throws on flush", () => {
    const store = new DroppedDomains(null, 90);
    expect(() => store.flush()).not.toThrow();
  });
});
