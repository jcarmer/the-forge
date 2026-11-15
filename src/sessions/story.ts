import { readFileSync, statSync } from "node:fs";
import { parseSessionFile, readT3LogText, toolServer, type SessionSource } from "./parse.js";

/**
 * "Story" view of a conversation: what was asked, what was done, how long each part took, and where
 * skills / MCP servers / sub-agents / parallel tool calls were (or weren't) used.
 *
 * Everything here is *measured* from the logs (timestamps, result sizes, SDK cost counters). Nothing
 * estimates what would have happened without a skill or MCP, because the logs cannot show that.
 */

export type CallKind = "builtin" | "mcp" | "skill" | "agent";

export interface Call {
  id: string;
  name: string;
  kind: CallKind;
  server?: string;
  /** Short human description: Bash command, file path, skill name, sub-agent task... Blank when redacted. */
  label: string;
  /** Offset from the first record of the session. */
  startMs: number;
  /** Time until the tool result arrived (or, for background work, until it finished). Null if no result was logged. */
  durMs: number | null;
  /** Ran in the background (the model kept working while it ran). */
  background: boolean;
  resultChars: number;
  isError: boolean;
  turn: number;
  /** Assistant message that issued the call: calls sharing one were issued in parallel. */
  stepId: string;
  /** Issued from inside a sub-agent. */
  sidechain: boolean;
}

export interface Turn {
  index: number;
  prompt: string;
  outcome: string;
  startMs: number;
  endMs: number;
  wallMs: number;
  /** Time the tools blocked the model (union of overlapping calls). */
  toolMs: number;
  /** Time waiting on an AskUserQuestion answer. */
  userWaitMs: number;
  /** Wall time not covered by tools or user waits: model thinking/writing. */
  modelMs: number;
  /** Idle gap between the end of the previous turn and the start of this one. */
  idleBeforeMs: number;
  steps: number;
  calls: number;
  costUsd: number | null;
  models: string[];
}

export interface Finding {
  id: string;
  severity: "good" | "info" | "suggest";
  title: string;
  detail: string;
  evidence: string[];
  turn?: number;
}

export interface Capabilities {
  skills: string[];
  agents: string[];
  mcpServers: string[];
}

export interface SessionStory {
  id: string;
  source: SessionSource;
  title: string;
  project?: string;
  startedAt: string;
  endedAt: string;
  models: string[];
  turns: Turn[];
  calls: Call[];
  totals: {
    wallMs: number;
    activeMs: number;
    idleMs: number;
    toolMs: number;
    modelMs: number;
    userWaitMs: number;
    costUsd: number | null;
    /** False when the log starts mid-session, so the turns before it are missing from the cost. */
    costComplete: boolean;
    freshTokens: number;
    totalTokens: number;
    steps: number;
    compactions: number;
  };
  parallel: {
    /** Assistant messages that issued 2+ tool calls at once. */
    parallelSteps: number;
    maxConcurrent: number;
    /** Sum of call durations minus the time they actually blocked: the wall time overlap bought. */
    savedMs: number;
  };
  subagents: { count: number; backgroundCount: number; totalMs: number; freshTokens: number; totalTokens: number };
  /** Skills / agents / MCP servers the session advertised at start vs which were actually called. */
  capabilities: { available: Capabilities; used: Capabilities };
  findings: Finding[];
}

export interface StoryOptions {
  /** Drop prompts, commands and file paths so only counts and timings remain. */
  redact?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading logs into a common record shape

interface Rec {
  ts: number;
  type: "prompt" | "assistant" | "tool_results" | "result" | "init" | "task_started" | "task_done" | "compact" | "title";
  p: Record<string, any>;
  side: boolean;
}

const asObj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

function promptText(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (asObj(b).type === "text" ? String(asObj(b).text ?? "") : "")).join(" ") : "";
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, (m) => (m.startsWith("<command-") ? m.replace(/<[^>]+>/g, " ") : " "))
    .replace(/\s+/g, " ")
    .trim();
}

