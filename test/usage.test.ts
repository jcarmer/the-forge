import { describe, it, expect } from "vitest";
import manifest from "../sandbox.config.js";
import { parseClaudeUsage, parseAntigravityUsage, parseUsageWithFallback } from "../src/usage/parser.js";
import { pickProvider, scoreCloudProvider } from "../src/usage/router.js";
import type { UsageSnapshot } from "../src/usage/schema.js";

const SAMPLE_CLAUDE = `You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Nov 14, 4:39am (UTC)
Current week (all models): 35% used · resets Nov 21, 3am (UTC)
Current week (Fable): 10% used · resets Nov 21, 3am (UTC)`;

const SAMPLE_AGY = [
  "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-20T23:31:21Z",
  "Gemini Models\tFive Hour Limit Remaining\t99%\t2026-11-14T04:31:21Z",
  "Claude and GPT models\tWeekly Limit Remaining\t54%\t2026-11-20T22:53:45Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-14T08:53:45Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-21T03:56:47Z",
].join("\n");

describe("usage parser", () => {
  const now = new Date("2026-11-14T03:00:00Z");

  it("parses claude /usage output (converts % used -> % remaining)", () => {
    const entries = parseClaudeUsage(SAMPLE_CLAUDE, now);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ provider: "claude", scope: "5h", remainingPct: 80, resetsAt: "2026-11-14T04:39:00.000Z" });
    expect(entries[1]).toMatchObject({ provider: "claude", scope: "weekly", remainingPct: 65, resetsAt: "2026-11-21T03:00:00.000Z" });
    expect(entries[2]).toMatchObject({ provider: "claude", scope: "model_weekly", model: "Fable", remainingPct: 90 });
  });

  it("parses agy /usage tab-separated output", () => {
    const entries = parseAntigravityUsage(SAMPLE_AGY);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({ provider: "antigravity", scope: "weekly", model: "Gemini Models", remainingPct: 100 });
    expect(entries[1]).toMatchObject({ provider: "antigravity", scope: "5h", model: "Gemini Models", remainingPct: 99 });
    expect(entries[4]).toMatchObject({ provider: "antigravity", scope: "model_weekly", model: "Gemini 4 Argon", remainingPct: 100 });
  });

  it("falls back to Ollama then Haiku when deterministic parse yields nothing", async () => {
    const fallbackJson = JSON.stringify([
      { provider: "claude", scope: "weekly", remainingPct: 42, resetsAt: "2026-11-21T00:00:00Z" },
    ]);
    const res1 = await parseUsageWithFallback("claude", "unrecognized format", {
      ollamaParse: async () => fallbackJson,
      haikuParse: async () => null,
    });
    expect(res1.source).toBe("ollama");
    expect(res1.entries[0].remainingPct).toBe(42);

    const res2 = await parseUsageWithFallback("claude", "unrecognized format", {
      ollamaParse: async () => "not json",
      haikuParse: async () => fallbackJson,
    });
    expect(res2.source).toBe("haiku");
  });
});

describe("provider router", () => {
  const now = new Date("2026-11-14T03:00:00Z");
  const snap: UsageSnapshot = {
    collectedAt: now.toISOString(),
    sources: { antigravity: "deterministic", claude: "deterministic" },
    entries: [
      ...parseClaudeUsage(SAMPLE_CLAUDE, now),
      ...parseAntigravityUsage(SAMPLE_AGY),
    ],
  };

  it("prefers Ollama for trivial and normal tasks", () => {
    expect(pickProvider(manifest, snap, { complexity: "trivial", now }).provider).toBe("ollama");
    expect(pickProvider(manifest, snap, { complexity: "normal", now }).provider).toBe("ollama");
  });

  it("ranks cloud providers by remaining_weekly / hours_until_reset for hard tasks", () => {
    const decision = pickProvider(manifest, snap, { complexity: "hard", now });
    // Antigravity has 100% weekly vs Claude's 65% weekly, resetting around the same time
    expect(decision.provider).toBe("antigravity");
  });

  it("spends quota that resets sooner when remaining % is similar", () => {
    const s = scoreCloudProvider(
      [{ provider: "claude", scope: "weekly", remainingPct: 50, resetsAt: "2026-11-14T13:00:00Z" }],
      "claude",
      { minReservePct: 5, now },
    );
    const later = scoreCloudProvider(
      [{ provider: "claude", scope: "weekly", remainingPct: 50, resetsAt: "2026-11-20T03:00:00Z" }],
      "claude",
      { minReservePct: 5, now },
    );
    expect(s.score).toBeGreaterThan(later.score);
  });

  it("blocks a provider when its 5h window is exhausted", () => {
    const blockedSnap: UsageSnapshot = {
      ...snap,
      entries: snap.entries.map((e) =>
        e.provider === "antigravity" && e.scope === "5h" ? { ...e, remainingPct: 0 } : e,
      ),
    };
    const decision = pickProvider(manifest, blockedSnap, { complexity: "hard", now });
    expect(decision.provider).toBe("claude");
    expect(decision.blocked.antigravity).toContain("5h");
  });
});
