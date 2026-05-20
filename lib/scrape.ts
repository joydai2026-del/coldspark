import { execFileSync } from "child_process";
import * as cheerio from "cheerio";

// SSRF guard: block private/loopback IP ranges and localhost
// Covers IPv4 private ranges, IPv6 loopback/link-local/ULA, 0.0.0.0,
// IPv4-mapped IPv6, and file:// scheme. Only https/http allowed.
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^0\.0\.0\.0$/,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  // IPv6 loopback: both bare and bracket-wrapped forms
  /^\[?::1\]?$/,
  /^\[?::ffff:/i,        // IPv4-mapped IPv6
  /^\[?fc[0-9a-f]{2}:/i, // ULA
  /^\[?fe[89ab][0-9a-f]:/i, // link-local
];

function isBlockedHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Only allow http and https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    return BLOCKED_HOST_PATTERNS.some((p) => p.test(host));
  } catch {
    return true; // invalid URL — block it
  }
}

export async function scrapeUrl(url: string): Promise<string> {
  if (isBlockedHost(url)) {
    throw new Error(`SSRF_BLOCKED: ${url}`);
  }

  // Attempt 1: defuddle CLI — use execFileSync (not execSync) to avoid shell injection
  try {
    const raw = execFileSync("defuddle", [url, "--md"], {
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
  // redirect: "follow" (default) but we revalidate the final URL
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "ColdSpark/1.0 (+https://github.com/joydai2026-del/coldspark)" },
    });
    clearTimeout(timer);

    // Revalidate after redirects: block if final URL is private
    const finalUrl = resp.url;
    if (finalUrl && finalUrl !== url && isBlockedHost(finalUrl)) {
      throw new Error(`SSRF_BLOCKED (redirect): ${finalUrl}`);
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // Cap response body to avoid large-body memory attacks
    const html = (await resp.text()).slice(0, 500_000);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, [aria-hidden='true']").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return text.slice(0, 4000);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
