import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStory, renderStoryText } from "../src/sessions/story.js";
import { parseT3ProviderLog } from "../src/sessions/parse.js";
import { buildOverview, renderDigest } from "../src/sessions/digest.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "story-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
const line = (sec: number, payload: object) => `[${T(sec)}] NTIVE: ${JSON.stringify({ provider: "claudeAgent", event: { direction: "incoming", payload } })}`;
const usage = (out: number) => ({ input_tokens: 1, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 });
const asst = (sec: number, id: string, content: unknown[], parent?: string) =>
  line(sec, { type: "assistant", parent_tool_use_id: parent ?? null, message: { id, model: "claude-opus-5-5", content, usage: usage(20) } });
const use = (id: string, name: string, input: object = {}) => ({ type: "tool_use", id, name, input });
const result = (sec: number, id: string, content: string, err = false) =>
  line(sec, { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: err }] } });
const prompt = (sec: number, text: string, uuid: string) => line(sec, { type: "prompt.offer", message: { uuid, message: { content: text } } });
const done = (sec: number, uuid: string, cost: number, apiMs: number, ownMs: number, text = "ok") =>
  line(sec, { type: "result", uuid, session_id: "S1", total_cost_usd: cost, duration_api_ms: apiMs, duration_ms: ownMs, num_turns: 3, result: text });

