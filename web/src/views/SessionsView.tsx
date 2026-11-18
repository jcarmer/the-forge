import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Heading, Pane, Text } from "../components";
import { postAction } from "../hooks/useForgeState";

interface Totals { input: number; output: number; cacheRead: number; cacheCreate: number; total: number; fresh: number }
interface McpUsage { server: string; calls: number; tools: Record<string, number>; attributedFresh: number }
interface SessionSummary {
  id: string; source: string; project?: string; startedAt: string; models: string[]; stepCount: number; totals: Totals; mcp: McpUsage[]; allowedMcp?: string[];
}
interface Step { id: string; ts: string; fresh: number; output: number; cacheRead: number; cacheCreate: number; total: number; tools: { name: string; server?: string }[] }
interface Flag { stepId: string; index: number; kind: string; message: string; remediation?: string }
interface Detail { session: SessionSummary & { steps: Step[] }; flags: Flag[]; week: { total: number; fresh: number; sessions: number } }
interface ListResponse { sessions: SessionSummary[]; week: { total: number; fresh: number; sessions: number }; claudeWeeklyRemainingPct: number | null }

type CallKind = "builtin" | "mcp" | "skill" | "agent";
interface Call { id: string; name: string; kind: CallKind; server?: string; label: string; startMs: number; durMs: number | null; background: boolean; resultChars: number; isError: boolean; errorText?: string; turn: number; stepId: string; sidechain: boolean }
interface Turn { index: number; prompt: string; outcome: string; startMs: number; endMs: number; wallMs: number; toolMs: number; userWaitMs: number; modelMs: number; idleBeforeMs: number; steps: number; calls: number; costUsd: number | null; models: string[] }
interface Finding { id: string; severity: "good" | "info" | "suggest"; title: string; detail: string; remediation?: string; actionId?: string; evidence: string[]; turn?: number }
interface Story {
  id: string; title: string; startedAt: string; models: string[]; turns: Turn[]; calls: Call[];
  totals: { wallMs: number; activeMs: number; idleMs: number; toolMs: number; modelMs: number; userWaitMs: number; costUsd: number | null; costComplete: boolean; freshTokens: number; compactions: number };
  parallel: { parallelSteps: number; maxConcurrent: number; savedMs: number };
  subagents: { count: number; backgroundCount: number; totalMs: number; freshTokens: number };
  capabilities: { available: { skills: string[]; agents: string[]; mcpServers: string[] }; used: { skills: string[]; agents: string[]; mcpServers: string[] } };
  findings: Finding[];
  settings?: { effort?: string; permissionMode?: string };
}
interface Overview {
  days: number; sessions: number; turns: number; wallMs: number; activeMs: number; modelMs: number; toolMs: number; userWaitMs: number; idleMs: number; costUsd: number; costPartialSessions: number; freshTokens: number; calls: number;
  builtin: { name: string; calls: number }[]; mcp: { server: string; calls: number; errors: number; approxResultTokens: number; sessions: number }[];
  skills: { name: string; calls: number }[]; agents: { name: string; calls: number; totalMs: number }[];
  parallel: { parallelSteps: number; savedMs: number }; subagentFreshTokens: number;
  availableNeverUsed: { skills: string[]; agents: string[]; mcpServers: string[] };
  findings: { id: string; severity: Finding["severity"]; title: string; detail: string; remediation?: string; actionId?: string; sessions: number; examples: string[] }[];
  topCost: { id: string; title: string; costUsd: number; wallMs: number; turns: number }[];
}

interface ImprovementItem {
  id: string;
  kind: "action" | "data-collection";
  priority: "high" | "medium" | "low";
  title: string;
  patternId?: string;
  why: string;
  guidance: string;
  targetFiles: string[];
  preview: string;
  applied: boolean;
  customRule?: string;
}