function readT3(file: string): Rec[] {
  const out: Rec[] = [];
  const lineRe = /^\[([^\]]+)\] [A-Z_]+: (\{.*\})\s*$/;
  for (const line of readT3LogText(file).split("\n")) {
    const m = line.match(lineRe);
    if (!m) continue;
    let o: any;
    try {
      o = JSON.parse(m[2]);
    } catch {
      continue;
    }
    const p = asObj(asObj(o.event).payload);
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts)) continue;
    const side = !!p.parent_tool_use_id;
    switch (p.type) {
      case "prompt.offer": {
        const text = promptText(asObj(asObj(p.message).message).content);
        if (text) out.push({ ts, type: "prompt", p: { text, uuid: asObj(p.message).uuid }, side: false });
        break;
      }
      case "assistant":
        out.push({ ts, type: "assistant", p, side });
        break;
      case "user":
        if (Array.isArray(asObj(p.message).content)) out.push({ ts, type: "tool_results", p, side });
        break;
      case "result":
        out.push({ ts, type: "result", p, side: false });
        break;
      case "system":
        if (p.subtype === "init") out.push({ ts, type: "init", p, side: false });
        else if (p.subtype === "task_started") out.push({ ts, type: "task_started", p, side: false });
        else if (p.subtype === "task_notification") out.push({ ts, type: "task_done", p, side: false });
        else if (p.subtype === "compact_boundary") out.push({ ts, type: "compact", p, side: false });
        else if (p.subtype === "session_title_changed") out.push({ ts, type: "title", p, side: false });
        break;
    }
  }
  return out;
}