function write(name: string, lines: string[]) {
  const f = join(dir, name);
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

function fixture() {
  const f = join(dir, "events.thread-aaaaaaaa.log");
  // Older chunk (rotated): turn 1, begins with the SDK's first result so cost baseline is known.
  writeFileSync(`${f}.1`, [
    line(0, { type: "system", subtype: "init", cwd: "/p", skills: ["verify", "dataviz"], agents: ["Explore"], mcp_servers: [{ name: "ollama-helper" }, { name: "t3-code" }] }),
    prompt(1, "Fix the login bug", "u1"),
    asst(2, "msg_1", [use("t1", "Read", { file_path: "/p/a.ts" }), use("t2", "Read", { file_path: "/p/b.ts" })]),
    result(4, "t1", "x".repeat(100)),
    result(6, "t2", "y".repeat(100)),
    done(10, "r1", 1.0, 8000, 9000, "Fixed it"),
  ].join("\n") + "\n");
  writeFileSync(f, [
    prompt(100, "Now run the tests and use a helper", "u2"),
    asst(101, "msg_2", [use("t3", "Bash", { command: "cat > /tmp/x.sh <<'EOF'\necho hi\nEOF" }), use("t4", "mcp__ollama-helper__local_summarize_files", {}), use("t5", "Skill", { skill: "verify" })]),
    result(103, "t3", "ok"),
    result(105, "t4", "z".repeat(80_000)),
    result(106, "t5", "loaded"),
    asst(107, "msg_3", [use("t6", "Agent", { subagent_type: "Explore", description: "find auth code" })]),
    // sub-agent work, inside its own context
    asst(110, "msg_side", [use("t7", "Grep", { pattern: "auth" })], "t6"),
    result(112, "t7", "hits"),
    result(130, "t6", "found it"),
    asst(131, "msg_4", [use("t8", "Bash", { command: "npm test", run_in_background: true })]),
    result(132, "t8", "started in background"),
    line(132, { type: "system", subtype: "task_started", tool_use_id: "t8", task_id: "b1" }),
    line(190, { type: "system", subtype: "task_notification", tool_use_id: "t8", task_id: "b1", status: "completed" }),
    asst(192, "msg_5", [{ type: "text", text: "done" }]),
    done(200, "r2", 1.6, 30000, 100000, "All green"),
  ].join("\n") + "\n");
  return f;
}

describe("story", () => {
  it("reads rotated chunks, splits turns, and computes per-turn cost from the cumulative counter", () => {
    const f = fixture();
    const s = buildStory(f, "t3-provider");
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0].prompt).toBe("Fix the login bug");
    expect(s.turns[0].costUsd).toBeCloseTo(1.0);
    expect(s.turns[1].costUsd).toBeCloseTo(0.6);
    expect(s.totals.costUsd).toBeCloseTo(1.6);
    expect(s.totals.costComplete).toBe(true);
    expect(s.turns[1].outcome).toBe("All green");
    // token parser sees the rotated chunk too
    expect(parseT3ProviderLog(f).stepCount).toBe(6);
  });

  it("flags unknown history when the log starts mid-session", () => {
    const f = write("events.mid-bbbbbbbb.log", [prompt(0, "go", "u"), asst(1, "msg_a", [use("a", "Read", { file_path: "/q" })]), result(2, "a", "x"), done(5, "r", 40, 4_000_000, 5000)]);
    const s = buildStory(f, "t3-provider");
    expect(s.turns[0].costUsd).toBeNull();
    expect(s.totals.costComplete).toBe(false);
  });

  it("measures parallelism, sub-agents, background work and capabilities", () => {
    const s = buildStory(fixture(), "t3-provider");
    const byName = Object.fromEntries(s.calls.map((c) => [c.id, c]));
    expect(s.parallel.parallelSteps).toBe(2); // msg_1 (2 reads) and msg_2 (3 calls)
    expect(s.parallel.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(s.parallel.savedMs).toBeGreaterThan(0);
    expect(byName.t6).toMatchObject({ kind: "agent", durMs: 23_000 });
    expect(byName.t7.sidechain).toBe(true);
    expect(s.subagents).toMatchObject({ count: 1 });
    expect(s.subagents.freshTokens).toBeGreaterThan(0);
    expect(byName.t8).toMatchObject({ background: true, durMs: 59_000 });
    expect(byName.t5.kind).toBe("skill");
    expect(byName.t4).toMatchObject({ kind: "mcp", server: "ollama-helper" });
    expect(s.capabilities.used).toMatchObject({ skills: ["verify"], mcpServers: ["ollama-helper"] });
    expect(s.capabilities.available.skills).toEqual(["verify", "dataviz"]);
    // background run does not count as time the model was blocked
    expect(s.turns[1].toolMs).toBeLessThan(60_000);
  });

  it("produces findings: credits for offload/sub-agents/parallelism, big results, and ignores heredoc writes", () => {
    const s = buildStory(fixture(), "t3-provider");
    const ids = s.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["subagents-used", "local-offload", "big-tool-results", "parallel-used"]));
    expect(ids).not.toContain("bash-for-search");
  });

  it("flags serial exploration and shell-based search", () => {
    const lines = [prompt(0, "explore", "u")];
    for (let i = 0; i < 9; i++) {
      lines.push(asst(1 + i * 3, `msg_s${i}`, [use(`g${i}`, "Bash", { command: `grep -rn foo src/${i}` })]), result(2 + i * 3, `g${i}`, "line"));
    }
    lines.push(done(40, "r", 0.1, 1000, 40000));
    const s = buildStory(write("events.serial-cccccccc.log", lines), "t3-provider");
    const ids = s.findings.map((f) => f.id);
    expect(ids).toContain("serial-exploration");
    expect(ids).toContain("bash-for-search");
  });

  it("redaction removes prompts, labels and outcomes", () => {
    const s = buildStory(fixture(), "t3-provider", { redact: true });
    expect(s.turns[0].prompt).toBe("");
    expect(s.turns[0].outcome).toBe("");
    expect(s.calls.every((c) => c.label === "")).toBe(true);
    expect(renderStoryText(s)).not.toContain("login bug");
  });

  it("digest aggregates and lists capabilities that were available but never used", () => {
    const s = buildStory(fixture(), "t3-provider");
    const o = buildOverview([s], 7);
    expect(o.mcp[0]).toMatchObject({ server: "ollama-helper", calls: 1 });
    expect(o.availableNeverUsed.skills).toEqual(["dataviz"]);
    expect(o.availableNeverUsed.mcpServers).toEqual(["t3-code"]);
    const md = renderDigest([s], o);
    expect(md).toContain("Available but never used");
    expect(md).toContain("Fix the login bug");
    expect(renderDigest([buildStory(fixture(), "t3-provider", { redact: true })], o, { redact: true })).not.toContain("Fix the login bug");
  });
});
