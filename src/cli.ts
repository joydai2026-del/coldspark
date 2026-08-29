#!/usr/bin/env -S npx tsx
// Command line entry point.
//
//   coldspark run --industry accounting --dry-run
//   coldspark industries
//   coldspark validate --industry dental
//
// Only --dry-run is implemented as a runnable path in this repo. A live run
// needs real provider adapters, which are deliberately not bundled here: see
// the README section "What is distilled and what is illustrative".

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fixedClock } from "./core/clock.js";
import { ConfigError, listIndustries, loadProfile } from "./core/config.js";
import { setLogLevel, type LogLevel } from "./core/logger.js";
import { JsonFileLeadStore, MemoryLeadStore } from "./core/store.js";
import { runPipeline } from "./pipeline.js";
import {
  dryRunMailer,
  fixtureEnricher,
  fixtureInbox,
  fixtureLeadSource,
  fixturePersonalizer,
  fixtureVerifier,
  loadSampleCompanies,
  loadSampleReplies,
} from "./providers/fixture.js";
import { ruleClassifier } from "./stages/classify.js";
import type { Lead } from "./core/types.js";

// The demo runs two fixed ticks so one command shows both halves of the loop.
// 2026-03-02 is a Monday and 2026-03-05 is the Thursday that follows it. Both
// instants are 10:30 and 11:00 in New York, inside both shipped profiles'
// send windows.
export const DEMO_SEND_AT = "2026-03-02T15:30:00.000Z";
export const DEMO_CHECK_AT = "2026-03-05T16:00:00.000Z";

interface Args {
  command: string;
  industry: string;
  dryRun: boolean;
  out?: string;
  state?: string;
  logLevel?: LogLevel;
  json: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "run", industry: "accounting", dryRun: false, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--industry" || flag === "-i") args.industry = argv[++i] ?? args.industry;
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--state") args.state = argv[++i];
    else if (flag === "--json") args.json = true;
    else if (flag === "--log-level") args.logLevel = argv[++i] as LogLevel;
    else if (flag === "--help" || flag === "-h") args.command = "help";
  }
  return args;
}

const HELP = `coldspark

  coldspark run --industry <name> --dry-run [--state dir] [--out report.json] [--json]
  coldspark industries
  coldspark validate --industry <name>

Flags
  --industry, -i   industry profile from config/industries (default: accounting)
  --dry-run        run against the fabricated sample data, send nothing
  --state          directory for the lead store and dropped-domain memory.
                   Without it the run is stateless, so a second run repeats it.
  --out            write the full JSON report to a file
  --json           print the JSON report to stdout instead of the table
  --log-level      debug | info | warn | error (default: info)
`;

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printReport(report: Awaited<ReturnType<typeof runPipeline>>): void {
  const out: string[] = [];
  out.push("");
  out.push(`  industry   ${report.industry}`);
  out.push(`  mode       ${report.dryRun ? "DRY RUN, nothing was sent" : "LIVE"}`);
  out.push(`  send tick  ${report.startedAt}`);
  out.push("");
  out.push(`  ${pad("STAGE", 16)}RESULT`);
  out.push(`  ${"-".repeat(74)}`);
  for (const stage of report.stages) {
    const counters = Object.entries(stage.stats)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    out.push(`  ${pad(stage.stage, 16)}${counters || "(nothing to do)"}`);
    for (const note of stage.notes) out.push(`  ${pad("", 16)}note: ${note}`);
  }

  out.push("");
  out.push(`  ${pad("LEAD", 30)}${pad("TRACK", 15)}${pad("LIFECYCLE", 14)}${pad("SENT", 6)}NEXT / OUTCOME`);
  out.push(`  ${"-".repeat(94)}`);
  for (const lead of report.leads) {
    out.push(
      `  ${pad(lead.companyName, 30)}${pad(lead.contactTrack, 15)}${pad(lead.lifecycle, 14)}${pad(
        String(lead.sent.length),
        6,
      )}${describe(lead)}`,
    );
  }

  if (report.packets.length) {
    out.push("");
    out.push("  HANDED OFF");
    for (const packet of report.packets) {
      out.push(`   - ${packet.companyName} (${packet.contact}) answered step "${packet.answeredStep}"`);
      out.push(`     research: ${packet.research.slice(0, 96)}`);
      out.push(`     next: ${packet.destination}`);
    }
  }
  out.push("");
  process.stdout.write(out.join("\n") + "\n");
}

function describe(lead: Lead): string {
  if (lead.replyClass) return `reply: ${lead.replyClass}`;
  if (lead.sequenceStoppedReason) return lead.sequenceStoppedReason;
  if (lead.nextStepDueAt) return `next step ${lead.nextStepDueAt.slice(0, 10)}`;
  const held = lead.tags.find((t) => t.startsWith("held:") || t.startsWith("verdict:") || t.startsWith("dropped:"));
  return held ?? "";
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.logLevel) setLogLevel(args.logLevel);

  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.command === "industries") {
    for (const id of listIndustries()) {
      const profile = loadProfile(id);
      process.stdout.write(`${pad(id, 14)}${profile.label} (${profile.sequence.steps.length} steps)\n`);
    }
    return 0;
  }

  if (args.command === "validate") {
    const profile = loadProfile(args.industry);
    process.stdout.write(`ok: ${profile.id} (${profile.sequence.steps.length} steps)\n`);
    return 0;
  }

  if (args.command !== "run") {
    process.stderr.write(`unknown command "${args.command}"\n\n${HELP}`);
    return 2;
  }

  if (!args.dryRun) {
    process.stderr.write(
      "Refusing to run: this repo ships fixture providers only, so --dry-run is required.\n" +
        "A live run needs real adapters for the six ports in src/ports/index.ts.\n",
    );
    return 2;
  }

  const profile = loadProfile(args.industry);
  const companies = loadSampleCompanies();
  const replies = loadSampleReplies();
  const stateDir = args.state ? resolve(args.state) : undefined;
  const store = stateDir ? new JsonFileLeadStore(join(stateDir, "leads.json")) : new MemoryLeadStore();
  const mailer = dryRunMailer();

  const report = await runPipeline({
    profile,
    store,
    droppedDomainsPath: stateDir ? join(stateDir, "dropped-domains.json") : null,
    now: fixedClock(DEMO_SEND_AT).now(),
    checkAt: fixedClock(DEMO_CHECK_AT).now(),
    providers: {
      leadSource: fixtureLeadSource(companies),
      enricher: fixtureEnricher(companies),
      verifier: fixtureVerifier(companies),
      personalizer: fixturePersonalizer(companies),
      mailer,
      inbox: fixtureInbox(replies, mailer.outbox, () => new Map(store.all().map((l) => [l.domain, l]))),
      classifier: ruleClassifier,
    },
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printReport(report);
  }

  if (args.out) {
    const path = resolve(args.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...report, outbox: mailer.outbox }, null, 2), "utf-8");
    process.stderr.write(`report written to ${path}\n`);
  }

  return 0;
}

// Only run when invoked directly, so tests can import parseArgs and the demo
// timestamps without the process exiting under them.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof ConfigError) {
        process.stderr.write(`config error: ${err.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}