function readTranscript(file: string): Rec[] {
  const out: Rec[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(String(o.timestamp ?? ""));
    if (!Number.isFinite(ts)) {
      if (o.type === "custom-title" && typeof o.customTitle === "string") out.push({ ts: 0, type: "title", p: { title: o.customTitle }, side: false });
      continue;
    }
    const side = o.isSidechain === true;
    if (o.type === "assistant") out.push({ ts, type: "assistant", p: o, side });
    else if (o.type === "user" && !o.isMeta) {
      const content = asObj(o.message).content;
      if (Array.isArray(content) && content.some((b) => asObj(b).type === "tool_result")) out.push({ ts, type: "tool_results", p: o, side });
      else if (!side) {
        const text = promptText(content);
        if (text) out.push({ ts, type: "prompt", p: { text }, side: false });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels and classification

const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function labelFor(name: string, input: Record<string, any>, cwd?: string): string {
  const path = (v: unknown) => {
    const s = typeof v === "string" ? v : "";
    return cwd && s.startsWith(`${cwd}/`) ? s.slice(cwd.length + 1) : s;
  };
  switch (name) {
    case "Bash":
      return shorten(String(input.description ?? input.command ?? "").split("\n")[0], 90);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return shorten(path(input.file_path ?? input.notebook_path), 90);
    case "Grep":
    case "Glob":
      return shorten(String(input.pattern ?? ""), 90);
    case "Skill":
      return String(input.skill ?? input.name ?? "");
    case "Agent":
    case "Task":
      return shorten(`${input.subagent_type ?? "agent"}: ${input.description ?? input.prompt ?? ""}`, 100);
    case "WebFetch":
      return shorten(String(input.url ?? ""), 90);
    case "ToolSearch":
      return shorten(String(input.query ?? ""), 90);
    default:
      return "";
  }
}

const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"]);
const EXPLORE_BASH = /^(ls|cat|head|tail|grep|rg|find|wc|stat|tree|file|du|pwd|git\s+(status|log|diff|show|branch|ls-files|blame)|sed\s+-n)\b/;
const bashHead = (cmd: string) => cmd.replace(/^\s*(cd\s+[^;&|]+(&&|;)\s*)+/, "").trim();

/** Calls that only look at things and don't depend on each other's results more than a search does. */
function isExploratory(c: Call, cmd?: string): boolean {
  if (c.kind !== "builtin") return false;
  if (EXPLORE_TOOLS.has(c.name)) return true;
  return c.name === "Bash" && EXPLORE_BASH.test(bashHead(cmd ?? c.label)) && !/<<|>\s*\S/.test(cmd ?? "");
}

const BASH_SUBSTITUTE = /^(cat|head|tail|grep|rg|find|sed\s+-n)\b/;
/** `cat > f <<EOF` and `cat >> f` write files; only count shell commands that read. */
const isShellRead = (cmd: string) => BASH_SUBSTITUTE.test(bashHead(cmd)) && !/^cat\s*>|<<|^\s*cat\s+>>/.test(bashHead(cmd));

function resultSize(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((n: number, b) => n + (typeof b === "string" ? b.length : String(asObj(b).text ?? "").length), 0);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Interval maths

type Span = [number, number];

function mergeSpans(spans: Span[]): Span[] {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const spanTotal = (spans: Span[]) => mergeSpans(spans).reduce((n, [a, b]) => n + (b - a), 0);

function maxConcurrency(spans: Span[]): number {
  const ev: [number, number][] = [];
  for (const [a, b] of spans) if (b > a) ev.push([a, 1], [b, -1]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

// ---------------------------------------------------------------------------------------------------------------------
// Story construction

interface RawCall extends Call {
  startAbs: number;
  endAbs: number | null;
  cmd?: string;
}
interface RawStep {
  id: string;
  turn: number;
  side: boolean;
  model: string;
  calls: string[];
}
interface RawTurn {
  index: number;
  prompt: string;
  startAbs: number;
  endAbs: number;
  outcome: string;
  costUsd: number | null;
  closed: boolean;
}

export function buildStory(file: string, source: SessionSource, opts: StoryOptions = {}): SessionStory {
  const recs = (source === "t3-provider" ? readT3(file) : readTranscript(file)).sort((a, b) => a.ts - b.ts);
  const detail = parseSessionFile(file, source);
  const hasResults = recs.some((r) => r.type === "result");

  const calls = new Map<string, RawCall>();
  const steps = new Map<string, RawStep>();
  const turns: RawTurn[] = [];
  const pendingPrompts: string[] = [];
  const seenPrompts = new Set<string>();
  const seenResults = new Set<string>();
  const sideStepIds = new Set<string>();
  const cumBaseline = new Map<string, number>();
  const avail: Capabilities = { skills: [], agents: [], mcpServers: [] };
  let title = "";
  let compactions = 0;
  let costComplete = true;
  let cwd: string | undefined = detail.project;
  const st: { cur: RawTurn | null } = { cur: null };

  const startTurn = (ts: number, prompt: string) => {
    st.cur = { index: turns.length + 1, prompt, startAbs: ts, endAbs: ts, outcome: "", costUsd: null, closed: false };
    turns.push(st.cur);
  };
  const closeTurn = (ts: number) => {
    if (st.cur) {
      st.cur.endAbs = Math.max(st.cur.endAbs, ts);
      st.cur.closed = true;
    }
    st.cur = null;
  };

  for (const r of recs) {
    if (st.cur) st.cur.endAbs = Math.max(st.cur.endAbs, r.ts);
    switch (r.type) {
      case "init": {
        const add = (dst: string[], src: unknown, pick: (v: any) => unknown = (v) => v) => {
          if (Array.isArray(src)) for (const v of src) { const s = pick(v); if (typeof s === "string" && !dst.includes(s)) dst.push(s); }
        };
        add(avail.skills, r.p.skills);
        add(avail.agents, r.p.agents);
        add(avail.mcpServers, r.p.mcp_servers, (v) => asObj(v).name);
        if (typeof r.p.cwd === "string") cwd = cwd ?? r.p.cwd;
        break;
      }
      case "title":
        if (typeof r.p.title === "string" && r.p.title) title = r.p.title;
        break;
      case "compact":
        compactions++;
        break;
      case "prompt": {
        const key = String(r.p.uuid ?? `${r.ts}:${r.p.text}`);
        if (seenPrompts.has(key)) break;
        seenPrompts.add(key);
        if (!hasResults && st.cur) closeTurn(r.ts); // transcripts have no result events: a new prompt ends the turn
        if (st.cur) pendingPrompts.push(r.p.text);
        else startTurn(r.ts, r.p.text);
        break;
      }
      case "assistant": {
        if (!st.cur) startTurn(r.ts, pendingPrompts.shift() ?? "");
        const turnIdx = (st.cur as RawTurn | null)?.index ?? turns.length;
        const msg = asObj(r.p.message);
        const id = String(msg.id ?? "");
        if (!id) break;
        let step = steps.get(id);
        if (!step) {
          step = { id, turn: turnIdx, side: r.side, model: String(msg.model ?? ""), calls: [] };
          steps.set(id, step);
          if (r.side) sideStepIds.add(id);
        }
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          const blk = asObj(b);
          if (blk.type !== "tool_use" || typeof blk.name !== "string") continue;
          const callId = String(blk.id ?? `${id}:${blk.name}`);
          if (calls.has(callId)) continue;
          const input = asObj(blk.input);
          const name = blk.name as string;
          const server = toolServer(name);
          const kind: CallKind = name === "Skill" ? "skill" : name === "Agent" || name === "Task" ? "agent" : server ? "mcp" : "builtin";
          calls.set(callId, {
            id: callId,
            name: server ? name.replace(`mcp__${server}__`, "") : name,
            kind,
            server,
            label: opts.redact ? "" : labelFor(name, input, cwd),
            cmd: name === "Bash" ? String(input.command ?? "") : undefined,
            startMs: 0,
            startAbs: r.ts,
            endAbs: null,
            durMs: null,
            background: input.run_in_background === true,
            resultChars: 0,
            isError: false,
            turn: turnIdx,
            stepId: id,
            sidechain: r.side,
          });
          step.calls.push(callId);
        }
        break;
      }
      case "tool_results": {
        for (const b of asObj(r.p.message).content ?? []) {
          const blk = asObj(b);
          if (blk.type !== "tool_result") continue;
          const c = calls.get(String(blk.tool_use_id));
          if (!c || c.endAbs !== null) continue;
          c.endAbs = r.ts;
          c.resultChars = resultSize(blk.content);
          c.isError = blk.is_error === true;
        }
        break;
      }
      case "task_started": {
        const c = calls.get(String(r.p.tool_use_id));
        if (c) c.background = true;
        break;
      }
      case "task_done": {
        const c = calls.get(String(r.p.tool_use_id));
        if (c) {
          c.background = true;
          c.endAbs = Math.max(c.endAbs ?? 0, r.ts); // true finish time, not the instant "started in background" reply
        }
        break;
      }
      case "result": {
        if (r.p.num_turns === 0 && !st.cur) break; // slash command / model switch, not a conversation turn
        const sid = String(r.p.session_id ?? "");
        const rid = String(r.p.uuid ?? `${r.ts}`);
        if (seenResults.has(rid)) break;
        seenResults.add(rid);
        // total_cost_usd is cumulative per SDK session: this turn's cost is the increase (or the whole value after a reset).
        const cum = typeof r.p.total_cost_usd === "number" ? r.p.total_cost_usd : null;
        let delta: number | null = null;
        if (cum !== null) {
          const known = cumBaseline.has(sid);
          const prev = cumBaseline.get(sid) ?? 0;
          // First result we see for an SDK session whose cumulative API time dwarfs this turn: earlier turns are not in the log.
          const apiCum = typeof r.p.duration_api_ms === "number" ? r.p.duration_api_ms : 0;
          const ownMs = typeof r.p.duration_ms === "number" ? r.p.duration_ms : 0;
          const missingHistory = !known && apiCum > ownMs * 1.5 + 60_000;
          if (missingHistory) costComplete = false;
          else delta = cum >= prev ? cum - prev : cum;
          cumBaseline.set(sid, cum);
        }
        if (!st.cur) startTurn(r.ts, pendingPrompts.shift() ?? "");
        const t = st.cur as RawTurn | null;
        if (!t) break;
        t.costUsd = delta;
        t.outcome = typeof r.p.result === "string" ? r.p.result : "";
        closeTurn(r.ts);
        break;
      }
    }
  }
  if (st.cur) closeTurn(st.cur.endAbs);

  const t0 = recs.find((r) => r.ts > 0)?.ts ?? 0;
  const tEnd = recs.length ? recs[recs.length - 1].ts : t0;
  const callList = [...calls.values()];
  for (const c of callList) {
    c.startMs = c.startAbs - t0;
    c.durMs = c.endAbs !== null ? Math.max(0, c.endAbs - c.startAbs) : null;
  }

  // Per-turn timing ---------------------------------------------------------------------------------------------------
  const stepModel = new Map([...steps.values()].map((s) => [s.id, s.model]));
  let prevEnd: number | null = null;
  const outTurns: Turn[] = turns.map((t) => {
    const mine = callList.filter((c) => c.turn === t.index);
    const blockingSpans = (pred: (c: RawCall) => boolean): Span[] => mine.filter((c) => !c.background && c.endAbs !== null && pred(c)).map((c) => [Math.max(c.startAbs, t.startAbs), Math.min(c.endAbs as number, t.endAbs)] as Span);
    const userWait = spanTotal(blockingSpans((c) => c.name === "AskUserQuestion"));
    const toolMs = spanTotal(blockingSpans((c) => c.name !== "AskUserQuestion"));
    const wall = Math.max(0, t.endAbs - t.startAbs);
    const turnSteps = [...steps.values()].filter((s) => s.turn === t.index && !s.side);
    const idle = prevEnd === null ? 0 : Math.max(0, t.startAbs - prevEnd);
    prevEnd = Math.max(prevEnd ?? 0, t.endAbs);
    return {
      index: t.index,
      prompt: opts.redact ? "" : shorten(t.prompt, 240) || "(prompt not in log)",
      outcome: opts.redact ? "" : shorten(t.outcome.replace(/\s+/g, " ").trim(), 320),
      startMs: t.startAbs - t0,
      endMs: t.endAbs - t0,
      wallMs: wall,
      toolMs,
      userWaitMs: userWait,
      modelMs: Math.max(0, wall - toolMs - userWait),
      idleBeforeMs: idle,
      steps: turnSteps.length,
      calls: mine.length,
      costUsd: t.costUsd,
      models: [...new Set(turnSteps.map((s) => stepModel.get(s.id) ?? "").filter(Boolean))],
    };
  });

  // Parallelism, sub-agents --------------------------------------------------------------------------------------------
  const blocking = callList.filter((c) => !c.background && c.durMs !== null && c.name !== "AskUserQuestion");
  const spans = blocking.map((c) => [c.startAbs, c.endAbs as number] as Span);
  const serialSum = blocking.reduce((n, c) => n + (c.durMs as number), 0);
  // Calls only overlap within one turn, so union per turn to avoid merging across idle gaps.
  const unionSum = turns.reduce((n, t) => n + spanTotal(blocking.filter((c) => c.turn === t.index).map((c) => [c.startAbs, c.endAbs as number] as Span)), 0);
  const parallelSteps = [...steps.values()].filter((s) => !s.side && s.calls.length >= 2).length;

  const agentCalls = callList.filter((c) => c.kind === "agent");
  const agentSpans = agentCalls.filter((c) => c.durMs !== null).map((c) => [c.startAbs, c.endAbs as number] as Span);
  let subFresh = 0;
  let subTotal = 0;
  for (const s of detail.steps) if (sideStepIds.has(s.id)) { subFresh += s.fresh; subTotal += s.total; }

  const used: Capabilities = {
    skills: [...new Set(callList.filter((c) => c.kind === "skill").map((c) => c.label || "(redacted)"))],
    agents: [...new Set(agentCalls.map((c) => (c.label.split(":")[0] || "agent")))],
    mcpServers: [...new Set(callList.filter((c) => c.server).map((c) => c.server as string))],
  };

  const costs = outTurns.map((t) => t.costUsd).filter((c): c is number => c !== null);
  const story: SessionStory = {
    id: detail.id,
    source,
    title: opts.redact ? "" : shorten(title || outTurns[0]?.prompt || detail.id, 120),
    project: detail.project,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(tEnd).toISOString(),
    models: detail.models,
    turns: outTurns,
    calls: callList.map(({ startAbs: _a, endAbs: _b, cmd: _c, ...c }) => c),
    totals: {
      wallMs: tEnd - t0,
      activeMs: outTurns.reduce((n, t) => n + t.wallMs, 0),
      idleMs: outTurns.reduce((n, t) => n + t.idleBeforeMs, 0),
      toolMs: outTurns.reduce((n, t) => n + t.toolMs, 0),
      modelMs: outTurns.reduce((n, t) => n + t.modelMs, 0),
      userWaitMs: outTurns.reduce((n, t) => n + t.userWaitMs, 0),
      costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      costComplete,
      freshTokens: detail.totals.fresh,
      totalTokens: detail.totals.total,
      steps: detail.stepCount,
      compactions,
    },
    parallel: { parallelSteps, maxConcurrent: maxConcurrency(spans), savedMs: Math.max(0, serialSum - unionSum) },
    subagents: {
      count: agentCalls.length,
      backgroundCount: agentCalls.filter((c) => c.background).length,
      totalMs: spanTotal(agentSpans),
      freshTokens: subFresh,
      totalTokens: subTotal,
    },
    capabilities: { available: avail, used },
    findings: [],
  };
  story.findings = deriveFindings(story, callList, [...steps.values()], detail);
  return story;
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings: deterministic, each backed by numbers from the log

const fmtDur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function deriveFindings(s: SessionStory, calls: RawCall[], steps: RawStep[], detail: ReturnType<typeof parseSessionFile>): Finding[] {
  const out: Finding[] = [];
  const mainSteps = steps.filter((x) => !x.side);
  const byId = new Map(calls.map((c) => [c.id, c]));

  // --- Things that worked (measured, not counterfactual) ---
  if (s.parallel.parallelSteps > 0 && s.parallel.savedMs >= 2000)
    out.push({
      id: "parallel-used",
      severity: "good",
      title: "Parallel tool calls overlapped work",
      detail: `${s.parallel.parallelSteps} steps issued several tool calls at once (up to ${s.parallel.maxConcurrent} running together), so about ${fmtDur(s.parallel.savedMs)} of tool time ran alongside other calls instead of after them.`,
      evidence: [],
    });
  if (s.subagents.count > 0)
    out.push({
      id: "subagents-used",
      severity: "good",
      title: "Work was delegated to sub-agents",
      detail: `${s.subagents.count} sub-agent run(s) (${s.subagents.backgroundCount} in the background) spent ${fmtTok(s.subagents.freshTokens)} fresh tokens inside their own context windows instead of the main conversation's, and ran ${fmtDur(s.subagents.totalMs)} of wall time.`,
      evidence: calls.filter((c) => c.kind === "agent").slice(0, 5).map((c) => `${c.label || c.name} (${c.durMs === null ? "?" : fmtDur(c.durMs)})`),
    });
  if (s.capabilities.used.skills.length)
    out.push({
      id: "skills-used",
      severity: "info",
      title: "Skills were used",
      detail: `Skill calls: ${s.capabilities.used.skills.join(", ")}. The log cannot show tokens saved versus not using a skill; it shows only that the skill loaded.`,
      evidence: [],
    });
  const local = calls.filter((c) => c.server && /ollama|local/i.test(c.server));
  if (local.length)
    out.push({
      id: "local-offload",
      severity: "good",
      title: "Work was offloaded to the local model",
      detail: `${local.length} call(s) to ${[...new Set(local.map((c) => c.server))].join(", ")} ran on your GPU instead of the paid model and returned ${fmtTok(Math.round(local.reduce((n, c) => n + c.resultChars, 0) / 4))} tokens of results.`,
      evidence: [],
    });

  // --- Things worth changing ---
  // Serial exploration: runs of steps that each issue one read-only call.
  const runs: { turn: number; len: number; ms: number; calls: number }[] = [];
  let run: RawStep[] = [];
  const flush = () => {
    if (run.length >= 5) {
      const cs = run.flatMap((x) => x.calls.map((id) => byId.get(id)!)).filter(Boolean);
      const start = Math.min(...cs.map((c) => c.startAbs));
      const end = Math.max(...cs.map((c) => c.endAbs ?? c.startAbs));
      if (cs.length / run.length <= 1.5) runs.push({ turn: run[0].turn, len: run.length, ms: end - start, calls: cs.length });
    }
    run = [];
  };
  for (const st of mainSteps) {
    const cs = st.calls.map((id) => byId.get(id)).filter((c): c is RawCall => !!c);
    const explore = cs.length > 0 && cs.every((c) => isExploratory(c, c.cmd)) && (run.length === 0 || run[0].turn === st.turn);
    if (explore) run.push(st);
    else flush();
  }
  flush();
  const worst = runs.sort((a, b) => b.len - a.len).slice(0, 3);
  if (worst.length)
    out.push({
      id: "serial-exploration",
      severity: "suggest",
      title: "Long chains of one-at-a-time lookups",
      detail: "Several consecutive model steps each ran a single read-only call (read, grep, ls...). Independent lookups can be issued together in one step, or handed to an Explore sub-agent so the search results stay out of the main context.",
      evidence: worst.map((r) => `turn ${r.turn}: ${r.len} steps / ${r.calls} calls over ${fmtDur(r.ms)}`),
      turn: worst[0].turn,
    });

  const bashSub = calls.filter((c) => c.name === "Bash" && !c.sidechain && isShellRead(c.cmd ?? ""));
  if (bashSub.length >= 8)
    out.push({
      id: "bash-for-search",
      severity: "suggest",
      title: "Shell used for reading and searching files",
      detail: `${bashSub.length} Bash calls were cat/head/tail/grep/find/sed. Those return unbounded output into the conversation; Read with a line range, Grep with a result limit, or a code-search MCP (such as your local ollama-helper) return only what is needed.`,
      evidence: bashSub.slice(0, 3).map((c) => c.label || "(redacted)"),
    });

  const big = calls.filter((c) => c.resultChars >= 30_000).sort((a, b) => b.resultChars - a.resultChars);
  if (big.length) {
    const tok = big.reduce((n, c) => n + Math.round(c.resultChars / 4), 0);
    out.push({
      id: "big-tool-results",
      severity: "suggest",
      title: "Very large tool results",
      detail: `${big.length} tool result(s) of 30k+ characters (about ${fmtTok(tok)} tokens). Each one stays in the context and is re-read (cheaply, from cache) on every later step. Limiting output at the source or summarising with a local model keeps it out.`,
      evidence: big.slice(0, 3).map((c) => `${c.name}${c.label ? ` ${c.label}` : ""}: ${fmtTok(Math.round(c.resultChars / 4))} tokens`),
    });
  }

  const reads = new Map<string, number>();
  for (const c of calls) if (c.name === "Read" && c.label) reads.set(c.label, (reads.get(c.label) ?? 0) + 1);
  const rereads = [...reads.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  if (rereads.length)
    out.push({
      id: "repeat-reads",
      severity: "info",
      title: "Same file read three or more times",
      detail: "Re-reading is sometimes needed after edits, but repeated reads of an unchanged file are wasted context.",
      evidence: rereads.slice(0, 3).map(([f, n]) => `${f} x${n}`),
    });

  const explCalls = calls.filter((c) => !c.sidechain && isExploratory(c, c.cmd)).length;
  const canDelegate = s.capabilities.available.agents.some((a) => /explore|general/i.test(a));
  if (s.subagents.count === 0 && (explCalls >= 15 || mainSteps.length >= 60) && (canDelegate || s.capabilities.available.agents.length === 0))
    out.push({
      id: "no-delegation",
      severity: "suggest",
      title: "No sub-agents used on a search-heavy session",
      detail: `${explCalls} read-only lookups and ${mainSteps.length} steps ran in the main conversation. An Explore sub-agent can do broad searches in its own context and return only a summary, and independent tasks can run as parallel sub-agents.`,
      evidence: [],
    });

  const slow = calls.filter((c) => !c.background && c.durMs !== null && c.durMs >= 60_000 && c.kind === "builtin" && c.name !== "AskUserQuestion").sort((a, b) => (b.durMs as number) - (a.durMs as number));
  if (slow.length)
    out.push({
      id: "slow-blocking",
      severity: "suggest",
      title: "Long commands blocked the conversation",
      detail: `${slow.length} foreground command(s) ran a minute or more while the model waited. Running builds/tests in the background lets it keep working (or run independent checks in parallel).`,
      evidence: slow.slice(0, 3).map((c) => `${c.name} ${c.label || ""} - ${fmtDur(c.durMs as number)}`),
    });

  for (const t of s.turns) {
    if (!t.models.some((m) => /opus/i.test(m)) || t.steps > 4) continue;
    const mine = calls.filter((c) => c.turn === t.index);
    if (mine.some((c) => c.name === "Write" || c.name === "Edit" || c.kind === "agent")) continue;
    out.push({
      id: "light-turn-on-opus",
      severity: "info",
      title: "Short, read-only turn on the largest model",
      detail: `Turn ${t.index} took ${t.steps} step(s) with no edits on ${t.models.join(", ")}${t.costUsd !== null ? ` (about $${t.costUsd.toFixed(2)})` : ""}. Quick questions rarely need the biggest model.`,
      evidence: [],
      turn: t.index,
    });
    break;
  }

  // Where the time goes: when tools are a rounding error, parallelism and faster tools cannot help.
  if (s.totals.activeMs >= 10 * 60_000 && s.totals.modelMs >= 0.85 * s.totals.activeMs)
    out.push({
      id: "model-bound",
      severity: "info",
      title: "Time is spent in the model, not in tools",
      detail: `${Math.round((s.totals.modelMs / s.totals.activeMs) * 100)}% of ${fmtDur(s.totals.activeMs)} active time was the model generating (tools ran ${fmtDur(s.totals.toolMs)}). Faster tools or more parallel calls will not help here; model choice, reasoning effort, and splitting work across independent sub-agents are the levers that can.`,
      evidence: [],
    });

  // Context size and cache rebuilds
  const ctxOf = (x: { input: number; cacheRead: number; cacheCreate: number }) => x.input + x.cacheRead + x.cacheCreate;
  const maxCtx = detail.steps.reduce((m, x) => Math.max(m, ctxOf(x)), 0);
  if (maxCtx >= 400_000)
    out.push({
      id: "context-bloat",
      severity: "suggest",
      title: "Context grew very large",
      detail: `Peak context was about ${fmtTok(maxCtx)} tokens (compactions logged: ${s.totals.compactions}). Every step re-reads the whole context, so cost per step climbs with it; compacting earlier or starting a fresh thread per task keeps steps cheap.`,
      evidence: [],
    });
  const rebuilds: string[] = [];
  for (const t of s.turns) {
    if (t.idleBeforeMs < 5 * 60_000) continue;
    const first = detail.steps.find((x) => Date.parse(x.ts) >= Date.parse(s.startedAt) + t.startMs - 1000);
    if (first && first.cacheCreate >= 50_000 && first.cacheCreate > first.cacheRead)
      rebuilds.push(`turn ${t.index}: ${fmtTok(first.cacheCreate)} tokens re-cached after ${fmtDur(t.idleBeforeMs)} idle`);
  }
  if (rebuilds.length)
    out.push({
      id: "cache-rebuild",
      severity: "info",
      title: "Prompt cache expired during a break",
      detail: "After a long pause the cached context expired and had to be rebuilt at full price. Starting a new thread (or compacting first) before a long break avoids paying for a large stale context.",
      evidence: rebuilds.slice(0, 3),
    });

  const errs = calls.filter((c) => c.isError);
  if (errs.length >= 5)
    out.push({
      id: "tool-errors",
      severity: "info",
      title: "Many failed tool calls",
      detail: `${errs.length} of ${calls.length} tool calls returned errors; each failure costs a model step to read and retry.`,
      evidence: errs.slice(0, 3).map((c) => `${c.name} ${c.label}`.trim()),
    });

  const order = { suggest: 0, good: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cached entry points

const cache = new Map<string, { mtimeMs: number; size: number; redact: boolean; story: SessionStory }>();

export function storyForFile(file: string, source: SessionSource, opts: StoryOptions = {}): SessionStory {
  const st = statSync(file);
  const redact = !!opts.redact;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.redact === redact) return hit.story;
  const story = buildStory(file, source, opts);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, redact, story });
  return story;
}

/** Human-readable walkthrough for the terminal. */
export function renderStoryText(s: SessionStory): string {
  const L: string[] = [];
  const cost = s.totals.costUsd !== null ? `$${s.totals.costUsd.toFixed(2)}` : "n/a";
  L.push(`${s.title}  [${s.id.slice(0, 8)}, ${s.source}]`);
  L.push(`${s.turns.length} turns · wall ${fmtDur(s.totals.wallMs)} (active ${fmtDur(s.totals.activeMs)}, idle ${fmtDur(s.totals.idleMs)}) · cost ${cost} · ${fmtTok(s.totals.freshTokens)} fresh tokens`);
  L.push(`active time: model ${fmtDur(s.totals.modelMs)} · tools ${fmtDur(s.totals.toolMs)} · waiting on you ${fmtDur(s.totals.userWaitMs)}`);
  L.push(`parallel steps ${s.parallel.parallelSteps} (saved ~${fmtDur(s.parallel.savedMs)}) · sub-agents ${s.subagents.count} · MCP ${s.capabilities.used.mcpServers.join(",") || "-"} · skills ${s.capabilities.used.skills.join(",") || "-"}`);
  L.push("");
  for (const t of s.turns) {
    L.push(`Turn ${t.index} (${fmtDur(t.wallMs)}, ${t.steps} steps, ${t.calls} calls${t.costUsd !== null ? `, $${t.costUsd.toFixed(2)}` : ""}): ${t.prompt || "(prompt hidden)"}`);
    if (t.outcome) L.push(`   -> ${t.outcome}`);
  }
  if (s.findings.length) {
    L.push("");
    for (const f of s.findings) {
      L.push(`[${f.severity}] ${f.title}: ${f.detail}`);
      for (const e of f.evidence) L.push(`     - ${e}`);
    }
  }
  return L.join("\n");
}
