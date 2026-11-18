import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildStory } from "../src/sessions/story.js";
import { parseAntigravityTranscript } from "../src/sessions/parse.js";
import { enactImprovement, generateImprovements } from "../src/sessions/improve.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

describe("sessions self-improvement loop & remediation guidance", () => {
  let tmp: string;
  let repoDir: string;
  let claudeDir: string;
  let stateDir: string;
  let logDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "forge-improve-"));
    repoDir = join(tmp, "repo");
    claudeDir = join(tmp, "claude");
    stateDir = join(tmp, "state");
    logDir = join(tmp, "logs");
    mkdirSync(join(repoDir, "ops"), { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    cpSync(join(REPO_ROOT, "ops", "claude-user"), join(repoDir, "ops", "claude-user"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeT3Session(name: string) {
    const T = (sec: number) => new Date(Date.now() - (600 - sec) * 1000).toISOString();
    const line = (sec: number, payload: object) =>
      `[${T(sec)}] NTIVE: ${JSON.stringify({ provider: "claudeAgent", event: { direction: "incoming", payload } })}`;
    const asst = (sec: number, id: string, content: unknown[]) =>
      line(sec, {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id,
          model: "claude-opus-4-6",
          content,
          usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
        },
      });
    const use = (id: string, name: string, input: object = {}) => ({ type: "tool_use", id, name, input });
    const res = (sec: number, id: string, content: string, is_error = false) =>
      line(sec, { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } });

    const lines = [
      line(0, { type: "query.open", effort: "xhigh", permissionMode: "default", cwd: "/opt/the-forge" }),
      line(1, { type: "system", subtype: "init", cwd: "/opt/the-forge", skills: ["verify"], agents: ["Explore"], mcp_servers: [{ name: "ollama-helper" }] }),
      line(2, { type: "prompt.offer", message: { uuid: "u1", message: { content: "Find the auth bug" } } }),
    ];
    for (let i = 0; i < 9; i++) {
      lines.push(
        asst(10 + i * 3, `msg_${i}`, [use(`c_${i}`, "Bash", { command: `grep -rn auth src/${i}` })]),
        res(11 + i * 3, `c_${i}`, "match".repeat(12_000), i < 3),
      );
    }
    lines.push(line(90, { type: "result", uuid: "r1", session_id: "S1", total_cost_usd: 0.45, duration_api_ms: 10000, duration_ms: 25000, num_turns: 9, result: "Done" }));
    const file = join(logDir, name);
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  it("includes remediation and actionId on detected findings", () => {
    const f = writeT3Session("events.remed-11111111.log");
    const story = buildStory(f, "t3-provider", { repoDir });
    const bashForSearch = story.findings.find((x) => x.id === "bash-for-search");
    expect(bashForSearch).toBeDefined();
    expect(bashForSearch?.remediation).toContain("Grep");
    expect(bashForSearch?.actionId).toBe("tighten-bash-guard");

    const serial = story.findings.find((x) => x.id === "serial-exploration");
    expect(serial).toBeDefined();
    expect(serial?.remediation).toContain("Batch 3+ independent");
    expect(serial?.actionId).toBe("enforce-batch-lookups");

    const bigResults = story.findings.find((x) => x.id === "big-tool-results");
    expect(bigResults).toBeDefined();
    expect(bigResults?.actionId).toBe("cap-big-tool-results");
  });

  it("generates actions and data-collection suggestions for a 4-hour window (4/24 days) and enacts them permanently in the repo", async () => {
    writeT3Session("events.loop-22222222.log");
    const src = { t3ProviderLogDir: logDir, claudeProjectsDir: join(tmp, "none") };

    const report = await generateImprovements(4 / 24, {
      repoDir,
      claudeDir,
      stateDir,
      src,
      useOllama: false,
    });

    expect(report.days).toBeCloseTo(4 / 24);
    expect(report.sessionsAnalyzed).toBe(1);
    expect(report.actions.length).toBeGreaterThanOrEqual(6);
    expect(report.dataCollection).toHaveLength(4);

    // Triggered findings in the 4h window should be high priority
    const tighten = report.actions.find((a) => a.id === "tighten-bash-guard");
    expect(tighten?.priority).toBe("high");
    expect(tighten?.applied).toBe(false);

    // Enact a repo action: tighten-bash-guard
    const out1 = await enactImprovement(
      { id: "tighten-bash-guard", days: 4 / 24 },
      { repoDir, claudeDir, stateDir, src },
    );
    expect(out1.ok).toBe(true);
    expect(out1.modifiedFiles).toContain("ops/claude-user/bash-guard.mjs");
    expect(out1.report.actions.find((a) => a.id === "tighten-bash-guard")?.applied).toBe(true);

    // Enact data collection: collect-bash-guard-blocks
    const out2 = await enactImprovement(
      { id: "collect-bash-guard-blocks", days: 4 / 24 },
      { repoDir, claudeDir, stateDir, src },
    );
    expect(out2.ok).toBe(true);
    expect(out2.report.dataCollection.find((d) => d.id === "collect-bash-guard-blocks")?.applied).toBe(true);

    // Verify upgraded bash-guard.mjs blocks unbounded rg / head -n 500 and logs blocks to FORGE_GUARD_LOG
    const guardPath = join(repoDir, "ops", "claude-user", "bash-guard.mjs");
    const mod = (await import(`${pathToFileURL(guardPath).href}?t=${Date.now()}`)) as {
      checkBashCommand: (cmd: string, cwd?: string, env?: Record<string, string>) => string | null;
      MAX_HEAD_TAIL_LINES: number;
    };
    expect(mod.MAX_HEAD_TAIL_LINES).toBe(200);
    const blockLog = join(stateDir, "bash-guard-blocks.jsonl");
    const reason1 = mod.checkBashCommand("rg foo src", tmp, { FORGE_GUARD_LOG: blockLog });
    expect(reason1).toContain("Use the Grep tool");
    const reason2 = mod.checkBashCommand("head -n 500 file.ts", tmp, { FORGE_GUARD_LOG: blockLog });
    expect(reason2).toContain("200 lines");
    // Bounded head and grep single-file still allowed
    expect(mod.checkBashCommand("head -n 80 file.ts", tmp, { FORGE_GUARD_LOG: blockLog })).toBeNull();
    expect(existsSync(blockLog)).toBe(true);
    expect(readFileSync(blockLog, "utf8").trim().split("\n")).toHaveLength(2);

    // Enact tool error snippet collection and verify buildStory captures errorText & settings
    const out3 = await enactImprovement(
      { id: "collect-tool-error-details", days: 4 / 24 },
      { repoDir, claudeDir, stateDir, src },
    );
    expect(out3.ok).toBe(true);
    const storyAfter = buildStory(join(logDir, "events.loop-22222222.log"), "t3-provider", { repoDir });
    expect(storyAfter.settings).toEqual({ effort: "xhigh", permissionMode: "default" });
    expect(storyAfter.calls.find((c) => c.isError)?.errorText).toBeDefined();

    // Enact hook & compact telemetry script and verify settings.json registration in claudeDir
    const out4 = await enactImprovement(
      { id: "collect-hook-and-compact-telemetry", days: 4 / 24 },
      { repoDir, claudeDir, stateDir, src },
    );
    expect(out4.ok).toBe(true);
    expect(existsSync(join(repoDir, "ops", "claude-user", "session-telemetry.mjs"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks.PreCompact).toBeDefined();
    expect(settings.hooks.PostToolUseFailure).toBeDefined();
  });

  it("parses Antigravity ACP transcripts when enabled", () => {
    const brainDir = join(tmp, "ag", "prov1", "antigravity-acp", "brain", "conv-12345678", ".system_generated", "logs");
    mkdirSync(brainDir, { recursive: true });
    const file = join(brainDir, "transcript.jsonl");
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 55_000).toISOString();
    const t2 = new Date(Date.now() - 50_000).toISOString();
    writeFileSync(
      file,
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: t0, content: "Inspect sessions tab" }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: t1,
          model: "gemini-4-argon",
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_tokens: 800,
          content: "Checking files",
          tool_calls: [
            { id: "tc1", name: "view_file", args: { AbsolutePath: "/opt/the-forge/src/cli.ts" } },
            { id: "tc2", name: "call_mcp_tool", args: { ServerName: "ollama-helper", ToolName: "local_summarize_files" } },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          type: "TOOL_RESPONSE",
          created_at: t2,
          tool_call_id: "tc1",
          content: "file contents",
        }),
      ].join("\n") + "\n",
    );

    const parsed = parseAntigravityTranscript(file);
    expect(parsed.source).toBe("antigravity-transcript");
    expect(parsed.id).toBe("conv-12345678");
    expect(parsed.stepCount).toBe(1);
    expect(parsed.totals.fresh).toBe(1500);
    expect(parsed.mcp).toEqual([{ server: "ollama-helper", calls: 1, tools: { local_summarize_files: 1 }, attributedFresh: 750 }]);

    const story = buildStory(file, "antigravity-transcript", { repoDir });
    expect(story.turns).toHaveLength(1);
    expect(story.turns[0].prompt).toBe("Inspect sessions tab");
    expect(story.calls).toHaveLength(2);
    expect(story.capabilities.used.mcpServers).toEqual(["ollama-helper"]);
  });
});