interface ImprovementReport {
  generatedAt: string;
  days: number;
  sessionsAnalyzed: number;
  summary: string;
  ollamaNote?: string;
  actions: ImprovementItem[];
  dataCollection: ImprovementItem[];
  telemetry: {
    bashGuardBlocks: number;
    antigravitySessions: number;
    hookEvents: number;
  };
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(2)}%` : "-");
const dur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`);
const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(2)}`);

const TIME_WINDOWS = [4 / 24, 0.5, 1, 7, 14, 30];
const windowLabel = (d: number) => (d < 1 ? `${Math.round(d * 24)}h` : d === 1 ? "24h" : `${d}d`);

// Categorical order is fixed: built-in is the neutral "ordinary" colour. Each bar also carries a letter and the legend (not colour alone).
const KIND: Record<CallKind, { color: string; letter: string; label: string }> = {
  builtin: { color: "#6f9aa0", letter: "B", label: "Built-in tool" },
  mcp: { color: "#00f3ff", letter: "M", label: "MCP server" },
  skill: { color: "#39ff14", letter: "S", label: "Skill" },
  agent: { color: "#ff9900", letter: "A", label: "Sub-agent" },
};
const PHASE = { model: "#4d9fff", tools: "#00f3ff", you: "#ff9900" };
const SEV: Record<Finding["severity"], { variant: "success" | "warning" | "info"; word: string }> = {
  good: { variant: "success", word: "worked" },
  suggest: { variant: "warning", word: "try" },
  info: { variant: "info", word: "note" },
};
const PRIORITY_BADGE: Record<ImprovementItem["priority"], "danger" | "warning" | "info"> = {
  high: "danger",
  medium: "warning",
  low: "info",
};

/** Stacked bar with 2px gaps; each segment has a tooltip and the legend below carries the numbers. */
function SplitBar({ parts }: { parts: { label: string; ms: number; color: string }[] }) {
  const total = parts.reduce((n, p) => n + p.ms, 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", gap: 2, height: 10 }}>
        {parts.filter((p) => p.ms > 0).map((p) => (
          <div key={p.label} title={`${p.label}: ${dur(p.ms)} (${Math.round((p.ms / total) * 100)}%)`} style={{ flex: `${p.ms} 0 2px`, background: p.color, borderRadius: 2 }} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
        {parts.map((p) => (
          <span key={p.label} style={{ fontSize: 12, color: "#7aa5aa" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, background: p.color, borderRadius: 2, marginRight: 5 }} />
            {p.label} {dur(p.ms)} ({Math.round((p.ms / total) * 100)}%)
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 11, color: "#7aa5aa", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, color: "#d6fbff", fontFamily: "var(--font-mono)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#7aa5aa" }}>{sub}</div>}
    </div>
  );
}

function FindingList({
  items,
  onEnact,
  enactingId,
  appliedIds,
}: {
  items: { key: string; severity: Finding["severity"]; title: string; detail: string; remediation?: string; actionId?: string; evidence: string[]; extra?: string }[];
  onEnact?: (actionId: string) => void;
  enactingId?: string | null;
  appliedIds?: Set<string>;
}) {
  return (
    <UI.VStack spacing={UI.Size.px(10)} align="stretch">
      {items.map((f) => {
        const isApplied = Boolean(f.actionId && appliedIds?.has(f.actionId));
        return (
          <div key={f.key} style={{ padding: "6px 8px", borderLeft: `2px solid ${f.severity === "suggest" ? "#ff9900" : f.severity === "good" ? "#39ff14" : "#00f3ff"}`, background: "rgba(0, 243, 255, 0.03)" }}>
            <UI.HStack spacing={UI.Size.px(8)} align="center">
              <Badge variant={SEV[f.severity].variant}>{SEV[f.severity].word}</Badge>
              <Text>{f.title}</Text>
              {f.extra && <Text muted>{f.extra}</Text>}
              <UI.Spacer />
              {f.actionId && onEnact && (
                isApplied ? (
                  <Badge variant="success">Enacted in repo</Badge>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={enactingId === f.actionId}
                    disabled={Boolean(enactingId)}
                    onClick={() => onEnact(f.actionId!)}
                  >
                    Enact in the-forge
                  </Button>
                )
              )}
            </UI.HStack>
            <div style={{ marginLeft: 4, marginTop: 2, fontSize: 12, color: "#7aa5aa" }}>{f.detail}</div>
            {f.remediation && (
              <div style={{ marginLeft: 4, marginTop: 4, fontSize: 12, color: "#d6fbff" }}>
                <span style={{ color: "#00f3ff", fontWeight: 600 }}>How to fix: </span>
                {f.remediation}
              </div>
            )}
            {f.evidence.map((e) => (
              <div key={e} style={{ marginLeft: 12, marginTop: 2, fontSize: 12, color: "#7aa5aa", fontFamily: "var(--font-mono)" }}>
                · {e}
              </div>
            ))}
          </div>
        );
      })}
    </UI.VStack>
  );
}

function ImprovementCard({
  item,
  onEnact,
  enactingId,
}: {
  item: ImprovementItem;
  onEnact: (id: string, customRule?: string) => void;
  enactingId: string | null;
}) {
  return (
    <div style={{ padding: 10, border: "1px solid rgba(0, 243, 255, 0.18)", borderRadius: 4, background: "rgba(0, 18, 24, 0.45)" }}>
      <UI.VStack spacing={UI.Size.px(6)} align="stretch">
        <UI.HStack spacing={UI.Size.px(8)} align="center">
          <Badge variant={item.applied ? "success" : PRIORITY_BADGE[item.priority]}>
            {item.applied ? "enacted" : item.priority}
          </Badge>
          <Badge variant="info">{item.kind === "action" ? "repo action" : "data collection"}</Badge>
          <Text>{item.title}</Text>
          <UI.Spacer />
          {item.applied ? (
            <Badge variant="success">Active in /opt/the-forge</Badge>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={enactingId === item.id}
              disabled={Boolean(enactingId)}
              onClick={() => onEnact(item.id, item.customRule)}
            >
              {item.kind === "action" ? "Enact change" : "Enact data collection"}
            </Button>
          )}
        </UI.HStack>
        <div style={{ fontSize: 12, color: "#7aa5aa" }}>
          <strong style={{ color: "#9ec5ca" }}>Observed: </strong>
          {item.why}
        </div>
        <div style={{ fontSize: 12, color: "#d6fbff" }}>
          <strong style={{ color: "#00f3ff" }}>Permanent change: </strong>
          {item.guidance}
        </div>
        <div style={{ fontSize: 11, color: "#7aa5aa", fontFamily: "var(--font-mono)" }}>
          Files: {item.targetFiles.join(", ")}
        </div>
        <pre style={{ margin: 0, padding: 8, fontSize: 11, color: "#9ec5ca", background: "rgba(0, 0, 0, 0.35)", borderRadius: 3, overflowX: "auto", fontFamily: "var(--font-mono)" }}>
          {item.preview}
        </pre>
      </UI.VStack>
    </div>
  );
}

/** One row per tool call across the turn's wall time. White space between bars is the model thinking. */
function Gantt({ turn, calls }: { turn: Turn; calls: Call[] }) {
  const rows = calls.filter((c) => c.turn === turn.index).sort((a, b) => a.startMs - b.startMs);
  const W = 640;
  const LEFT = 250;
  const ROW = 16;
  const span = Math.max(1, turn.wallMs);
  const shown = rows.slice(0, 120);
  const x = (ms: number) => LEFT + Math.max(0, Math.min(1, (ms - turn.startMs) / span)) * W;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div style={{ overflowX: "auto", maxHeight: "46vh", overflowY: "auto" }}>
      <svg width={LEFT + W + 20} height={shown.length * ROW + 24} role="img" aria-label={`Tool calls during turn ${turn.index}`} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={LEFT + t * W} x2={LEFT + t * W} y1={0} y2={shown.length * ROW} stroke="#0b7f86" strokeOpacity={0.25} />
            <text x={LEFT + t * W} y={shown.length * ROW + 14} fill="#7aa5aa" textAnchor={t === 1 ? "end" : t === 0 ? "start" : "middle"}>
              {dur(span * t)}
            </text>
          </g>
        ))}
        {shown.map((c, i) => {
          const y = i * ROW;
          const end = c.durMs === null ? c.startMs : c.startMs + c.durMs;
          const x1 = x(c.startMs);
          const w = Math.max(3, x(end) - x1);
          const kd = KIND[c.kind];
          const name = `${c.sidechain ? "↳ " : ""}${c.server ? `${c.server}:` : ""}${c.name}${c.label ? ` ${c.label}` : ""}`;
          return (
            <g key={c.id}>
              <title>{`${kd.label}: ${name}\nstart +${dur(c.startMs - turn.startMs)}, ${c.durMs === null ? "no result logged" : dur(c.durMs)}${c.background ? " (background)" : ""}\nresult ${k(Math.round(c.resultChars / 4))} tokens${c.isError ? ` - ERROR${c.errorText ? `: ${c.errorText}` : ""}` : ""}`}</title>
              <text x={0} y={y + 12} fill={c.isError ? "#ff3366" : "#d6fbff"}>
                {kd.letter} {name.length > 38 ? `${name.slice(0, 37)}…` : name}
              </text>
              <rect x={x1} y={y + 3} width={Math.min(w, LEFT + W - x1)} height={10} rx={2} fill={c.background ? "none" : kd.color} stroke={kd.color} strokeWidth={c.background ? 1.5 : 0} strokeDasharray={c.background ? "3 2" : undefined} />
            </g>
          );
        })}
      </svg>
      {rows.length > shown.length && <Text muted>Showing the first {shown.length} of {rows.length} calls.</Text>}
    </div>
  );
}

export function SessionsView() {
  const [days, setDays] = useState(7);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [list, setList] = useState<ListResponse | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [turnIdx, setTurnIdx] = useState<number>(1);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notesMsg, setNotesMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [briefMsg, setBriefMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [improveReport, setImproveReport] = useState<ImprovementReport | null>(null);
  const [improveBusy, setImproveBusy] = useState(false);
  const [enactingId, setEnactingId] = useState<string | null>(null);
  const [improveMsg, setImproveMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, o] = await Promise.all([fetch("/api/sessions"), fetch(`/api/sessions/overview?days=${days}`)]);
      if (!l.ok) throw new Error(`HTTP ${l.status}`);
      setList((await l.json()) as ListResponse);
      if (o.ok) setOverview(((await o.json()) as { overview: Overview }).overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    setNotes({});
    setNotesMsg(null);
    const [d, s] = await Promise.all([fetch(`/api/sessions/${encodeURIComponent(id)}`), fetch(`/api/sessions/${encodeURIComponent(id)}/story`)]);
    setDetail(d.ok ? ((await d.json()) as Detail) : null);
    const st = s.ok ? ((await s.json()) as { story: Story }).story : null;
    setStory(st);
    // Open on the turn that took longest: usually where the interesting work is.
    if (st?.turns.length) setTurnIdx([...st.turns].sort((a, b) => b.wallMs - a.wallMs)[0]!.index);
  }

  async function fetchBrief(redact: boolean): Promise<string> {
    const res = await fetch(`/api/sessions/digest?days=${days}${redact ? "&redact=1" : ""}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ((await res.json()) as { markdown: string }).markdown;
  }
  async function copyBrief(redact: boolean) {
    try {
      const md = await fetchBrief(redact);
      await navigator.clipboard.writeText(md);
      setBriefMsg(`Copied ${md.length.toLocaleString()} characters${redact ? " (prompts and commands removed)" : ""}. Paste it into any LLM.`);
    } catch (e) {
      setBriefMsg(`Could not copy: ${e instanceof Error ? e.message : String(e)}. Use \`sessions digest --out file.md\` instead.`);
    }
  }

  async function generateWaysToImprove() {
    setImproveBusy(true);
    setImproveMsg("Analyzing session patterns, guard telemetry, and repo rules...");
    try {
      const res = await postAction<{ report: ImprovementReport }>("/api/actions/session-improve", { days, useOllama: true });
      setImproveReport(res.report);
      setImproveMsg(null);
    } catch (e) {
      setImproveMsg(`Could not generate improvements: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImproveBusy(false);
    }
  }

  async function enact(id: string, customRule?: string) {
    setEnactingId(id);
    setImproveMsg(null);
    try {
      const res = await postAction<{ ok: boolean; detail: string; modifiedFiles: string[]; report?: ImprovementReport }>("/api/actions/session-enact", {
        id,
        days,
        customRule,
      });
      if (res.report) setImproveReport(res.report);
      setImproveMsg(res.ok ? `${res.detail} (${res.modifiedFiles.join(", ")})` : `Failed: ${res.detail}`);
      await load();
      if (detail) await open(detail.session.id);
    } catch (e) {
      setImproveMsg(`Enact failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEnactingId(null);
    }
  }

  async function explain() {
    if (!detail) return;
    setBusy(true);
    setNotesMsg("Asking Ollama (only token counts and tool names are sent)...");
    try {
      const r = await postAction<{ ok: boolean; model: string; notes: { stepId: string; note: string }[]; detail?: string }>("/api/actions/session-analyze", { id: detail.session.id });
      setNotes(Object.fromEntries(r.notes.map((n) => [n.stepId, n.note])));
      setNotesMsg(r.ok ? `Notes from ${r.model} for the costliest steps` : `Ollama failed: ${r.detail}`);
    } catch (e) {
      setNotesMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const appliedIds = useMemo(() => {
    const s = new Set<string>();
    for (const a of improveReport?.actions ?? []) if (a.applied) s.add(a.id);
    for (const d of improveReport?.dataCollection ?? []) if (d.applied) s.add(d.id);
    return s;
  }, [improveReport]);

  const maxFresh = detail ? Math.max(1, ...detail.session.steps.map((s) => s.fresh)) : 1;
  const week = detail?.week ?? list?.week;
  const turn = useMemo(() => story?.turns.find((t) => t.index === turnIdx) ?? null, [story, turnIdx]);
  const maxTurn = story ? Math.max(1, ...story.turns.map((t) => t.wallMs)) : 1;

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      {/* ------------------------------------------------ overview + advisor brief */}
      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <UI.HStack spacing={UI.Size.px(10)} align="center">
            <Heading>Workflow overview</Heading>
            {TIME_WINDOWS.map((d) => (
              <Button key={windowLabel(d)} variant={Math.abs(days - d) < 0.001 ? "primary" : "secondary"} size="sm" onClick={() => setDays(d)}>
                {windowLabel(d)}
              </Button>
            ))}
            <UI.Spacer />
            <Button variant="primary" size="sm" loading={improveBusy} disabled={improveBusy} onClick={() => void generateWaysToImprove()}>
              Generate ways to improve
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void copyBrief(false)}>Copy advisor brief</Button>
            <Button variant="secondary" size="sm" onClick={() => void copyBrief(true)}>Copy (redacted)</Button>
            <Button variant="secondary" size="sm" onClick={() => void load()}>Refresh</Button>
          </UI.HStack>
          <Text muted>
            The advisor brief is a markdown summary of these conversations (time, cost, tools, MCP, skills, sub-agents, findings) written to hand to an LLM and ask how to improve your workflow. Redacted removes prompts, commands and file paths. Everything below is measured from the logs; savings versus not using a skill or MCP cannot be measured and are never claimed.
          </Text>
          {briefMsg && <Text>{briefMsg}</Text>}
          {improveMsg && <Text>{improveMsg}</Text>}
          {error && <Text muted>{error}</Text>}

          {overview && overview.sessions > 0 && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
                <Stat label="Conversations" value={String(overview.sessions)} sub={`${overview.turns} turns, ${overview.calls} tool calls`} />
                <Stat label="Cost" value={usd(overview.costUsd)} sub={overview.costPartialSessions ? `+ earlier turns of ${overview.costPartialSessions} not logged` : "from SDK cost counters"} />
                <Stat label="Active time" value={dur(overview.activeMs)} sub={`${dur(overview.idleMs)} idle between turns`} />
                <Stat label="Parallel steps" value={String(overview.parallel.parallelSteps)} sub={`~${dur(overview.parallel.savedMs)} overlap`} />
                <Stat label="Sub-agent runs" value={String(overview.agents.reduce((n, a) => n + a.calls, 0))} sub={`${k(overview.subagentFreshTokens)} tokens inside`} />
              </div>
              <SplitBar
                parts={[
                  { label: "Model (thinking, writing, approvals)", ms: overview.modelMs, color: PHASE.model },
                  { label: "Tools", ms: overview.toolMs, color: PHASE.tools },
                  { label: "Waiting on your answer", ms: overview.userWaitMs, color: PHASE.you },
                ]}
              />
              <Heading>What was used</Heading>
              <Text muted>Built-in: {overview.builtin.slice(0, 8).map((b) => `${b.name} ${b.calls}`).join(", ") || "none"}</Text>
              <Text muted>
                MCP: {overview.mcp.map((m) => `${m.server} ${m.calls} calls${m.errors ? ` (${m.errors} errors)` : ""}`).join(", ") || "none called"} · Skills: {overview.skills.map((s) => `${s.name} ${s.calls}`).join(", ") || "none called"} · Sub-agents:{" "}
                {overview.agents.map((a) => `${a.name} ${a.calls}`).join(", ") || "none called"}
              </Text>
              <Text muted>
                Available but never used: skills {overview.availableNeverUsed.skills.length} · sub-agent types {overview.availableNeverUsed.agents.join(", ") || "-"} · MCP {overview.availableNeverUsed.mcpServers.join(", ") || "-"}
              </Text>
              <UI.HStack spacing={UI.Size.px(10)} align="center">
                <Heading>Patterns across conversations</Heading>
                <UI.Spacer />
                {!improveReport && (
                  <Button variant="secondary" size="sm" loading={improveBusy} disabled={improveBusy} onClick={() => void generateWaysToImprove()}>
                    Generate self-improvement plan
                  </Button>
                )}
              </UI.HStack>
              <FindingList
                items={overview.findings.map((f) => ({
                  key: f.id,
                  severity: f.severity,
                  title: f.title,
                  detail: f.detail,
                  remediation: f.remediation,
                  actionId: f.actionId,
                  evidence: f.examples,
                  extra: `${f.sessions} conversation${f.sessions === 1 ? "" : "s"}`,
                }))}
                onEnact={(actionId) => void enact(actionId)}
                enactingId={enactingId}
                appliedIds={appliedIds}
              />
            </>
          )}
          {overview && overview.sessions === 0 && <Text muted>No conversations found in this window.</Text>}
        </UI.VStack>
      </Pane>

      {/* ------------------------------------------------ self-improvement loop (on request) */}
      {improveReport && (
        <Pane padding={12}>
          <UI.VStack spacing={UI.Size.px(10)} align="stretch">
            <UI.HStack spacing={UI.Size.px(10)} align="center">
              <Heading>Self-Improvement Loop</Heading>
              <Badge variant="info">{improveReport.summary}</Badge>
              <UI.Spacer />
              <Text muted>
                guard blocks: {improveReport.telemetry.bashGuardBlocks} · antigravity sessions: {improveReport.telemetry.antigravitySessions} · hook events: {improveReport.telemetry.hookEvents}
              </Text>
              <Button variant="secondary" size="sm" loading={improveBusy} disabled={improveBusy} onClick={() => void generateWaysToImprove()}>
                Re-evaluate
              </Button>
            </UI.HStack>
            <Text muted>
              Every action below edits files directly in <code>/opt/the-forge</code> (under <code>ops/claude-user/</code>) and syncs the active agent configuration so improvements persist across container rebuilds and new sessions.
            </Text>
            {improveReport.ollamaNote && (
              <div style={{ padding: "6px 10px", borderLeft: "2px solid #00f3ff", fontSize: 12, color: "#d6fbff" }}>
                <strong style={{ color: "#00f3ff" }}>Ollama synthesis: </strong>
                {improveReport.ollamaNote}
              </div>
            )}

            <Heading>Suggested actions to implement</Heading>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              {improveReport.actions.map((item) => (
                <ImprovementCard key={item.id} item={item} onEnact={(id, rule) => void enact(id, rule)} enactingId={enactingId} />
              ))}
            </UI.VStack>

            <Heading>Suggested data collection to find inefficiencies</Heading>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              {improveReport.dataCollection.map((item) => (
                <ImprovementCard key={item.id} item={item} onEnact={(id, rule) => void enact(id, rule)} enactingId={enactingId} />
              ))}
            </UI.VStack>
          </UI.VStack>
        </Pane>
      )}

      {/* ------------------------------------------------ conversation list */}
      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(6)} align="stretch">
          <Heading>Conversations</Heading>
          {list?.sessions.map((s) => (
            <UI.HStack key={s.id} spacing={UI.Size.px(10)} align="center">
              <Button variant={detail?.session.id === s.id ? "primary" : "secondary"} size="sm" onClick={() => void open(s.id)}>{s.id.slice(0, 8)}</Button>
              <Text muted>{new Date(s.startedAt).toLocaleString()}</Text>
              <Text>{s.project ?? ""}</Text>
              <UI.Spacer />
              {s.mcp.map((m) => (
                <Badge key={m.server}>{`${m.server} x${m.calls}`}</Badge>
              ))}
              <Text muted>{s.stepCount} steps · {k(s.totals.fresh)} fresh ({pct(s.totals.fresh, list.week.fresh)} of week)</Text>
            </UI.HStack>
          ))}
          {list && list.sessions.length === 0 && <Text muted>No parseable sessions found.</Text>}
        </UI.VStack>
      </Pane>

      {/* ------------------------------------------------ one conversation as a story */}
      {story && (
        <Pane padding={12}>
          <UI.VStack spacing={UI.Size.px(10)} align="stretch">
            <Heading>{story.title}</Heading>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
              <Stat label="Turns" value={String(story.turns.length)} sub={story.models.join(", ")} />
              <Stat label="Cost" value={usd(story.totals.costUsd)} sub={story.totals.costComplete ? undefined : "earlier turns not in log"} />
              <Stat label="Active" value={dur(story.totals.activeMs)} sub={`${dur(story.totals.idleMs)} idle between turns`} />
              <Stat label="Parallel steps" value={String(story.parallel.parallelSteps)} sub={`max ${story.parallel.maxConcurrent} at once, ~${dur(story.parallel.savedMs)} saved`} />
              <Stat label="Sub-agents" value={String(story.subagents.count)} sub={story.subagents.count ? `${k(story.subagents.freshTokens)} tokens inside` : "none"} />
              <Stat label="Compactions" value={String(story.totals.compactions)} />
            </div>
            <SplitBar
              parts={[
                { label: "Model", ms: story.totals.modelMs, color: PHASE.model },
                { label: "Tools", ms: story.totals.toolMs, color: PHASE.tools },
                { label: "Waiting on you", ms: story.totals.userWaitMs, color: PHASE.you },
              ]}
            />

            <Heading>What happened, turn by turn</Heading>
            <Text muted>Bar length = how long the turn took. Click a turn to see its tool calls below.</Text>
            <UI.VStack spacing={UI.Size.px(4)} align="stretch">
              {story.turns.map((t) => (
                <div key={t.index} onClick={() => setTurnIdx(t.index)} style={{ cursor: "pointer", padding: "4px 6px", borderLeft: `2px solid ${t.index === turnIdx ? "#00f3ff" : "transparent"}` }}>
                  <UI.HStack spacing={UI.Size.px(10)} align="center">
                    <Text>{`#${t.index}`}</Text>
                    <div style={{ width: 160, flexShrink: 0 }}>
                      <div style={{ display: "flex", gap: 1, height: 8, width: `${Math.max(3, (t.wallMs / maxTurn) * 100)}%` }}>
                        <div title={`model ${dur(t.modelMs)}`} style={{ flex: `${t.modelMs} 0 1px`, background: PHASE.model, borderRadius: 2 }} />
                        <div title={`tools ${dur(t.toolMs)}`} style={{ flex: `${t.toolMs} 0 1px`, background: PHASE.tools, borderRadius: 2 }} />
                        <div title={`waiting on you ${dur(t.userWaitMs)}`} style={{ flex: `${t.userWaitMs} 0 0`, background: PHASE.you, borderRadius: 2 }} />
                      </div>
                    </div>
                    <Text muted>{dur(t.wallMs)} · {t.steps} steps · {t.calls} calls · {usd(t.costUsd)}{t.idleBeforeMs > 300_000 ? ` · after ${dur(t.idleBeforeMs)} away` : ""}</Text>
                  </UI.HStack>
                  <div style={{ fontSize: 13, color: "#d6fbff" }}>{t.prompt}</div>
                  {t.outcome && <div style={{ fontSize: 12, color: "#7aa5aa" }}>→ {t.outcome}</div>}
                </div>
              ))}
            </UI.VStack>

            {turn && (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
                  <Heading>{`Turn ${turn.index} tool timeline`}</Heading>
                  {(Object.keys(KIND) as CallKind[]).map((kk) => (
                    <span key={kk} style={{ fontSize: 12, color: "#7aa5aa" }}>
                      <span style={{ display: "inline-block", width: 8, height: 8, background: KIND[kk].color, borderRadius: 2, marginRight: 5 }} />
                      {KIND[kk].letter} {KIND[kk].label}
                    </span>
                  ))}
                  <span style={{ fontSize: 12, color: "#7aa5aa" }}>dashed = ran in background</span>
                </div>
                <Text muted>Rows are tool calls over the turn's wall time. Gaps are the model generating. Several bars overlapping in time means parallel calls; ↳ marks work done inside a sub-agent.</Text>
                <Gantt turn={turn} calls={story.calls} />
              </>
            )}

            <Heading>What worked and what to try</Heading>
            {story.findings.length === 0 && <Text muted>Nothing notable.</Text>}
            <FindingList
              items={story.findings.map((f, i) => ({
                key: `${f.id}-${i}`,
                severity: f.severity,
                title: f.title,
                detail: f.detail,
                remediation: f.remediation,
                actionId: f.actionId,
                evidence: f.evidence,
              }))}
              onEnact={(actionId) => void enact(actionId)}
              enactingId={enactingId}
              appliedIds={appliedIds}
            />
          </UI.VStack>
        </Pane>
      )}

      {/* ------------------------------------------------ token detail (unchanged analysis) */}
      {detail && (
        <Pane padding={12}>
          <UI.VStack spacing={UI.Size.px(10)} align="stretch">
            <UI.HStack spacing={UI.Size.px(12)} align="center">
              <Heading>{`Token detail ${detail.session.id.slice(0, 8)}`}</Heading>
              <Text muted>fresh {k(detail.session.totals.fresh)} · cache read {k(detail.session.totals.cacheRead)} · output {k(detail.session.totals.output)}</Text>
              <UI.Spacer />
              <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => void explain()}>Explain costly steps (Ollama)</Button>
            </UI.HStack>
            <Text muted>Fresh = input + output + cache writes (what the allowance mostly tracks). Per-step shares are of the last 7 days observed here, not of the plan limit.</Text>
            {notesMsg && <Text muted>{notesMsg}</Text>}
            {detail.flags.map((f, i) => (
              <div key={`${f.stepId}-${f.kind}-${i}`}>
                <Text>Step {f.index} [{f.kind}]: {f.message}</Text>
                {f.remediation && (
                  <div style={{ marginLeft: 12, fontSize: 12, color: "#7aa5aa" }}>
                    <span style={{ color: "#00f3ff" }}>How to fix: </span>{f.remediation}
                  </div>
                )}
              </div>
            ))}
            <div style={{ maxHeight: "40vh", overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "hsl(var(--muted-foreground))" }}>
                    <th>#</th><th>Fresh</th><th style={{ width: "22%" }} /><th>% week</th><th>Cache wr</th><th>Cache rd</th><th>Out</th><th>Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.session.steps.map((s, i) => (
                    <Fragment key={s.id}>
                      <tr>
                        <td>{i + 1}</td>
                        <td>{k(s.fresh)}</td>
                        <td><div style={{ height: 8, width: `${(s.fresh / maxFresh) * 100}%`, background: "hsl(var(--primary))", borderRadius: 2 }} /></td>
                        <td>{pct(s.fresh, week?.fresh ?? 0)}</td>
                        <td>{k(s.cacheCreate)}</td>
                        <td>{k(s.cacheRead)}</td>
                        <td>{k(s.output)}</td>
                        <td>{s.tools.map((t) => t.name.replace(/^mcp__/, "")).join(", ")}</td>
                      </tr>
                      {notes[s.id] && (
                        <tr><td /><td colSpan={7} style={{ color: "hsl(var(--muted-foreground))" }}>↳ {notes[s.id]}</td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </UI.VStack>
        </Pane>
      )}
    </UI.VStack>
  );
}
