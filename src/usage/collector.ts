import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Manifest } from "../schema.js";
import { run } from "../ops.js";
import { parseUsageWithFallback, type LlmParseFn } from "./parser.js";
import { UsageSnapshotSchema, type ProviderName, type UsageEntry, type UsageSnapshot } from "./schema.js";

function buildParsePrompt(provider: ProviderName, raw: string): string {
  return `Extract usage limits from this ${provider} CLI output as a JSON array.
Each element must match: {"provider":"${provider}","scope":"5h"|"weekly"|"model_weekly","model"?:string,"remainingPct":number,"resetsAt":ISO8601_UTC_STRING}.
Output ONLY a valid JSON array, no markdown.\n\n${raw}`;
}

export async function ollamaParseUsage(model: string, provider: ProviderName, raw: string): Promise<string | null> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: buildParsePrompt(provider, raw), stream: false, format: "json" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    return data.response ?? null;
  } catch {
    return null;
  }
}

export function haikuParseInContainer(containerName: string): LlmParseFn {
  return async (provider, raw) => {
    const prompt = buildParsePrompt(provider, raw).replace(/'/g, "'\\''");
    const r = run("docker", ["exec", containerName, "bash", "-lc", `timeout 20 claude -p --model claude-haiku-4-5 '${prompt}'`]);
    return r.code === 0 ? r.out.trim() : null;
  };
}

function execInTarget(containerName: string | null, cmd: string) {
  if (containerName) return run("docker", ["exec", containerName, "bash", "-lc", `timeout 20 ${cmd}`]);
  return run("bash", ["-lc", `timeout 20 ${cmd}`]);
}

/**
 * Collects live `/usage` output from Antigravity and Claude, parses with fallback chain,
 * and falls back to `quotas.json` if live collection fails. Writes `usage.json`.
 */
export async function collectUsage(
  manifest: Manifest,
  stateDir: string,
  opts: { containerName?: string | null } = {},
): Promise<UsageSnapshot> {
  const container = opts.containerName === undefined ? manifest.containerName : opts.containerName;
  const entries: UsageEntry[] = [];
  const sources: UsageSnapshot["sources"] = {};

  for (const p of manifest.providers) {
    if (p.name === "ollama" || !p.usageCommand) continue;
    const r = execInTarget(container, p.usageCommand);
    if (r.code !== 0 || !r.out.trim()) {
      sources[p.name] = "error";
      continue;
    }
    const parsed = await parseUsageWithFallback(p.name, r.out, {
      ollamaParse: (prov, raw) => ollamaParseUsage(manifest.ollama.primaryModel, prov, raw),
      haikuParse: container ? haikuParseInContainer(container) : undefined,
    });
    sources[p.name] = parsed.source;
    entries.push(...parsed.entries);
  }

  // Fallback to manual quotas.json for any provider that failed live collection
  const manualPath = join(stateDir, "quotas.json");
  if (existsSync(manualPath)) {
    try {
      const manual = UsageSnapshotSchema.shape.entries.parse(JSON.parse(readFileSync(manualPath, "utf8")));
      for (const m of manual) {
        if (sources[m.provider] === "error" || !entries.some((e) => e.provider === m.provider)) {
          entries.push(m);
          sources[m.provider] = "manual";
        }
      }
    } catch {
      // Ignore malformed manual file
    }
  }

  const snapshot: UsageSnapshot = {
    collectedAt: new Date().toISOString(),
    entries,
    sources,
  };
  const outPath = join(stateDir, "usage.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  return snapshot;
}
