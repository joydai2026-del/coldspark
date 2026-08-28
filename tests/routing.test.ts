import { describe, expect, it } from "vitest";
import { ownerTrackIsUsable, routeContact } from "../src/stages/verify.js";
import type { EmailVerdict } from "../src/core/types.js";

const contact = { email: "dana@acme.example", firstName: "Dana", lastName: "Reyes", title: "Partner" };
const policy = { failClosed: true, riskyPolicy: "manual_review" as const };

function verifier(map: Record<string, EmailVerdict>, available = true) {
  return { available, verify: async (email: string) => map[email] ?? "risky" };
}

describe("routeContact", () => {
  it("puts a verified personal address on the owner track", async () => {
    const d = await routeContact(contact, "info@acme.example", verifier({ "dana@acme.example": "valid" }), policy);
    expect(d).toMatchObject({ decision: "write", track: "owner", email: "dana@acme.example", contactTitle: "Partner" });
  });

  it("falls back to the role mailbox when the personal address is invalid, and clears the name", async () => {
    const d = await routeContact(
      contact,
      "info@acme.example",
      verifier({ "dana@acme.example": "invalid", "info@acme.example": "valid" }),
      policy,
    );
    expect(d.track).toBe("general");
    expect(d.email).toBe("info@acme.example");
    // The person is not the recipient of a role mailbox, so their identity must not travel with it.
    expect(d.contactName).toBe("");
    expect(d.contactTitle).toBe("");
  });

  it("drops the lead when the only address is undeliverable", async () => {
    const d = await routeContact(contact, undefined, verifier({ "dana@acme.example": "invalid" }), policy);
    expect(d.decision).toBe("drop");
  });

  it("drops when both the personal and the role address are undeliverable", async () => {
    const d = await routeContact(
      contact,
      "info@acme.example",
      verifier({ "dana@acme.example": "invalid", "info@acme.example": "invalid" }),
      policy,
    );
    expect(d.decision).toBe("drop");
  });

  it("holds a risky verdict for a human instead of sending", async () => {
    const d = await routeContact(null, "info@acme.example", verifier({ "info@acme.example": "risky" }), policy);
    expect(d).toMatchObject({ decision: "write", track: "manual_review", tag: "verdict:risky" });
  });

  it("drops a risky verdict when the profile says drop", async () => {
    const d = await routeContact(null, "info@acme.example", verifier({ "info@acme.example": "risky" }), {
      failClosed: true,
      riskyPolicy: "drop",
    });
    expect(d.decision).toBe("drop");
  });

  it("treats a provider failure as risky, never as valid", async () => {
    const d = await routeContact(null, "info@acme.example", verifier({ "info@acme.example": "api_failed" }), policy);
    expect(d.track).toBe("manual_review");
  });

  it("fails closed when the verifier is unavailable", async () => {
    const d = await routeContact(contact, "info@acme.example", verifier({}, false), policy);
    expect(d.track).toBe("manual_review");
    expect(d.tag).toBe("verifier:unavailable");
  });

  it("can be configured to fail open, and then never claims an owner track", async () => {
    const d = await routeContact(contact, "info@acme.example", verifier({}, false), {
      failClosed: false,
      riskyPolicy: "manual_review",
    });
    expect(d.track).toBe("general");
    expect(d.contactName).toBe("");
  });

  it("holds a lead with no address at all", async () => {
    const d = await routeContact(null, undefined, verifier({}), policy);
    expect(d).toMatchObject({ track: "manual_review", tag: "no_address" });
  });
});

describe("ownerTrackIsUsable", () => {
  it("requires both a full name and a title", () => {
    expect(ownerTrackIsUsable("Dana Reyes", "Partner")).toBe(true);
    expect(ownerTrackIsUsable("Dana", "Partner")).toBe(false);
    expect(ownerTrackIsUsable("Dana Reyes", "")).toBe(false);
    expect(ownerTrackIsUsable(undefined, undefined)).toBe(false);
  });
});
