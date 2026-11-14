import { z } from "zod";
import { UsageEntrySchema, type ProviderName, type UsageEntry } from "./schema.js";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parses human dates like "Nov 14, 4:39am (UTC)" or "Nov 21, 3am (UTC)" into ISO-8601 UTC. */
export function parseClaudeResetDate(raw: string, now = new Date()): string | null {
  const m = raw.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?(am|pm)\s*\(UTC\)$/i);
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return null;
  const day = Number(m[2]);
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const min = m[4] ? Number(m[4]) : 0;

  let year = now.getUTCFullYear();
  let dt = new Date(Date.UTC(year, mon, day, hour, min, 0));
  // Handle year rollover (e.g. Dec -> Jan)
  if (dt.getTime() < now.getTime() - 24 * 3600 * 1000) {
    year += 1;
    dt = new Date(Date.UTC(year, mon, day, hour, min, 0));
  }
  return dt.toISOString();
}

/** Deterministic parser for `claude -p "/usage"` output. */
export function parseClaudeUsage(raw: string, now = new Date()): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^Current\s+(session|week\s+\(([^)]+)\)):\s*(\d+(?:\.\d+)?)%\s*used\s*[·•-]\s*resets\s+(.+)$/i);
    if (!m) continue;
    const isSession = m[1].toLowerCase() === "session";
    const bucket = m[2]?.trim();
    const used = Number(m[3]);
    const resetsAt = parseClaudeResetDate(m[4], now);
    if (!resetsAt) continue;

    const scope = isSession ? "5h" : bucket?.toLowerCase() === "all models" ? "weekly" : "model_weekly";
    entries.push({
      provider: "claude",
      scope,
      ...(scope === "model_weekly" && bucket ? { model: bucket } : {}),
      remainingPct: Math.max(0, Math.min(100, 100 - used)),
      resetsAt,
    });
  }
  return entries;
}

/** Deterministic parser for `agy -p "/usage"` tab-separated output. */
export function parseAntigravityUsage(raw: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 4) continue;
    const [bucket, label, pctStr, iso] = parts;
    const pctMatch = pctStr.match(/^(\d+(?:\.\d+)?)%$/);
    if (!pctMatch || Number.isNaN(Date.parse(iso))) continue;

    const lower = label.toLowerCase();
    const scope = lower.includes("five hour") || lower.includes("5h")
      ? "5h"
      : lower.includes("weekly") && bucket.toLowerCase().includes("models")
        ? "weekly"
        : "model_weekly";

    entries.push({
      provider: "antigravity",
      scope,
      model: bucket,
      remainingPct: Number(pctMatch[1]),
      resetsAt: new Date(iso).toISOString(),
    });
  }
  return entries;
}

export type LlmParseFn = (provider: ProviderName, raw: string) => Promise<string | null>;

const EntryListSchema = z.array(UsageEntrySchema);

/**
 * Parses `/usage` output: deterministic first (0 tokens), then Ollama JSON, then Haiku JSON.
 */
export async function parseUsageWithFallback(
  provider: "claude" | "antigravity",
  raw: string,
  opts: { now?: Date; ollamaParse?: LlmParseFn; haikuParse?: LlmParseFn } = {},
): Promise<{ entries: UsageEntry[]; source: "deterministic" | "ollama" | "haiku" | "error" }> {
  const now = opts.now ?? new Date();
  const det = provider === "claude" ? parseClaudeUsage(raw, now) : parseAntigravityUsage(raw);
  if (det.length > 0) return { entries: det, source: "deterministic" };

  for (const [name, fn] of [["ollama", opts.ollamaParse], ["haiku", opts.haikuParse]] as const) {
    if (!fn) continue;
    try {
      const jsonText = await fn(provider, raw);
      if (!jsonText) continue;
      const parsed = EntryListSchema.safeParse(JSON.parse(jsonText));
      if (parsed.success && parsed.data.length > 0) {
        return { entries: parsed.data, source: name };
      }
    } catch {
      // Fall through to next parser
    }
  }
  return { entries: [], source: "error" };
}
