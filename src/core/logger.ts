// Minimal leveled logger. No dependencies, no transport, no PII policy to
// get wrong: it writes to stderr so stdout stays clean for machine output.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = (process.env.COLDSPARK_LOG_LEVEL as LogLevel) || "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`[${level}] ${msg}${suffix}\n`);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
