import { describe, expect, it } from "vitest";
import { ConfigError, listIndustries, loadProfile, validateProfile } from "../src/core/config.js";
import { intrinsicPlaceholders, MissingPlaceholderError, renderTemplate } from "../src/stages/personalize.js";
import type { Lead } from "../src/core/types.js";

function baseProfile() {
  return JSON.parse(JSON.stringify(loadProfile("accounting")));
}

describe("industry profiles", () => {
  it("ships at least the two shipped verticals and every one of them validates", () => {
    const ids = listIndustries();
    expect(ids).toContain("accounting");
    expect(ids).toContain("dental");
    for (const id of ids) expect(() => loadProfile(id)).not.toThrow();
  });

  it("names the available profiles when asked for one that does not exist", () => {
    expect(() => loadProfile("does-not-exist")).toThrow(/Available: accounting, dental/);
  });

  it("rejects a body that uses a placeholder nobody can fill", () => {
    const p = baseProfile();
    p.sequence.steps[0].body = "Hi {mystery_value}";
    expect(() => validateProfile(p, "test")).toThrow(ConfigError);
  });

  it("rejects a first step that is not immediate", () => {
    const p = baseProfile();
    p.sequence.steps[0].delayBusinessDays = 2;
    expect(() => validateProfile(p, "test")).toThrow(/first sequence step/);
  });

  it("rejects duplicate step ids", () => {
    const p = baseProfile();
    p.sequence.steps[1].id = p.sequence.steps[0].id;
    expect(() => validateProfile(p, "test")).toThrow(/duplicate sequence step/);
  });

  it("rejects an inverted send window", () => {
    const p = baseProfile();
    p.sequence.sendWindowHours = [17, 9];
    expect(() => validateProfile(p, "test")).toThrow(/sendWindowHours/);
  });

  it("rejects a non-positive daily cap", () => {
    const p = baseProfile();
    p.sequence.sendCapPerRun = 0;
    expect(() => validateProfile(p, "test")).toThrow(/sendCapPerRun/);
  });
});

describe("renderTemplate", () => {
  it("fills every placeholder", () => {
    expect(renderTemplate("{greeting}, about {company}", { greeting: "Hi Dana", company: "Acme" })).toBe(
      "Hi Dana, about Acme",
    );
  });

  it("refuses to render a half-filled email rather than shipping a literal placeholder", () => {
    expect(() => renderTemplate("Hi {first_name} at {company}", { company: "Acme" })).toThrow(MissingPlaceholderError);
    try {
      renderTemplate("Hi {first_name} at {company}", { company: "Acme", first_name: "  " });
    } catch (err) {
      expect((err as MissingPlaceholderError).missing).toEqual(["first_name"]);
    }
  });
});

describe("intrinsicPlaceholders", () => {
  const lead: Lead = {
    id: "l", companyName: "Acme", domain: "acme.example", website: "https://acme.example",
    lifecycle: "verified", contactTrack: "owner", score: 70, contactName: "Dana Reyes",
    contactTitle: "Partner", sent: [], tags: [],
  };

  it("greets a named owner by first name", () => {
    expect(intrinsicPlaceholders(lead).greeting).toBe("Hi Dana");
  });

  it("never puts a name on a role mailbox", () => {
    const general = { ...lead, contactTrack: "general" as const, contactName: "" };
    expect(intrinsicPlaceholders(general).greeting).toBe("Hi there");
  });
});
