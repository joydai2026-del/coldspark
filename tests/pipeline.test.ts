// End to end over the fixture providers: the exact path `npm run demo` runs.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../src/core/clock.js";
import { loadProfile } from "../src/core/config.js";
import { MemoryLeadStore } from "../src/core/store.js";
import { runPipeline } from "../src/pipeline.js";
import {
  dryRunMailer,
  fixtureEnricher,
  fixtureInbox,
  fixtureLeadSource,
  fixturePersonalizer,
  fixtureVerifier,
  loadSampleCompanies,
  loadSampleReplies,
} from "../src/providers/fixture.js";
import { ruleClassifier } from "../src/stages/classify.js";
import { DEMO_CHECK_AT, DEMO_SEND_AT, parseArgs } from "../src/cli.js";

async function run(industry = "accounting") {
  const companies = loadSampleCompanies();
  const store = new MemoryLeadStore();
  const mailer = dryRunMailer();
  const report = await runPipeline({
    profile: loadProfile(industry),
    store,
    now: fixedClock(DEMO_SEND_AT).now(),
    checkAt: fixedClock(DEMO_CHECK_AT).now(),
    providers: {
      leadSource: fixtureLeadSource(companies),
      enricher: fixtureEnricher(companies),
      verifier: fixtureVerifier(companies),
      personalizer: fixturePersonalizer(companies),
      mailer,
      inbox: fixtureInbox(loadSampleReplies(), mailer.outbox, () => new Map(store.all().map((l) => [l.domain, l]))),
      classifier: ruleClassifier,
    },
  });
  return { report, mailer, store };
}

function lead(report: Awaited<ReturnType<typeof run>>["report"], name: string) {
  const found = report.leads.find((l) => l.companyName === name);
  if (!found) throw new Error(`no lead named ${name}`);
  return found;
}

describe("dry run over the sample data", () => {
  it("sends nothing for real", async () => {
    const { report, mailer } = await run();
    expect(report.dryRun).toBe(true);
    expect(report.leads.flatMap((l) => l.sent).every((m) => m.dryRun)).toBe(true);
    expect(mailer.outbox.every((m) => m.to.endsWith(".example"))).toBe(true);
  });

  it("rejects a blocklisted firm before spending anything on it", async () => {
    const { report } = await run();
    expect(report.leads.some((l) => l.companyName.startsWith("Grantham"))).toBe(false);
    expect(report.stages[0]!.stats.icp_rejected).toBe(1);
    expect(report.stages[0]!.stats.below_rating_floor).toBe(1);
  });

  it("routes a verified decision maker to the owner track and greets them by name", async () => {
    const { report, mailer } = await run();
    const northgate = lead(report, "Northgate Books");
    expect(northgate.contactTrack).toBe("owner");
    expect(northgate.email).toBe("dana.reyes@northgate-books.example");
    const first = mailer.outbox.find((m) => m.to === northgate.email);
    expect(first?.body.startsWith("Hi Dana,")).toBe(true);
  });

  it("uses the role mailbox when the personal address bounces, and never greets it by name", async () => {
    const { report, mailer } = await run();
    const harborlight = lead(report, "Harborlight Tax Group");
    expect(harborlight.contactTrack).toBe("general");
    expect(harborlight.email).toBe("hello@harborlight-tax.example");
    expect(harborlight.contactName).toBe("");
    expect(mailer.outbox.find((m) => m.to === harborlight.email)?.body.startsWith("Hi there,")).toBe(true);
  });

  it("drops an undeliverable lead with no fallback", async () => {
    const { report } = await run();
    const quill = lead(report, "Quill CPA Studio");
    expect(quill.lifecycle).toBe("disqualified");
    expect(quill.sent).toHaveLength(0);
  });

  it("demotes an owner contact with no title instead of sending a hollow greeting", async () => {
    const { report, mailer } = await run();
    const cedar = lead(report, "Cedar Close CPA");
    expect(cedar.contactTrack).toBe("general");
    expect(mailer.outbox.find((m) => m.to === cedar.email)?.body.startsWith("Hi there,")).toBe(true);
  });

  it("holds a risky address for a human", async () => {
    const { report } = await run();
    const summit = lead(report, "Summit Books and Payroll");
    expect(summit.contactTrack).toBe("manual_review");
    expect(summit.sent).toHaveLength(0);
  });

  it("holds a lead it could not research rather than sending empty copy", async () => {
    const { report } = await run();
    const ironwood = lead(report, "Ironwood Accounting Co-op");
    expect(ironwood.tags).toContain("held:no_research");
    expect(ironwood.sent).toHaveLength(0);
  });

  it("grounds the copy in what the research found", async () => {
    const { report, mailer } = await run();
    const northgate = lead(report, "Northgate Books");
    expect(northgate.research).toContain("restaurant groups");
    const body = mailer.outbox.find((m) => m.to === northgate.email)!.body;
    expect(body).toContain("monthly close and payroll for restaurant groups");
    expect(body).not.toMatch(/\{[a-z_]+\}/);
  });

  it("advances the lifecycle in the same write that records the send", async () => {
    // A separate write would mean a crash in between could re-send the intro.
    const { report } = await run();
    for (const lead of report.leads) {
      if (lead.sent.length > 0) expect(lead.lifecycle).not.toBe("verified");
    }
  });

  it("threads every follow-up under the first message", async () => {
    const { report, mailer } = await run();
    const cedar = lead(report, "Cedar Close CPA");
    expect(cedar.sent).toHaveLength(2);
    expect(cedar.sent[1]!.references).toEqual([cedar.sent[0]!.messageId]);
    expect(new Set(mailer.outbox.map((m) => m.messageId)).size).toBe(mailer.outbox.length);
  });

  it("stops the sequence on a real reply and hands a positive one off", async () => {
    const { report } = await run();
    const northgate = lead(report, "Northgate Books");
    expect(northgate.replyClass).toBe("positive");
    expect(northgate.lifecycle).toBe("handed_off");
    expect(northgate.nextStepDueAt).toBeUndefined();
    expect(report.packets.map((p) => p.companyName)).toEqual(["Northgate Books"]);
  });

  it("stops on a decline but leaves it with a human", async () => {
    const { report } = await run();
    const maple = lead(report, "Maple Ledger Associates");
    expect(maple.replyClass).toBe("negative");
    expect(maple.lifecycle).toBe("replied");
    expect(report.packets.some((p) => p.companyName === "Maple Ledger Associates")).toBe(false);
  });

  it("disqualifies an unsubscribe and never sends it again", async () => {
    const { report } = await run();
    const bayonne = lead(report, "Bayonne Tax Services");
    expect(bayonne.replyClass).toBe("unsubscribe");
    expect(bayonne.lifecycle).toBe("disqualified");
    expect(bayonne.sent).toHaveLength(1);
  });

  it("does not treat an out-of-office as a reply, and resumes after the stated return date", async () => {
    const { report } = await run();
    const harborlight = lead(report, "Harborlight Tax Group");
    expect(harborlight.replyClass).toBeUndefined();
    expect(harborlight.lifecycle).toBe("in_sequence");
    expect(harborlight.nextStepDueAt?.slice(0, 10)).toBe("2026-03-16");
    expect(harborlight.tags.some((t) => t.startsWith("auto_reply:"))).toBe(true);
  });

  it("sends the second step only to the lead that was actually due", async () => {
    const { report } = await run();
    const followUpStage = report.stages.find((s) => s.stage === "follow-up")!;
    expect(followUpStage.stats.sent).toBe(1);
    expect(followUpStage.stats.waiting).toBe(1);
  });

  it("runs a different vertical from configuration alone", async () => {
    const { report } = await run("dental");
    expect(report.leads.map((l) => l.companyName)).toEqual([
      "Brightmile Family Dental",
      "Oakframe Orthodontics",
    ]);
    // The dental profile sets a higher bar, so the weaker practice does not qualify.
    expect(lead(report, "Oakframe Orthodontics").lifecycle).toBe("disqualified");
    expect(lead(report, "Brightmile Family Dental").sent).toHaveLength(1);
  });

  it("is deterministic: the same inputs produce the same run", async () => {
    const a = await run();
    const b = await run();
    expect(JSON.stringify(a.report.leads)).toBe(JSON.stringify(b.report.leads));
  });
});

