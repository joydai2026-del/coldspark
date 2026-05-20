import { NextRequest } from "next/server";
import { scrapeUrl } from "@/lib/scrape";
import { fillTemplate, Lead } from "@/lib/personalize";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RequestBody {
  leads: Lead[];
  template: string;
}

// CSV injection guard: prefix formula-starting cells with single quote
function csvSafe(value: string): string {
  if (typeof value === "string" && /^[=+\-@]/.test(value)) {
    return "'" + value;
  }
  return value;
}

function sanitizeErrorMessage(err: unknown): string {
  // Never leak raw internal error messages (provider details, file paths, etc.)
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.startsWith("SSRF_BLOCKED")) return "Blocked URL (SSRF guard)";
  if (msg.startsWith("HTTP ")) return msg; // safe to surface HTTP status
  if (msg.includes("API") || msg.includes("anthropic") || msg.includes("sk-")) {
    return "AI provider error";
  }
  // Generic fallback for anything else
  return "Processing error";
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { leads, template } = body;

  if (!leads || !Array.isArray(leads) || leads.length === 0) {
    return new Response(JSON.stringify({ error: "No leads provided" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (leads.length > 25) {
    return new Response(JSON.stringify({ error: "Max 25 leads per run" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!template || template.trim().length === 0) {
    return new Response(JSON.stringify({ error: "Template is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (template.length > 10_000) {
    return new Response(JSON.stringify({ error: "Template too long (max 10,000 chars)" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate each lead has required fields with sane lengths
  for (const lead of leads) {
    if (!lead.company || typeof lead.company !== "string") {
      return new Response(JSON.stringify({ error: "Each lead must have a 'company' field" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (lead.url && typeof lead.url === "string") {
      // Validate URL scheme server-side (blocks file://, javascript:, etc.)
      try {
        const parsed = new URL(lead.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return new Response(JSON.stringify({ error: `Invalid URL scheme for ${lead.company}: only http/https allowed` }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch {
        return new Response(JSON.stringify({ error: `Invalid URL for ${lead.company}` }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < leads.length; i++) {
        const lead = leads[i];
        try {
          // Scrape the company URL
          let pageText: string | null = null;
          if (lead.url) {
            try {
              pageText = await scrapeUrl(lead.url);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // SSRF block is a hard error — surface it but continue with other leads
              if (msg.startsWith("SSRF_BLOCKED")) {
                const line = JSON.stringify({
                  idx: i,
                  error: "Blocked URL (SSRF guard)",
                  original: lead,
                });
                controller.enqueue(encoder.encode(line + "\n"));
                continue;
              }
              // Other scrape errors: proceed without page text
              pageText = null;
            }
          }

          const filled = await fillTemplate(lead, template, pageText);

          // Apply CSV safety to all filled values
          const safeFilled: Record<string, string> = {};
          for (const [k, v] of Object.entries(filled)) {
            safeFilled[k] = csvSafe(v);
          }

          const line = JSON.stringify({
            idx: i,
            original: lead,
            filled: safeFilled,
            scraped: pageText !== null,
          });
          controller.enqueue(encoder.encode(line + "\n"));
        } catch (err) {
          const line = JSON.stringify({
            idx: i,
            error: sanitizeErrorMessage(err),
            original: lead,
          });
          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    },
  });
}
