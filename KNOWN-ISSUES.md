# ColdSpark Known Issues

## Security (Post R2 Review)

### KI-001: SSRF — defuddle redirect path not revalidated

**Severity:** Medium (mitigated)
**Status:** Known, not fixed (hard cap 2 review rounds)

The `defuddle` CLI path in `lib/scrape.ts` uses `execFileSync` (safe from shell injection), but if `defuddle` internally follows redirects to a private IP, we do not revalidate the final destination. The `fetch()` path DOES revalidate after redirects.

**Mitigations already in place:**
- All inputs are URL-parsed and scheme-validated before defuddle is called
- `execFileSync` is used (not `execSync`) so the URL cannot inject shell commands
- If defuddle is not in PATH (which is the case in most deployments), the code falls through to the fetch path which does revalidate

**To harden further:** wrap defuddle output with a timeout + validate final resolved IP via `dns.promises.lookup()` before calling defuddle.

### KI-002: DNS rebinding not defended

**Severity:** Low (requires network-level attacker)
**Status:** Known, accepted

Hostname-to-IP resolution is not re-checked before fetch. A DNS rebinding attack could bypass the regex blocklist. Mitigation: deploy behind a network firewall that blocks outbound connections to RFC1918 ranges.

### KI-003: No rate limiting

**Severity:** Medium (cost risk on public deployment)
**Status:** Known, accepted for MVP

No per-IP or per-session rate limit. A 25-lead batch burns ~25 Anthropic API calls. Add rate limiting middleware before making the app public.

## Functionality

### KI-004: No real-time browser streaming in all environments

Papa Parse's streaming and Next.js's ReadableStream work correctly, but some reverse proxies buffer the NDJSON stream. The `X-Accel-Buffering: no` header addresses Nginx, but Vercel's edge may buffer short responses.
