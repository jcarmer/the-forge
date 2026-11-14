import type { Manifest } from "../schema.js";
import type { ProviderName, UsageEntry, UsageSnapshot } from "./schema.js";

export type TaskComplexity = "trivial" | "normal" | "hard";

export interface RouteRequest {
  complexity: TaskComplexity;
  /** Providers already tried that failed (e.g. escalation). */
  exclude?: ProviderName[];
  /** Optional model/bucket hint for per-model weekly limit checks. */
  modelHint?: string;
  /** Minimum remaining % required before considering a cloud provider blocked. */
  minReservePct?: number;
  now?: Date;
}

export interface RouteDecision {
  provider: ProviderName | null;
  reason: string;
  scores: Partial<Record<ProviderName, number>>;
  blocked: Partial<Record<ProviderName, string>>;
}

function hoursUntil(iso: string, now: Date): number {
  const ms = Date.parse(iso) - now.getTime();
  return Math.max(0.25, ms / 3_600_000);
}

/**
 * Evaluates a cloud provider's entries for blockers and computes its burn-rate score:
 * `remainingPct / hoursUntilReset` (higher = more quota about to expire, so use it first).
 */
export function scoreCloudProvider(
  entries: UsageEntry[],
  provider: "antigravity" | "claude",
  opts: { minReservePct: number; modelHint?: string; now: Date },
): { blockedReason?: string; score: number } {
  const mine = entries.filter((e) => e.provider === provider);
  if (mine.length === 0) return { blockedReason: "no usage data", score: -1 };

  const fiveHour = mine.filter((e) => e.scope === "5h");
  if (fiveHour.length > 0 && fiveHour.every((e) => e.remainingPct <= opts.minReservePct)) {
    return { blockedReason: `5h limit at ${Math.max(...fiveHour.map((e) => e.remainingPct))}%`, score: -1 };
  }

  const weekly = mine.filter((e) => e.scope === "weekly");
  if (weekly.length > 0 && weekly.every((e) => e.remainingPct <= opts.minReservePct)) {
    return { blockedReason: `weekly limit at ${Math.max(...weekly.map((e) => e.remainingPct))}%`, score: -1 };
  }

  if (opts.modelHint) {
    const hint = opts.modelHint.toLowerCase();
    const modelLimits = mine.filter((e) => e.scope === "model_weekly" && e.model?.toLowerCase().includes(hint));
    if (modelLimits.some((e) => e.remainingPct <= opts.minReservePct)) {
      return { blockedReason: `model limit (${opts.modelHint}) exhausted`, score: -1 };
    }
  }

  // Score across available weekly windows (preferring ones resetting sooner with more % left).
  const pool = weekly.length > 0 ? weekly : mine.filter((e) => e.scope === "model_weekly");
  if (pool.length === 0) return { blockedReason: "no weekly window found", score: -1 };

  const best = Math.max(...pool.map((e) => e.remainingPct / hoursUntil(e.resetsAt, opts.now)));
  return { score: Number(best.toFixed(4)) };
}

/**
 * Picks the best provider for a task:
 * - Prefers Ollama first for `trivial` and `normal` tasks (zero cloud token cost).
 * - For `hard` tasks (or when Ollama is excluded), ranks Antigravity and Claude live by
 *   `remaining_weekly / hours_until_reset`, respecting 5h and model_weekly blockers.
 */
export function pickProvider(manifest: Manifest, snapshot: UsageSnapshot, req: RouteRequest): RouteDecision {
  const now = req.now ?? new Date();
  const minReservePct = req.minReservePct ?? 5;
  const excluded = new Set(req.exclude ?? []);
  const scores: Partial<Record<ProviderName, number>> = {};
  const blocked: Partial<Record<ProviderName, string>> = {};

  const priorityMap = new Map(manifest.providers.map((p) => [p.name, p.priority]));

  if (req.complexity !== "hard" && !excluded.has("ollama") && priorityMap.has("ollama")) {
    return {
      provider: "ollama",
      reason: `local-first policy for ${req.complexity} task`,
      scores: { ollama: Infinity },
      blocked,
    };
  }
  if (excluded.has("ollama")) blocked.ollama = "excluded (escalated)";

  const candidates: ("antigravity" | "claude")[] = [];
  for (const name of ["antigravity", "claude"] as const) {
    if (!priorityMap.has(name)) continue;
    if (excluded.has(name)) {
      blocked[name] = "excluded";
      continue;
    }
    const res = scoreCloudProvider(snapshot.entries, name, { minReservePct, modelHint: req.modelHint, now });
    if (res.blockedReason) {
      blocked[name] = res.blockedReason;
    } else {
      scores[name] = res.score;
      candidates.push(name);
    }
  }

  candidates.sort((a, b) => {
    const diff = (scores[b] ?? 0) - (scores[a] ?? 0);
    if (Math.abs(diff) > 1e-6) return diff;
    return (priorityMap.get(a) ?? 99) - (priorityMap.get(b) ?? 99);
  });

  if (candidates.length > 0) {
    const chosen = candidates[0];
    return {
      provider: chosen,
      reason: `highest weekly-burn score (${scores[chosen]})`,
      scores,
      blocked,
    };
  }

  // Last-resort fallback to Ollama even on hard tasks if all cloud providers are blocked
  if (!excluded.has("ollama") && priorityMap.has("ollama")) {
    return {
      provider: "ollama",
      reason: "all cloud providers blocked; falling back to local Ollama",
      scores: { ...scores, ollama: 0 },
      blocked,
    };
  }

  return { provider: null, reason: "no available provider", scores, blocked };
}
