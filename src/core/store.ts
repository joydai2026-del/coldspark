// Lead store.
//
// The production system keeps leads in a spreadsheet so a human can read and
// edit the same rows the agents write. That coupling is not portable, so this
// repo ships a JSON-file store behind the same narrow interface: get, upsert,
// update, all. Point it at Postgres or Sheets by writing one more class.

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Lead } from "./types.js";

export interface LeadStore {
  all(): Lead[];
  get(id: string): Lead | undefined;
  upsert(lead: Lead): void;
  update(id: string, patch: Partial<Lead>): Lead | undefined;
  /**
   * Persist, if this store persists. Called after every send, not only at the
   * end of a run, so a crash cannot lose the record of mail already dispatched
   * and cause the next run to send it again.
   */
  flush?(): void;
}

export class MemoryLeadStore implements LeadStore {
  protected leads = new Map<string, Lead>();

  all(): Lead[] {
    return [...this.leads.values()];
  }

  get(id: string): Lead | undefined {
    return this.leads.get(id);
  }

  upsert(lead: Lead): void {
    this.leads.set(lead.id, lead);
  }

  update(id: string, patch: Partial<Lead>): Lead | undefined {
    const current = this.leads.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.leads.set(id, next);
    return next;
  }
}

/** MemoryLeadStore that loads from and flushes to a JSON file atomically. */
export class JsonFileLeadStore extends MemoryLeadStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Lead[];
        for (const lead of raw) this.leads.set(lead.id, lead);
      } catch {
        // Corrupt file starts empty rather than crashing a scheduled run.
      }
    }
  }

  flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 2), "utf-8");
    renameSync(tmp, this.path);
  }
}
