import { describe, expect, it } from "vitest";
import { addSendDays, clampToWindow, fromZoned, isoWeekday, zonedDate, zonedParts } from "../src/core/clock.js";
import { loadProfile } from "../src/core/config.js";
import { MemoryLeadStore } from "../src/core/store.js";
import { dryRunMailer } from "../src/providers/fixture.js";
import { followUp, isDue } from "../src/stages/followup.js";
import { isInsideSendWindow, makeBudget } from "../src/stages/sequence.js";
import { canTransition } from "../src/core/lifecycle.js";
import { scoreLead } from "../src/core/scoring.js";
import type { Lead } from "../src/core/types.js";

const WEEKDAYS = [1, 2, 3, 4, 5];

describe("business-day scheduling in UTC", () => {
  it("skips the weekend", () => {
    // Friday 2026-03-06 plus one sending day is Monday 2026-03-09.
    const next = addSendDays(new Date("2026-03-06T13:00:00.000Z"), 1, WEEKDAYS, 9, 17, "UTC");
    expect(next.toISOString().slice(0, 10)).toBe("2026-03-09");
    expect(isoWeekday(next)).toBe(1);
  });

  it("counts three sending days from a Monday to the Thursday", () => {
    const next = addSendDays(new Date("2026-03-02T13:00:00.000Z"), 3, WEEKDAYS, 9, 17, "UTC");
    expect(next.toISOString().slice(0, 10)).toBe("2026-03-05");
  });

  it("moves an early-morning time up to the start of the window", () => {
    const at = clampToWindow(new Date("2026-03-02T04:00:00.000Z"), WEEKDAYS, 9, 17, "UTC");
    expect(at.toISOString()).toBe("2026-03-02T09:00:00.000Z");
  });

  it("pushes an after-hours time to the next sending day", () => {
    const at = clampToWindow(new Date("2026-03-06T22:00:00.000Z"), WEEKDAYS, 9, 17, "UTC");
    expect(at.toISOString()).toBe("2026-03-09T09:00:00.000Z");
  });

  it("leaves a time already inside the window untouched", () => {
    const at = clampToWindow(new Date("2026-03-02T13:00:00.000Z"), WEEKDAYS, 9, 17, "UTC");
    expect(at.toISOString()).toBe("2026-03-02T13:00:00.000Z");
  });
});

