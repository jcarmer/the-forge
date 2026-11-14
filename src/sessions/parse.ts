import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type SessionSource = "claude-transcript" | "t3-provider";

export interface ToolCall {
  id: string;
  name: string;
  /** MCP server name for `mcp__<server>__<tool>`; undefined for built-in tools. */
  server?: string;
}

export interface Step {
  /** Model message id (one step = one model response). */
  id: string;
  ts: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** input + output + cacheRead + cacheCreate. */
  total: number;
  /** Tokens that were not served from cache: input + output + cacheCreate. */
  fresh: number;
  tools: ToolCall[];
}

export interface McpUsage {
  server: string;
  calls: number;
  tools: Record<string, number>;
  /** Fresh tokens of the steps that called this server, split evenly across that step's tool calls. */
  attributedFresh: number;
}

export interface SessionSummary {
  id: string;
  source: SessionSource;
  file: string;
  project?: string;
  startedAt: string;
  endedAt: string;
  models: string[];
  stepCount: number;
  totals: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number; fresh: number };
  mcp: McpUsage[];
  /** Built-in tool call counts. */
  builtinTools: Record<string, number>;
  /** T3 logs only: Claude session ids this thread ran on (their transcripts are the same conversation). */
  claudeSessionIds?: string[];
  /** T3 logs only: MCP servers T3 pre-approved at runtime (not present in any config file). */
  allowedMcp?: string[];
}

export interface SessionDetail extends SessionSummary {
  steps: Step[];
}

export function toolServer(name: string): string | undefined {
  const m = name.match(/^mcp__(.+?)__/);
  return m ? m[1] : undefined;
}

interface RawMessage {
  id: string;
  model: string;
  usage: Record<string, unknown>;
  content: unknown[];
}

/** Finds assistant-message-shaped objects (`id` + `usage.input_tokens`) anywhere in a parsed record. */
function findMessages(node: unknown, out: RawMessage[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const n of node) findMessages(n, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  const u = o.usage as Record<string, unknown> | undefined;
  if (typeof o.id === "string" && o.id.startsWith("msg_") && u && typeof u.output_tokens === "number") {
    out.push({ id: o.id, model: typeof o.model === "string" ? o.model : "unknown", usage: u, content: Array.isArray(o.content) ? o.content : [] });
    return;
  }
  for (const v of Object.values(o)) findMessages(v, out, depth + 1);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Builds steps from records, deduping the repeated lines a message is split across (and across log stages). */
class StepBuilder {
  private steps = new Map<string, Step>();
  private seenTools = new Set<string>();
  project?: string;

  add(ts: string, msg: RawMessage): void {
    let s = this.steps.get(msg.id);
    if (!s) {
      s = { id: msg.id, ts, model: msg.model, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, fresh: 0, tools: [] };
      this.steps.set(msg.id, s);
    }
    // Streaming repeats the message with growing usage: keep the maximum seen per field.
    s.input = Math.max(s.input, num(msg.usage.input_tokens));
    s.output = Math.max(s.output, num(msg.usage.output_tokens));
    s.cacheRead = Math.max(s.cacheRead, num(msg.usage.cache_read_input_tokens));
    s.cacheCreate = Math.max(s.cacheCreate, num(msg.usage.cache_creation_input_tokens));
    if (ts < s.ts) s.ts = ts;
    for (const c of msg.content) {
      const b = c as { type?: string; id?: string; name?: string };
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      const key = `${msg.id}:${b.id ?? b.name}`;
      if (this.seenTools.has(key)) continue;
      this.seenTools.add(key);
      s.tools.push({ id: b.id ?? key, name: b.name, server: toolServer(b.name) });
    }
  }

  build(): Step[] {
    const out = [...this.steps.values()].sort((a, b) => a.ts.localeCompare(b.ts));
    for (const s of out) {
      s.total = s.input + s.output + s.cacheRead + s.cacheCreate;
      s.fresh = s.input + s.output + s.cacheCreate;
    }
    return out;
  }
}

function summarize(id: string, source: SessionSource, file: string, project: string | undefined, steps: Step[]): SessionDetail {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, fresh: 0 };
  const mcp = new Map<string, McpUsage>();
  const builtin: Record<string, number> = {};
  for (const s of steps) {
    totals.input += s.input;
    totals.output += s.output;
    totals.cacheRead += s.cacheRead;
    totals.cacheCreate += s.cacheCreate;
    totals.total += s.total;
    totals.fresh += s.fresh;
    for (const t of s.tools) {
      if (!t.server) {
        builtin[t.name] = (builtin[t.name] ?? 0) + 1;
        continue;
      }
      const u = mcp.get(t.server) ?? { server: t.server, calls: 0, tools: {}, attributedFresh: 0 };
      const short = t.name.replace(`mcp__${t.server}__`, "");
      u.calls++;
      u.tools[short] = (u.tools[short] ?? 0) + 1;
      u.attributedFresh += s.fresh / s.tools.length;
      mcp.set(t.server, u);
    }
  }
  return {
    id,
    source,
    file,
    project,
    startedAt: steps[0]?.ts ?? "",
    endedAt: steps[steps.length - 1]?.ts ?? "",
    models: [...new Set(steps.map((s) => s.model))],
    stepCount: steps.length,
    totals,
    mcp: [...mcp.values()].map((m) => ({ ...m, attributedFresh: Math.round(m.attributedFresh) })).sort((a, b) => b.calls - a.calls),
    builtinTools: builtin,
    steps,
  };
}

/** Claude Code transcript: one JSON object per line. */
export function parseClaudeTranscript(file: string): SessionDetail {
  const b = new StepBuilder();
  let project: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!project && typeof rec.cwd === "string") project = rec.cwd;
    if (rec.type !== "assistant") continue;
    const found: RawMessage[] = [];
    findMessages(rec.message, found);
    for (const m of found) b.add(typeof rec.timestamp === "string" ? rec.timestamp : "", m);
  }
  return summarize(basename(file, ".jsonl"), "claude-transcript", file, project, b.build());
}

