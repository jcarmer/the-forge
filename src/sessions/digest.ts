import { defaultSources, listSessionFiles, type SessionSources } from "./parse.js";
import { storyForFile, type Capabilities, type Finding, type SessionStory } from "./story.js";

export interface Overview {
  days: number;
  sessions: number;
  turns: number;
  wallMs: number;
  activeMs: number;
  modelMs: number;
  toolMs: number;
  userWaitMs: number;
  idleMs: number;
  costUsd: number;
  /** Some sessions' logs begin mid-conversation, so their earlier cost is not counted. */
  costPartialSessions: number;
  freshTokens: number;
  calls: number;
  builtin: { name: string; calls: number }[];
  mcp: { server: string; calls: number; errors: number; approxResultTokens: number; sessions: number }[];
  skills: { name: string; calls: number }[];
  agents: { name: string; calls: number; totalMs: number }[];
  parallel: { parallelSteps: number; savedMs: number };
  subagentFreshTokens: number;
  availableNeverUsed: Capabilities;
  findings: { id: string; severity: Finding["severity"]; title: string; detail: string; sessions: number; examples: string[] }[];
  topCost: { id: string; title: string; costUsd: number; wallMs: number; turns: number }[];
}

export function loadStories(days: number, opts: { redact?: boolean; src?: SessionSources; now?: number } = {}): SessionStory[] {
  const now = opts.now ?? Date.now();
  const since = now - days * 86_400_000;
  const out: SessionStory[] = [];
  const seen = new Set<string>();
  // T3 provider logs are the source of record; Claude transcripts of the same thread are duplicates.
  const files = listSessionFiles(opts.src ?? defaultSources()).filter((f) => f.source === "t3-provider" && f.mtimeMs >= since);
  for (const f of files) {
    const s = storyForFile(f.file, f.source, { redact: opts.redact });
    if (s.calls.length + s.turns.length === 0 || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const bump = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

export function buildOverview(stories: SessionStory[], days: number): Overview {
  const builtin = new Map<string, number>();
  const skills = new Map<string, number>();
  const agents = new Map<string, { calls: number; totalMs: number }>();
  const mcp = new Map<string, { calls: number; errors: number; chars: number; sessions: Set<string> }>();
  const findings = new Map<string, { f: Finding; sessions: Set<string>; examples: string[] }>();
  const avail: Capabilities = { skills: [], agents: [], mcpServers: [] };
  const used: Capabilities = { skills: [], agents: [], mcpServers: [] };
  const union = (dst: string[], src: string[]) => { for (const v of src) if (!dst.includes(v)) dst.push(v); };

  for (const s of stories) {
    union(avail.skills, s.capabilities.available.skills);
    union(avail.agents, s.capabilities.available.agents);
    union(avail.mcpServers, s.capabilities.available.mcpServers);
    union(used.skills, s.capabilities.used.skills);
    union(used.agents, s.capabilities.used.agents);
    union(used.mcpServers, s.capabilities.used.mcpServers);
    for (const c of s.calls) {
      if (c.kind === "builtin") bump(builtin, c.name);
      else if (c.kind === "skill") bump(skills, c.label || "(redacted)");
      else if (c.kind === "agent") {
        const name = c.label.split(":")[0] || "agent";
        const a = agents.get(name) ?? { calls: 0, totalMs: 0 };
        a.calls++;
        a.totalMs += c.durMs ?? 0;
        agents.set(name, a);
      } else if (c.server) {
        const m = mcp.get(c.server) ?? { calls: 0, errors: 0, chars: 0, sessions: new Set<string>() };
        m.calls++;
        if (c.isError) m.errors++;
        m.chars += c.resultChars;
        m.sessions.add(s.id);
        mcp.set(c.server, m);
      }
    }
    for (const f of s.findings) {
      const e = findings.get(f.id) ?? { f, sessions: new Set<string>(), examples: [] };
      e.sessions.add(s.id);
      for (const ev of f.evidence) if (e.examples.length < 3 && !e.examples.includes(ev)) e.examples.push(ev);
      findings.set(f.id, e);
    }
  }

  const sum = (pick: (s: SessionStory) => number) => stories.reduce((n, s) => n + pick(s), 0);
  const order = { suggest: 0, good: 1, info: 2 } as const;
  return {
    days,
    sessions: stories.length,
    turns: sum((s) => s.turns.length),
    wallMs: sum((s) => s.totals.wallMs),
    activeMs: sum((s) => s.totals.activeMs),
    modelMs: sum((s) => s.totals.modelMs),
    toolMs: sum((s) => s.totals.toolMs),
    userWaitMs: sum((s) => s.totals.userWaitMs),
    idleMs: sum((s) => s.totals.idleMs),
    costUsd: sum((s) => s.totals.costUsd ?? 0),
    costPartialSessions: stories.filter((s) => !s.totals.costComplete).length,
    freshTokens: sum((s) => s.totals.freshTokens),
    calls: sum((s) => s.calls.length),
    builtin: [...builtin].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    mcp: [...mcp].map(([server, m]) => ({ server, calls: m.calls, errors: m.errors, approxResultTokens: Math.round(m.chars / 4), sessions: m.sessions.size })).sort((a, b) => b.calls - a.calls),
    skills: [...skills].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    agents: [...agents].map(([name, a]) => ({ name, ...a })).sort((a, b) => b.calls - a.calls),
    parallel: { parallelSteps: sum((s) => s.parallel.parallelSteps), savedMs: sum((s) => s.parallel.savedMs) },
    subagentFreshTokens: sum((s) => s.subagents.freshTokens),
    availableNeverUsed: {
      skills: avail.skills.filter((x) => !used.skills.includes(x)),
      agents: avail.agents.filter((x) => !used.agents.includes(x)),
      mcpServers: avail.mcpServers.filter((x) => !used.mcpServers.includes(x)),
    },
    findings: [...findings.values()]
      .map(({ f, sessions, examples }) => ({ id: f.id, severity: f.severity, title: f.title, detail: f.detail, sessions: sessions.size, examples }))
      .sort((a, b) => order[a.severity] - order[b.severity] || b.sessions - a.sessions),
    topCost: [...stories]
      .filter((s) => s.totals.costUsd)
      .sort((a, b) => (b.totals.costUsd ?? 0) - (a.totals.costUsd ?? 0))
      .slice(0, 5)
      .map((s) => ({ id: s.id, title: s.title, costUsd: s.totals.costUsd ?? 0, wallMs: s.totals.wallMs, turns: s.turns.length })),
  };
}

const dur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "-");

export const ADVISOR_PROMPT = [
  "You are reviewing how one developer uses AI coding agents (Claude Code driven through the T3 Code app) in a Docker-based sandbox called The Forge.",
  "Below is a measured digest of their recent conversations: time split, cost, tool/MCP/skill/sub-agent usage, and rule-based findings.",
  "",
  "Please:",
  "1. Say in a few sentences how their work actually flows (what kinds of tasks, how long they run, where time and money go).",
  "2. Rank the 3-5 changes most likely to cut cost or wall time, each tied to numbers in the digest. Separate what is MEASURED from what is a guess.",
  "3. Recommend specific skills, MCP servers, sub-agent patterns, model/effort settings or CLAUDE.md rules to add, and say what each would replace.",
  "4. Name anything in the data that contradicts a common assumption (for example that parallelism would help when tools take seconds and the model takes minutes).",
  "5. Say what extra logging or data would let you give better advice.",
  "",
  "Constraints: the logs cannot show counterfactual savings (what a skill or MCP saved versus not being used), so do not claim exact savings; give ranges and reasoning.",
].join("\n");

/** Markdown brief meant to be pasted to (or read by) an LLM. `redact` removes prompts, commands and paths. */
export function renderDigest(stories: SessionStory[], o: Overview, opts: { redact?: boolean; maxSessions?: number } = {}): string {
  const L: string[] = [];
  L.push(`# Forge workflow digest - last ${o.days} days`, "", ADVISOR_PROMPT, "");
  L.push("## Totals", "");
  L.push(`- ${o.sessions} conversations, ${o.turns} turns, ${o.calls} tool calls`);
  L.push(`- Wall time ${dur(o.wallMs)}: active ${dur(o.activeMs)} (${pct(o.activeMs, o.wallMs)}), idle between turns ${dur(o.idleMs)}`);
  L.push(`- Active time split: model thinking/writing (and approvals) ${dur(o.modelMs)} (${pct(o.modelMs, o.activeMs)}), tools ${dur(o.toolMs)} (${pct(o.toolMs, o.activeMs)}), waiting on a question to you ${dur(o.userWaitMs)}`);
  L.push(`- Cost $${o.costUsd.toFixed(2)}${o.costPartialSessions ? ` (${o.costPartialSessions} conversation(s) began before their logs, so their earlier cost is not included)` : ""}; ${tok(o.freshTokens)} fresh tokens`);
  L.push(`- Parallel tool steps ${o.parallel.parallelSteps} (about ${dur(o.parallel.savedMs)} of overlap); sub-agent runs ${o.agents.reduce((n, a) => n + a.calls, 0)}; tokens spent inside sub-agents ${tok(o.subagentFreshTokens)}`);
  L.push("");

  L.push("## Tool mix", "", `Built-in: ${o.builtin.slice(0, 12).map((b) => `${b.name} ${b.calls}`).join(", ") || "none"}`);
  L.push(`MCP: ${o.mcp.map((m) => `${m.server} ${m.calls} calls (${m.errors} errors, ~${tok(m.approxResultTokens)} result tokens, ${m.sessions} conversations)`).join("; ") || "none called"}`);
  L.push(`Skills called: ${o.skills.map((x) => `${x.name} ${x.calls}`).join(", ") || "none"}`);
  L.push(`Sub-agents called: ${o.agents.map((a) => `${a.name} ${a.calls} (${dur(a.totalMs)})`).join(", ") || "none"}`);
  L.push("");
  L.push("## Available but never used in this window", "");
  L.push(`Skills: ${o.availableNeverUsed.skills.join(", ") || "-"}`);
  L.push(`Sub-agent types: ${o.availableNeverUsed.agents.join(", ") || "-"}`);
  L.push(`MCP servers: ${o.availableNeverUsed.mcpServers.join(", ") || "-"}`);
  L.push("");

  L.push("## Rule-based findings (across conversations)", "");
  for (const f of o.findings) {
    L.push(`- [${f.severity}] ${f.title} - ${f.sessions} conversation(s). ${f.detail}`);
    for (const e of f.examples) L.push(`    - e.g. ${e}`);
  }
  if (!o.findings.length) L.push("- none");
  L.push("");

  L.push("## Costliest conversations", "");
  for (const t of o.topCost) L.push(`- ${t.id.slice(0, 8)} $${t.costUsd.toFixed(2)}, ${t.turns} turns, ${dur(t.wallMs)}${opts.redact ? "" : ` - ${t.title}`}`);
  L.push("");

  L.push("## Conversations", "");
  for (const s of stories.slice(0, opts.maxSessions ?? 25)) {
    const cost = s.totals.costUsd !== null ? `$${s.totals.costUsd.toFixed(2)}${s.totals.costComplete ? "" : "+"}` : "n/a";
    L.push(`### ${s.id.slice(0, 8)} ${opts.redact ? "" : s.title}`.trimEnd());
    L.push(`${s.startedAt.slice(0, 16)}Z · ${s.project ?? "?"} · ${s.models.join(", ")} · ${s.turns.length} turns · ${dur(s.totals.wallMs)} wall (model ${dur(s.totals.modelMs)}, tools ${dur(s.totals.toolMs)}) · ${cost} · ${tok(s.totals.freshTokens)} fresh tokens · compactions ${s.totals.compactions}`);
    L.push(`parallel steps ${s.parallel.parallelSteps}, sub-agents ${s.subagents.count}, MCP [${s.capabilities.used.mcpServers.join(", ")}], skills [${s.capabilities.used.skills.join(", ")}]`);
    if (!opts.redact) for (const t of s.turns.slice(0, 12)) L.push(`- turn ${t.index}: ${dur(t.wallMs)}, ${t.steps} steps, ${t.calls} calls${t.costUsd !== null ? `, $${t.costUsd.toFixed(2)}` : ""} - ${t.prompt.slice(0, 140)}`);
    if (s.turns.length > 12 && !opts.redact) L.push(`- ... ${s.turns.length - 12} more turns`);
    for (const f of s.findings.filter((x) => x.severity === "suggest")) L.push(`  * ${f.title}${f.evidence[0] ? ` (${f.evidence[0]})` : ""}`);
    L.push("");
  }
  return L.join("\n");
}
