import { execSync } from "child_process";
import * as cheerio from "cheerio";

// SSRF guard: block private/loopback IP ranges and localhost
const BLOCKED_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function isBlockedHost(urlStr: string): boolean {
  try {
    const { hostname } = new URL(urlStr);
    return BLOCKED_PATTERNS.some((p) => p.test(hostname));
  } catch {
    return true; // invalid URL — block it
  }
}

export async function scrapeUrl(url: string): Promise<string> {
  if (isBlockedHost(url)) {
    throw new Error(`SSRF_BLOCKED: ${url}`);
  }

  // Attempt 1: defuddle CLI
  try {
    const raw = execSync(`defuddle ${JSON.stringify(url)} --md`, {
      timeout: 8000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (raw && raw.length > 100) {
      return raw.slice(0, 4000);
    }
  } catch {
    // defuddle not available or failed — fall through to fetch+cheerio
  }

  // Attempt 2: native fetch + cheerio
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "ColdSpark/1.0 (+https://github.com/joydai2026-del/coldspark)" },
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, [aria-hidden='true']").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return text.slice(0, 4000);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
