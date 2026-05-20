"use client";

import { useState, useRef } from "react";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Lead {
  name: string;
  company: string;
  url: string;
  [key: string]: string;
}

interface ProcessedRow {
  idx: number;
  original: Lead;
  filled?: Record<string, string>;
  error?: string;
  scraped?: boolean;
}

const DEFAULT_TEMPLATE = `Hi {first_name},

I noticed {company} is {company_hook}. We help companies like yours {value_prop}.

Would love to share how we could help — worth a quick 15-min call?

Best,
[Your name]`;

const SAMPLE_CSV_URL = "/sample-leads.csv";

export default function ColdSparkForm() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [results, setResults] = useState<ProcessedRow[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setResults([]);

    Papa.parse<Lead>(file, {
      header: true,
      skipEmptyLines: true,
      complete(result) {
        const rows = result.data as Lead[];
        if (rows.length === 0) {
          setError("CSV appears empty or has no data rows.");
          return;
        }
        if (!rows[0].url && !rows[0].company) {
          setError("CSV must have at least 'company' and 'url' columns.");
          return;
        }
        if (rows.length > 25) {
          setError("Max 25 leads per run. Please trim your CSV.");
          return;
        }
        setLeads(rows);
      },
      error(err) {
        setError(`CSV parse error: ${err.message}`);
      },
    });
  }

  async function handlePersonalize() {
    if (leads.length === 0) {
      setError("Please upload a CSV first.");
      return;
    }
    if (!template.includes("{")) {
      setError("Template must contain at least one {placeholder}.");
      return;
    }
    setError(null);
    setProcessing(true);
    setResults([]);
    setProgress(0);
    setTotal(leads.length);

    try {
      const resp = await fetch("/api/personalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads, template }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || "API error");
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      const collected: ProcessedRow[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const row: ProcessedRow = JSON.parse(line);
            collected.push(row);
            setProgress(collected.length);
            setResults([...collected]);
          } catch {
            // malformed NDJSON line — skip
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  }

  function downloadCsv() {
    if (results.length === 0) return;

    // Build rows: original columns + filled placeholder columns
    const rows = results.map((r) => {
      const base = { ...r.original };
      if (r.filled) {
        for (const [k, v] of Object.entries(r.filled)) {
          base[`filled_${k}`] = v;
        }
      }
      if (r.error) base["error"] = r.error;
      base["scraped"] = r.scraped ? "yes" : "no";
      return base;
    });

    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "coldspark-output.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const successCount = results.filter((r) => !r.error).length;
  const scrapedCount = results.filter((r) => r.scraped).length;

  return (
    <div className="max-w-3xl mx-auto px-4 py-12 space-y-8">
      {/* Hero */}
      <div className="text-center space-y-3">
        <h1 className="text-4xl font-bold tracking-tight">ColdSpark</h1>
        <p className="text-lg text-gray-600">
          Upload a CSV of leads, paste a template with {"{placeholders}"}, and get
          AI-personalized outreach in seconds.
        </p>
        <a
          href={SAMPLE_CSV_URL}
          download
          className="inline-block text-sm text-blue-600 underline hover:text-blue-800"
        >
          Download sample CSV (5 leads)
        </a>
      </div>

      {/* Step 1: Upload */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Step 1: Upload your CSV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-gray-500">
            Required columns: <code className="bg-gray-100 px-1 rounded">name</code>,{" "}
            <code className="bg-gray-100 px-1 rounded">company</code>,{" "}
            <code className="bg-gray-100 px-1 rounded">url</code>. Max 25 rows.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
          {fileName && (
            <p className="text-sm text-gray-600">
              Loaded: <strong>{fileName}</strong> — {leads.length} lead(s)
            </p>
          )}
        </CardContent>
      </Card>

      {/* Step 2: Template */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Step 2: Write your template</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-gray-500">
            Use {"{placeholders}"} for AI-filled content. Known lead fields (name, company, url) are
            also available as hints.
          </p>
          <Textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={10}
            className="font-mono text-sm"
            placeholder="Hi {first_name}, I noticed {company} is {company_hook}..."
          />
        </CardContent>
      </Card>

      {/* Action */}
      <div className="flex items-center gap-4">
        <Button
          onClick={handlePersonalize}
          disabled={processing || leads.length === 0}
          className="min-w-[160px]"
          size="lg"
        >
          {processing ? `Processing... (${progress}/${total})` : "Personalize"}
        </Button>
        {results.length > 0 && (
          <Button variant="outline" onClick={downloadCsv} size="lg">
            Download CSV
          </Button>
        )}
      </div>

      {/* Progress bar */}
      {processing && total > 0 && (
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all"
            style={{ width: `${(progress / total) * 100}%` }}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Results preview */}
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Results ({successCount}/{results.length} succeeded,{" "}
              {scrapedCount} with page data)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {results.map((r) => (
              <div
                key={r.idx}
                className={`p-3 rounded border text-sm ${
                  r.error
                    ? "bg-red-50 border-red-200"
                    : "bg-green-50 border-green-200"
                }`}
              >
                <div className="font-semibold mb-1">
                  {r.original.name} @ {r.original.company}
                  {r.error && (
                    <span className="ml-2 text-red-600 font-normal">
                      Error: {r.error}
                    </span>
                  )}
                  {!r.error && !r.scraped && (
                    <span className="ml-2 text-yellow-600 font-normal text-xs">
                      (no page data)
                    </span>
                  )}
                </div>
                {r.filled && (
                  <div className="space-y-1">
                    {Object.entries(r.filled).map(([k, v]) => (
                      <div key={k}>
                        <span className="font-mono text-xs bg-white px-1 rounded border">
                          {"{"}
                          {k}
                          {"}"}
                        </span>{" "}
                        {v}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
