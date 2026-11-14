import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeTranscript, parseT3ProviderLog, listSessions, toolServer } from "../src/sessions/parse.js";
import { annotateWithOllama, deterministicFlags } from "../src/sessions/analyze.js";

const usage = (o: number, cr = 0, cc = 0) => ({ input_tokens: 2, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc });
const asst = (id: string, ts: string, content: unknown[], u: object) => ({ type: "assistant", timestamp: ts, cwd: "/p", message: { id, model: "m1", content, usage: u } });

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "sess-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function transcript() {
  const f = join(dir, "claude", "-p", "sess-aaaaaaaa.jsonl");
  mkdirSync(join(dir, "claude", "-p"), { recursive: true });
  const lines = [
    // one message split across two lines, usage grows while streaming
    asst("msg_1", "2026-01-01T00:00:01Z", [{ type: "text", text: "hi" }], usage(10, 100, 50)),
    asst("msg_1", "2026-01-01T00:00:02Z", [{ type: "tool_use", id: "t1", name: "mcp__srv__do_it" }, { type: "tool_use", id: "t2", name: "Bash" }], usage(40, 100, 50)),
    asst("msg_2", "2026-01-01T00:00:03Z", [{ type: "tool_use", id: "t3", name: "mcp__srv__do_it" }], usage(5, 200, 30000)),
    { type: "user", message: { content: "ignored" } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  return f;
}

describe("session parsing", () => {
  it("dedupes split messages, keeps max usage, and attributes MCP calls", () => {
    const d = parseClaudeTranscript(transcript());
    expect(d.stepCount).toBe(2);
    expect(d.steps[0]).toMatchObject({ output: 40, cacheRead: 100, cacheCreate: 50, fresh: 2 + 40 + 50 });
    expect(d.project).toBe("/p");
    expect(d.mcp).toHaveLength(1);
    expect(d.mcp[0]).toMatchObject({ server: "srv", calls: 2, tools: { do_it: 2 } });
    expect(d.builtinTools).toEqual({ Bash: 1 });
    // step 1 has 2 tool calls so the MCP call gets half of its fresh tokens; step 2 gets all of its fresh tokens
    expect(d.mcp[0].attributedFresh).toBe(Math.round(92 / 2 + 30007));
  });

  it("parses T3 provider logs, including repeated stages and linked Claude session ids", () => {
    const msg = { id: "msg_9", model: "m1", content: [{ type: "tool_use", id: "x", name: "mcp__t3-code__link_pull_request" }], usage: usage(7, 10, 20) };
    const ev = (e: object) => `[2026-01-01T00:00:0${1}.000Z] NTIVE: ${JSON.stringify({ event: e })}`;
    const f = join(dir, "events.thread-1234.log");
    writeFileSync(f, [
      ev({ payload: { type: "query.open", options: { cwd: "/proj", sessionId: "sess-aaaaaaaa", allowedTools: ["mcp__t3-code__*"] } } }),
      ev({ payload: { event: { message: msg } } }),
      ev({ payload: { event: { message: msg } } }),
      "garbage line",
    ].join("\n"));
    const d = parseT3ProviderLog(f);
    expect(d).toMatchObject({ id: "thread-1234", project: "/proj", stepCount: 1, claudeSessionIds: ["sess-aaaaaaaa"], allowedMcp: ["t3-code"] });
    expect(d.mcp[0]).toMatchObject({ server: "t3-code", calls: 1 });
  });

  it("hides a Claude transcript that a T3 thread already covers", () => {
    transcript();
    const msg = { id: "msg_9", model: "m1", content: [], usage: usage(7) };
    writeFileSync(join(dir, "events.thread-1234.log"), `[2026-01-01T00:00:01.000Z] NTIVE: ${JSON.stringify({ event: { payload: { options: { sessionId: "sess-aaaaaaaa" }, event: { message: msg } } } })}\n`);
    const list = listSessions({ claudeProjectsDir: join(dir, "claude"), t3ProviderLogDir: dir });
    expect(list.map((s) => s.source)).toEqual(["t3-provider"]);
  });

  it("extracts mcp server names", () => {
    expect(toolServer("mcp__t3-code__x")).toBe("t3-code");
    expect(toolServer("Bash")).toBeUndefined();
  });
});

describe("analysis", () => {
  it("flags cache spikes and top-cost steps deterministically", () => {
    const f = join(dir, "claude", "-p", "spiky.jsonl");
    const steps = [1, 2, 3, 4].map((n) => asst(`msg_s${n}`, `2026-01-01T00:00:0${n}Z`, [], usage(100, 5000, 500)));
    steps.push(asst("msg_big", "2026-01-01T00:00:09Z", [], usage(100, 5000, 40000)));
    writeFileSync(f, steps.map((l) => JSON.stringify(l)).join("\n"));
    const kinds = deterministicFlags(parseClaudeTranscript(f)).map((x) => x.kind);
    expect(kinds).toContain("cache-spike");
    expect(kinds).toContain("top-cost");
  });

  it("sends only metadata to Ollama and filters notes to known step ids", async () => {
    const d = parseClaudeTranscript(transcript());
    let sent = "";
    const fetchImpl = async (_u: string, init: { body: string }) => {
      sent = init.body;
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify({ notes: [{ id: "msg_2", note: "big cache write" }, { id: "bogus", note: "x" }] }) }) };
    };
    const a = await annotateWithOllama(d, { model: "qwen", fetchImpl });
    expect(a.notes).toEqual([{ stepId: "msg_2", note: "big cache write" }]);
    expect(sent).not.toContain("hi");
    expect(sent).toContain("mcp__srv__do_it");
  });

  it("reports Ollama failures instead of throwing", async () => {
    const d = parseClaudeTranscript(transcript());
    const a = await annotateWithOllama(d, { model: "qwen", fetchImpl: async () => { throw new Error("connection refused"); } });
    expect(a).toMatchObject({ ok: false, detail: "connection refused" });
  });
});