describe("cli argument parsing", () => {
  it("defaults to a run against the accounting profile", () => {
    expect(parseArgs([])).toMatchObject({ command: "run", industry: "accounting", dryRun: false });
  });
  it("reads the flags", () => {
    expect(parseArgs(["run", "-i", "dental", "--dry-run", "--json", "--state", "s"])).toMatchObject({
      industry: "dental",
      dryRun: true,
      json: true,
      state: "s",
    });
  });
});

describe("the command an engineer actually types", () => {
  // Spawns the real CLI. If `npm run demo` is broken, this fails.
  function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("npx", ["tsx", "src/cli.ts", ...args], {
      cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
      encoding: "utf-8",
      env: { ...process.env, COLDSPARK_LOG_LEVEL: "error" },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("runs the demo end to end and prints a usable report", () => {
    const { status, stdout } = cli(["run", "-i", "accounting", "--dry-run", "--json"]);
    expect(status).toBe(0);
    const report = JSON.parse(stdout) as { dryRun: boolean; leads: unknown[]; stages: unknown[] };
    expect(report.dryRun).toBe(true);
    expect(report.leads).toHaveLength(8);
    expect(report.stages).toHaveLength(8);
  }, 60_000);

  it("refuses to run without --dry-run, because no live adapters ship here", () => {
    const { status, stderr } = cli(["run", "-i", "accounting"]);
    expect(status).toBe(2);
    expect(stderr).toContain("--dry-run is required");
  }, 60_000);

  it("does not re-send to anyone on a second run against the same state", () => {
    const dir = mkdtempSync(join(tmpdir(), "coldspark-state-"));
    try {
      const first = cli(["run", "-i", "accounting", "--dry-run", "--json", "--state", dir]);
      expect(first.status).toBe(0);
      const before = JSON.parse(first.stdout) as { leads: Array<{ id: string; sent: unknown[] }> };
      const sentBefore = before.leads.reduce((n, l) => n + l.sent.length, 0);
      expect(sentBefore).toBeGreaterThan(0);

      const second = cli(["run", "-i", "accounting", "--dry-run", "--json", "--state", dir]);
      expect(second.status).toBe(0);
      const after = JSON.parse(second.stdout) as { leads: Array<{ id: string; sent: unknown[] }> };
      const sentAfter = after.leads.reduce((n, l) => n + l.sent.length, 0);

      // Same leads, same messages. Re-running the pipeline is a no-op.
      expect(after.leads).toHaveLength(before.leads.length);
      expect(sentAfter).toBe(sentBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