/** T3 provider event log: `[ISO timestamp] LABEL: {json}` per line, one file per thread. */
export function parseT3ProviderLog(file: string): SessionDetail {
  const b = new StepBuilder();
  let project: string | undefined;
  const claudeSessionIds = new Set<string>();
  const allowedMcp = new Set<string>();
  const lineRe = /^\[([^\]]+)\] [A-Z_]+: (\{.*\})\s*$/;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(lineRe);
    if (!m) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(m[2]);
    } catch {
      continue;
    }
    const opts = (rec as { event?: { payload?: { type?: unknown; options?: { cwd?: unknown; sessionId?: unknown; allowedTools?: unknown } } } }).event?.payload?.options;
    if (opts) {
      if (!project && typeof opts.cwd === "string") project = opts.cwd;
      if (typeof opts.sessionId === "string") claudeSessionIds.add(opts.sessionId);
      if (Array.isArray(opts.allowedTools)) for (const t of opts.allowedTools) if (typeof t === "string" && toolServer(t.replace(/\*$/, "x"))) allowedMcp.add(toolServer(t.replace(/\*$/, "x"))!);
    }
    const found: RawMessage[] = [];
    findMessages(rec, found);
    for (const msg of found) b.add(m[1], msg);
  }
  const id = basename(file).replace(/^events\./, "").replace(/\.log(\.\d+)?$/, "");
  const detail = summarize(id, "t3-provider", file, project, b.build());
  detail.claudeSessionIds = [...claudeSessionIds];
  detail.allowedMcp = [...allowedMcp];
  return detail;
}

export interface SessionSources {
  claudeProjectsDir: string;
  t3ProviderLogDir: string;
}

export function defaultSources(home = homedir()): SessionSources {
  return { claudeProjectsDir: join(home, ".claude", "projects"), t3ProviderLogDir: join(home, ".t3", "userdata", "logs", "provider") };
}

export function listSessionFiles(src: SessionSources): { file: string; source: SessionSource; mtimeMs: number }[] {
  const out: { file: string; source: SessionSource; mtimeMs: number }[] = [];
  const add = (file: string, source: SessionSource) => {
    try {
      out.push({ file, source, mtimeMs: statSync(file).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  };
  if (existsSync(src.claudeProjectsDir)) {
    for (const d of readdirSync(src.claudeProjectsDir)) {
      const dir = join(src.claudeProjectsDir, d);
      try {
        for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) add(join(dir, f), "claude-transcript");
      } catch {
        // not a directory
      }
    }
  }
  if (existsSync(src.t3ProviderLogDir)) {
    // Rotated files (`.log.1`) are older chunks of the same thread: the primary `.log` is parsed on its own.
    for (const f of readdirSync(src.t3ProviderLogDir)) if (/^events\..+\.log$/.test(f)) add(join(src.t3ProviderLogDir, f), "t3-provider");
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const cache = new Map<string, { mtimeMs: number; size: number; detail: SessionDetail }>();

export function parseSessionFile(file: string, source: SessionSource): SessionDetail {
  const st = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.detail;
  const detail = source === "claude-transcript" ? parseClaudeTranscript(file) : parseT3ProviderLog(file);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, detail });
  return detail;
}

/** T3 threads first-class; Claude transcripts that a T3 thread ran on are hidden as duplicates. */
export function listSessions(src = defaultSources(), limit = 60): SessionSummary[] {
  const all = listSessionFiles(src)
    .slice(0, limit * 2)
    .map((f) => {
      const { steps: _steps, ...summary } = parseSessionFile(f.file, f.source);
      return summary;
    })
    .filter((s) => s.stepCount > 0);
  const covered = new Set(all.flatMap((s) => s.claudeSessionIds ?? []));
  return all.filter((s) => s.source === "t3-provider" || !covered.has(s.id)).slice(0, limit);
}

export function getSession(id: string, src = defaultSources()): SessionDetail | null {
  const f = listSessionFiles(src).find((x) => basename(x.file).includes(id) && id.length >= 8);
  return f ? parseSessionFile(f.file, f.source) : null;
}

/** Tokens consumed in the trailing window across every session, used to express a step as a share of the week. */
export function windowTotals(src = defaultSources(), days = 7, now = Date.now()): { total: number; fresh: number; sessions: number } {
  const since = new Date(now - days * 86_400_000).toISOString();
  let total = 0;
  let fresh = 0;
  let sessions = 0;
  const seenIds = new Set<string>();
  for (const f of listSessionFiles(src)) {
    if (f.mtimeMs < now - days * 86_400_000) continue;
    const d = parseSessionFile(f.file, f.source);
    let counted = false;
    for (const s of d.steps) {
      // A thread appears as both a T3 log and a Claude transcript: count each model message once.
      if (s.ts < since || seenIds.has(s.id)) continue;
      seenIds.add(s.id);
      total += s.total;
      fresh += s.fresh;
      counted = true;
    }
    if (counted) sessions++;
  }
  return { total, fresh, sessions };
}