describe("the send window is the recipient's local time, not the server's", () => {
  const NY = "America/New_York";

  it("reads the wall clock in the profile's zone", () => {
    // 13:00 UTC is 08:00 in New York, which is before a 09:00 window opens.
    expect(zonedParts(new Date("2026-03-02T13:00:00.000Z"), NY).hour).toBe(8);
    const at = clampToWindow(new Date("2026-03-02T13:00:00.000Z"), WEEKDAYS, 9, 17, NY);
    expect(at.toISOString()).toBe("2026-03-02T14:00:00.000Z"); // 09:00 New York
  });

  it("rolls a late-evening local time to the next working morning", () => {
    // 2026-03-07 01:00 UTC is Friday 20:00 in New York, after the window closes.
    const at = clampToWindow(new Date("2026-03-07T01:00:00.000Z"), WEEKDAYS, 9, 17, NY);
    expect(zonedDate(at, NY)).toBe("2026-03-09");
    expect(zonedParts(at, NY).hour).toBe(9);
  });

  it("still lands on 09:00 local across a daylight-saving change", () => {
    // US clocks move forward on 2026-03-08, so the same local hour is a
    // different UTC instant on either side of that weekend.
    const before = fromZoned(2026, 3, 6, 9, NY);
    const after = fromZoned(2026, 3, 9, 9, NY);
    expect(before.toISOString()).toBe("2026-03-06T14:00:00.000Z");
    expect(after.toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(zonedParts(after, NY).hour).toBe(9);
  });

  it("keeps the same local hour when adding sending days across the change", () => {
    const next = addSendDays(new Date("2026-03-06T15:00:00.000Z"), 1, WEEKDAYS, 9, 17, NY);
    expect(zonedDate(next, NY)).toBe("2026-03-09");
    expect(zonedParts(next, NY).hour).toBe(9);
  });
});

describe("the send window is re-checked at dispatch, not only at scheduling", () => {
  const profile = loadProfile("accounting"); // Mon to Fri, 09:00 to 17:00 New York

  it("accepts an instant inside the window", () => {
    expect(isInsideSendWindow(new Date("2026-03-02T15:30:00.000Z"), profile)).toBe(true); // 10:30 NY
  });

  it("refuses a late-running cron", () => {
    expect(isInsideSendWindow(new Date("2026-03-03T03:00:00.000Z"), profile)).toBe(false); // 22:00 NY
  });

  it("refuses a weekend run", () => {
    expect(isInsideSendWindow(new Date("2026-03-07T15:30:00.000Z"), profile)).toBe(false); // Saturday
  });

  it("stops the follow-up stage entirely when the window is shut", async () => {
    const store = new MemoryLeadStore();
    store.upsert({
      id: "l", companyName: "C", domain: "c.example", website: "https://c.example",
      lifecycle: "in_sequence", contactTrack: "general", score: 60, email: "a@c.example",
      personalization: { greeting: "Hi there", company: "C", company_hook: "h", value_prop: "v", proof_point: "p" },
      nextStepDueAt: "2026-03-05T14:00:00.000Z",
      sent: [{ stepId: "intro", stepIndex: 0, subject: "s", body: "b", messageId: "<m@dry-run.invalid>",
        references: [], sentAt: "2026-03-02T15:30:00.000Z", dryRun: true }],
      tags: [],
    });
    const mailer = dryRunMailer();

    const shut = await followUp(profile, mailer, store, new Date("2026-03-06T03:00:00.000Z"), makeBudget(profile));
    expect(shut.stats.sent).toBe(0);
    expect(mailer.outbox).toHaveLength(0);
    expect(shut.notes[0]).toContain("outside the send window");

    const open = await followUp(profile, mailer, store, new Date("2026-03-06T15:30:00.000Z"), makeBudget(profile));
    expect(open.stats.sent).toBe(1);
    expect(mailer.outbox).toHaveLength(1);
  });
});

describe("isDue", () => {
  const now = new Date("2026-03-05T13:00:00.000Z");
  it("is false when nothing is scheduled", () => {
    expect(isDue(undefined, now)).toBe(false);
  });
  it("is false before the scheduled time", () => {
    expect(isDue("2026-03-09T09:00:00.000Z", now)).toBe(false);
  });
  it("is true at or after the scheduled time", () => {
    expect(isDue("2026-03-05T09:00:00.000Z", now)).toBe(true);
  });
});

describe("lifecycle", () => {
  it("allows the forward path", () => {
    expect(canTransition("new", "enriched")).toBe(true);
    expect(canTransition("verified", "in_sequence")).toBe(true);
    expect(canTransition("replied", "handed_off")).toBe(true);
  });

  it("refuses to skip a stage or to move backwards", () => {
    expect(canTransition("new", "in_sequence")).toBe(false);
    expect(canTransition("replied", "in_sequence")).toBe(false);
  });

  it("treats a rewrite of the same state as valid, which is what makes re-runs safe", () => {
    expect(canTransition("in_sequence", "in_sequence")).toBe(true);
  });

  it("lets any live state short circuit to lost or disqualified, but never back out", () => {
    expect(canTransition("in_sequence", "disqualified")).toBe(true);
    expect(canTransition("disqualified", "in_sequence")).toBe(false);
    expect(canTransition("lost", "replied")).toBe(false);
  });
});

describe("scoreLead", () => {
  const base: Lead = {
    id: "l", companyName: "C", domain: "c.example", website: "https://c.example",
    lifecycle: "enriched", contactTrack: "general", score: 0, sent: [], tags: [],
  };
  const config = {
    weights: {
      hasEmail: 20, trackOwner: 15, trackGeneral: 5, hasPhone: 10, hasWebsite: 10,
      ratingAbove: { "4.0": 10, "4.5": 5 }, reviewsAbove: { "50": 10, "100": 5 },
    },
    qualifyThreshold: 40,
  };

  it("stacks the rating and review tiers", () => {
    const lead = { ...base, contactTrack: "owner" as const, email: "a@c.example", phone: "1", rating: 4.7, reviewCount: 130 };
    expect(scoreLead(lead, config)).toBe(85);
  });

  it("pays less for a role mailbox than for a named owner", () => {
    const owner = { ...base, contactTrack: "owner" as const, email: "a@c.example" };
    const general = { ...base, contactTrack: "general" as const, email: "a@c.example" };
    expect(scoreLead(owner, config)).toBeGreaterThan(scoreLead(general, config));
  });

  it("scores a bare lead at zero and never goes above 100", () => {
    expect(scoreLead({ ...base, website: "", contactTrack: "manual_review" }, config)).toBe(0);
    const loaded = { ...base, contactTrack: "owner" as const, email: "a@c.example", phone: "1", rating: 5, reviewCount: 999 };
    expect(scoreLead(loaded, { ...config, weights: { ...config.weights, hasEmail: 200 } })).toBe(100);
  });
});
