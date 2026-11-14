import { Fragment, useCallback, useEffect, useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button } from "reend-components";
import { Heading, Pane, Text } from "../components";
import { postAction } from "../hooks/useForgeState";

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
  fresh: number;
}
interface McpUsage {
  server: string;
  calls: number;
  tools: Record<string, number>;
  attributedFresh: number;
}
interface SessionSummary {
  id: string;
  source: string;
  project?: string;
  startedAt: string;
  models: string[];
  stepCount: number;
  totals: Totals;
  mcp: McpUsage[];
  allowedMcp?: string[];
}
interface Step {
  id: string;
  ts: string;
  fresh: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
  tools: { name: string; server?: string }[];
}
interface Flag {
  stepId: string;
  index: number;
  kind: string;
  message: string;
}
interface Detail {
  session: SessionSummary & { steps: Step[]; builtinTools: Record<string, number> };
  flags: Flag[];
  week: { total: number; fresh: number; sessions: number };
}
interface ListResponse {
  sessions: SessionSummary[];
  week: { total: number; fresh: number; sessions: number };
  claudeWeeklyRemainingPct: number | null;
  coverage: { source: string; tokens: boolean; mcp: boolean; note: string }[];
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const pct = (n: number, of: number) => (of > 0 ? `${((n / of) * 100).toFixed(2)}%` : "-");

export function SessionsView() {
  const [list, setList] = useState<ListResponse | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notesMsg, setNotesMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setList((await res.json()) as ListResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function open(id: string) {
    setNotes({});
    setNotesMsg(null);
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
    setDetail(res.ok ? ((await res.json()) as Detail) : null);
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

  const maxFresh = detail ? Math.max(1, ...detail.session.steps.map((s) => s.fresh)) : 1;
  const week = detail?.week ?? list?.week;

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <UI.HStack spacing={UI.Size.px(12)} align="center">
            <Heading>Conversation Sessions</Heading>
            <UI.Spacer />
            {list && (
              <Text muted>
                Last 7 days: {k(list.week.fresh)} fresh / {k(list.week.total)} total tokens, {list.week.sessions} sessions
                {list.claudeWeeklyRemainingPct !== null ? ` · Claude weekly allowance ${list.claudeWeeklyRemainingPct}% remaining` : ""}
              </Text>
            )}
            <Button variant="primary" size="sm" onClick={() => void loadList()}>
              Refresh
            </Button>
          </UI.HStack>
          <Text muted>
            Fresh = input + output + cache writes (what the allowance mostly tracks). Cache reads are cheap but dominate raw totals. Per-step shares are of the last 7 days observed here, not of the plan limit, which is not exposed.
          </Text>
          {error && <Text muted>{error}</Text>}
          {list?.coverage
            .filter((c) => !c.tokens)
            .map((c) => (
              <Text key={c.source} muted>
                {c.source}: not analysable - {c.note}
              </Text>
            ))}
        </UI.VStack>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(6)} align="stretch">
          {list?.sessions.map((s) => (
            <UI.HStack key={s.id} spacing={UI.Size.px(10)} align="center">
              <Button variant={detail?.session.id === s.id ? "primary" : "secondary"} size="sm" onClick={() => void open(s.id)}>
                {s.id.slice(0, 8)}
              </Button>
              <Text muted>{new Date(s.startedAt).toLocaleString()}</Text>
              <Text>{s.project ?? ""}</Text>
              <UI.Spacer />
              {s.mcp.map((m) => (
                <Badge key={m.server}>{`${m.server} x${m.calls}`}</Badge>
              ))}
              <Text muted>
                {s.stepCount} steps · {k(s.totals.fresh)} fresh ({pct(s.totals.fresh, list.week.fresh)} of week)
              </Text>
            </UI.HStack>
          ))}
          {list && list.sessions.length === 0 && <Text muted>No parseable sessions found.</Text>}
        </UI.VStack>
      </Pane>

      {detail && (
        <Pane padding={12}>
          <UI.VStack spacing={UI.Size.px(10)} align="stretch">
            <UI.HStack spacing={UI.Size.px(12)} align="center">
              <Heading>{`Session ${detail.session.id.slice(0, 8)}`}</Heading>
              <Text muted>
                {detail.session.models.join(", ")} · fresh {k(detail.session.totals.fresh)} · cache read {k(detail.session.totals.cacheRead)} · output {k(detail.session.totals.output)}
              </Text>
              <UI.Spacer />
              <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => void explain()}>
                Explain costly steps (Ollama)
              </Button>
            </UI.HStack>
            {notesMsg && <Text muted>{notesMsg}</Text>}

            <Heading>MCP usage</Heading>
            {detail.session.allowedMcp?.length ? <Text muted>Pre-approved by T3 at runtime: {detail.session.allowedMcp.join(", ")}</Text> : null}
            {detail.session.mcp.length === 0 && <Text muted>No MCP tools were called.</Text>}
            {detail.session.mcp.map((m) => (
              <Text key={m.server}>
                {m.server}: {m.calls} calls ({Object.entries(m.tools).map(([t, n]) => `${t} x${n}`).join(", ")}) · ~{k(m.attributedFresh)} fresh tokens in those steps
              </Text>
            ))}

            {detail.flags.length > 0 && (
              <>
                <Heading>Findings</Heading>
                {detail.flags.map((f, i) => (
                  <Text key={`${f.stepId}-${f.kind}-${i}`}>
                    Step {f.index} [{f.kind}]: {f.message}
                  </Text>
                ))}
              </>
            )}

            <Heading>Steps</Heading>
            <div style={{ maxHeight: "50vh", overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "hsl(var(--muted-foreground))" }}>
                    <th>#</th>
                    <th>Fresh</th>
                    <th style={{ width: "22%" }} />
                    <th>% week</th>
                    <th>Cache wr</th>
                    <th>Cache rd</th>
                    <th>Out</th>
                    <th>Tools</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.session.steps.map((s, i) => (
                    <Fragment key={s.id}>
                      <tr>
                        <td>{i + 1}</td>
                        <td>{k(s.fresh)}</td>
                        <td>
                          <div style={{ height: 8, width: `${(s.fresh / maxFresh) * 100}%`, background: "hsl(var(--primary))", borderRadius: 2 }} />
                        </td>
                        <td>{pct(s.fresh, week?.fresh ?? 0)}</td>
                        <td>{k(s.cacheCreate)}</td>
                        <td>{k(s.cacheRead)}</td>
                        <td>{k(s.output)}</td>
                        <td>{s.tools.map((t) => t.name.replace(/^mcp__/, "")).join(", ")}</td>
                      </tr>
                      {notes[s.id] && (
                        <tr>
                          <td />
                          <td colSpan={7} style={{ color: "hsl(var(--muted-foreground))" }}>
                            ↳ {notes[s.id]}
                          </td>
                        </tr>
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
