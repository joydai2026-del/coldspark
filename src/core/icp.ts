// Ideal-customer-profile filter and the dropped-domain memory.
//
// Two cheap guards that stop the expensive stages from being wasted:
//  1. The blocklist keeps national chains out of an SMB program. Short
//     acronyms match on word boundaries so "Bayonne Tax" is not read as "ey".
//  2. Dropped domains are remembered with a TTL so next week's run does not
//     re-spend enrichment and verification credits on a domain that already
//     failed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function passesIcpFilter(
  companyName: string,
  blockTokens: readonly string[] = [],
  blockPhrases: readonly string[] = [],
): boolean {
  const name = (companyName ?? "").toLowerCase().trim();
  if (!name) return true;

  const tokens = blockTokens.map((t) => t.toLowerCase().trim()).filter(Boolean);
  if (tokens.length) {
    const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (new RegExp(`\\b(${escaped.join("|")})\\b`).test(name)) return false;
  }

  for (const phrase of blockPhrases) {
    const p = phrase.toLowerCase().trim();
    if (p && name.includes(p)) return false;
  }
  return true;
}

type DroppedFile = Record<string, number>;

export class DroppedDomains {
  private entries: DroppedFile = {};

  constructor(
    private readonly path: string | null,
    private readonly ttlDays: number,
    now: number = Date.now(),
  ) {
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as DroppedFile;
        const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
        for (const [domain, ts] of Object.entries(raw)) {
          if (now - ts < ttlMs) this.entries[domain] = ts;
        }
      } catch {
        this.entries = {};
      }
    }
  }

  has(domain: string): boolean {
    return domain.toLowerCase() in this.entries;
  }

  add(domain: string, now: number = Date.now()): void {
    const key = domain.toLowerCase();
    if (!this.entries[key]) this.entries[key] = now;
  }

  size(): number {
    return Object.keys(this.entries).length;
  }

  flush(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }
}
