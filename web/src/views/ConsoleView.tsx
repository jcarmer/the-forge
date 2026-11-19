import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "./git/ui";

interface Chip {
  label: string;
  line: string;
  kind: "dir" | "path" | "flag" | "idea" | "start" | "history";
  hint?: string;
}

interface Entry {
  id: number;
  cwd: string;
  line: string;
  output: string;
  ok: boolean;
  exitCode?: number | null;
  truncated?: boolean;
  durationMs?: number;
}

const HEADERS = { "content-type": "application/json", "x-forge-console": "1" };
const KIND_COLOR: Record<Chip["kind"], string> = {
  dir: "#00f3ff",
  path: "#d6fbff",
  flag: "#ff9900",
  idea: "#c792ff",
  start: "#39ff14",
  history: "#7aa5aa",
};

const QUICK_STARTERS = [
  { label: "ls -la", cmd: "ls -la" },
  { label: "git status", cmd: "git status" },
  { label: "git log", cmd: "git log --oneline -10" },
  { label: "df -h", cmd: "df -h" },
  { label: "docker ps", cmd: "docker ps" },
];

const QUICK_KEYS = ["/", "-", "--", "|", "&&", "~", "..", '"'] as const;

const STORAGE_CWD = "forge.console.cwd";
const STORAGE_HIST = "forge.console.history";
const STORAGE_WRAP = "forge.console.wrap";

function readStoredCwd(): string {
  try {
    return localStorage.getItem(STORAGE_CWD) || "/projects";
  } catch {
    return "/projects";
  }
}

function readStoredHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_HIST);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(-50) : [];
  } catch {
    return [];
  }
}

function readStoredWrap(): boolean {
  try {
    return localStorage.getItem(STORAGE_WRAP) === "1";
  } catch {
    return false;
  }
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function pathSegments(cwd: string): { label: string; path: string }[] {
  const clean = cwd.replace(/\/+$/, "") || "/";
  if (clean === "/") return [{ label: "/", path: "/" }];
  const parts = clean.split("/").filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += `/${p}`;
    out.push({ label: p, path: acc });
  }
  return out;
}

/**
 * Mobile-first console: full-height flex terminal with clickable cwd breadcrumbs, 1-tap folder browser,
 * instant local suggestions + subcommands, mobile quick-keys, wrap/scroll toggle, output copy/re-run,
 * command cancellation, and on-demand Ollama AI ideas.
 */
export function ConsoleView({
  fullscreen = false,
  onToggleFullscreen,
}: {
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const [cwd, setCwd] = useState<string>(readStoredCwd);
  const [subdirs, setSubdirs] = useState<string[]>([]);
  const [line, setLine] = useState("");
  const [log, setLog] = useState<Entry[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [ideas, setIdeas] = useState<Chip[]>([]);
  const [ideaState, setIdeaState] = useState<"idle" | "thinking" | "off" | "ready">("idle");
  const [busyCmd, setBusyCmd] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(readStoredHistory);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [wrapOutput, setWrapOutput] = useState<boolean>(readStoredWrap);
  const [showFolders, setShowFolders] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const nextId = useRef(1);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  const busy = busyCmd !== null;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_CWD, cwd);
    } catch {
      /* ignore storage errors */
    }
  }, [cwd]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_HIST, JSON.stringify(history.slice(-50)));
    } catch {
      /* ignore storage errors */
    }
  }, [history]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_WRAP, wrapOutput ? "1" : "0");
    } catch {
      /* ignore storage errors */
    }
  }, [wrapOutput]);

  // Abort any in-flight command if the component unmounts.
  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
      aiAbortRef.current?.abort();
    };
  }, []);

  // Instant deterministic suggestions (never rewrites `line` mid-keystroke so typing `cd...` stays smooth).
  useEffect(() => {
    const ctl = new AbortController();
    const fast = setTimeout(() => {
      call<{ chips: Chip[]; normalized: string; cwd?: string; subdirs?: string[] }>(
        "/api/console/suggest",
        { cwd, line, history },
        ctl.signal,
      )
        .then((r) => {
          setChips(r.chips);
          if (r.cwd && r.cwd !== cwd) setCwd(r.cwd);
          if (Array.isArray(r.subdirs)) setSubdirs(r.subdirs);
        })
        .catch(() => undefined);
    }, 60);
    return () => {
      ctl.abort();
      clearTimeout(fast);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, line, history.length]);

  // Scroll only the terminal log box (never the outer viewport).
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busyCmd]);

  const estimateCols = useCallback(() => {
    const w = logBoxRef.current?.clientWidth ?? (typeof window !== "undefined" ? window.innerWidth : 360);
    return Math.max(40, Math.min(180, Math.floor((w - 24) / 7.8)));
  }, []);

  const run = useCallback(
    async (text: string, opts?: { keepInput?: boolean; silentHistory?: boolean }) => {
      const cmd = text.trim();
      if (!cmd || runAbortRef.current) return;
      const ctl = new AbortController();
      runAbortRef.current = ctl;
      setBusyCmd(cmd);
      setHistoryCursor(null);
      if (!opts?.keepInput) setLine("");
      const started = Date.now();
      try {
        const r = await call<{ ok: boolean; output: string; cwd: string; exitCode?: number | null; truncated?: boolean }>(
          "/api/console/run",
          { cwd, line: cmd, cols: estimateCols() },
          ctl.signal,
        );
        setLog((l) => [
          ...l.slice(-79),
          {
            id: nextId.current++,
            cwd,
            line: cmd,
            output: r.output,
            ok: r.ok,
            exitCode: r.exitCode,
            truncated: r.truncated,
            durationMs: Date.now() - started,
          },
        ]);
        setCwd(r.cwd);
        if (!opts?.silentHistory) {
          setHistory((h) => [...h.filter((x) => x !== cmd), cmd].slice(-50));
        }
      } catch (e) {
        const aborted = ctl.signal.aborted;
        setLog((l) => [
          ...l.slice(-79),
          {
            id: nextId.current++,
            cwd,
            line: cmd,
            output: aborted ? "(cancelled)" : e instanceof Error ? e.message : String(e),
            ok: false,
            durationMs: Date.now() - started,
          },
        ]);
      } finally {
        runAbortRef.current = null;
        setBusyCmd(null);
      }
    },
    [cwd, estimateCols],
  );

  const stopRunning = () => {
    runAbortRef.current?.abort();
  };

  const cdTo = (target: string) => {
    if (busy) return;
    const cmd = target === "~" ? "cd ~" : `cd ${shellQuote(target)}`;
    void run(cmd, { keepInput: true, silentHistory: true });
  };

  const askAi = () => {
    aiAbortRef.current?.abort();
    const ctl = new AbortController();
    aiAbortRef.current = ctl;
    setIdeaState("thinking");
    setIdeas([]);
    call<{ chips: Chip[]; ok: boolean }>("/api/console/suggest", { cwd, line, history, ai: true }, ctl.signal)
      .then((r) => {
        if (ctl.signal.aborted) return;
        setIdeas(r.chips);
        setIdeaState(r.ok ? "ready" : "off");
      })
      .catch(() => {
        if (!ctl.signal.aborted) setIdeaState("off");
      });
  };

  // Tapping a chip fills the command line without forcing the mobile keyboard open.
  const pick = (c: Chip) => {
    setLine(c.line);
    setHistoryCursor(null);
  };

  const insertToken = (tok: string) => {
    const el = inputRef.current;
    if (el && typeof el.selectionStart === "number" && typeof el.selectionEnd === "number" && document.activeElement === el) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${line.slice(0, start)}${tok}${line.slice(end)}`;
      setLine(next);
      requestAnimationFrame(() => {
        el.setSelectionRange(start + tok.length, start + tok.length);
      });
    } else {
      setLine((prev) => `${prev}${tok}`);
    }
    setHistoryCursor(null);
  };

  const stepHistory = (dir: -1 | 1) => {
    if (history.length === 0) return;
    if (dir === -1) {
      const nextIdx = historyCursor === null ? history.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextIdx);
      setLine(history[nextIdx] ?? "");
    } else {
      if (historyCursor === null) return;
      const nextIdx = historyCursor + 1;
      if (nextIdx >= history.length) {
        setHistoryCursor(null);
        setLine("");
      } else {
        setHistoryCursor(nextIdx);
        setLine(history[nextIdx] ?? "");
      }
    }
  };

  const applyTab = () => {
    const first = chips[0];
    if (first) pick(first);
  };

  const copyEntry = async (entry: Entry) => {
    const ok = await copyText(entry.output || entry.line);
    if (ok) {
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId((cur) => (cur === entry.id ? null : cur)), 1500);
    }
  };

  const segments = pathSegments(cwd);

  const toolBtnStyle = (active = false): React.CSSProperties => ({
    minHeight: 32,
    padding: "4px 9px",
    borderRadius: 4,
    border: `1px solid ${active ? "#00f3ff" : "#0b7f86"}`,
    background: active ? "rgb(0 243 255 / 0.16)" : "rgb(3 12 14 / 0.9)",
    color: active ? "#00f3ff" : "#9ec5ca",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    cursor: "pointer",
    flexShrink: 0,
    touchAction: "manipulation",
  });

  const chipButton = (c: Chip, key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => pick(c)}
      title={c.hint ? `${c.line} — ${c.hint}` : c.line}
      style={{
        flex: "0 0 auto",
        minHeight: 36,
        padding: "4px 11px",
        borderRadius: 16,
        border: `1px solid ${KIND_COLOR[c.kind]}`,
        background: "rgb(3 12 14 / 0.9)",
        color: KIND_COLOR[c.kind],
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        textAlign: "left",
        cursor: "pointer",
        touchAction: "manipulation",
      }}
    >
      <span>{c.label}</span>
      {c.hint && (
        <span style={{ opacity: 0.65, fontSize: 10, display: "block", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.hint}
        </span>
      )}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}>
      {/* Top bar: clickable cwd breadcrumbs + compact terminal controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          padding: "6px 8px",
          background: "#030c0e",
          border: "1px solid #0b7f86",
          borderRadius: 4,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <div
          aria-label="Current directory"
          className="forge-console-chips"
          style={{ flex: "1 1 160px", minWidth: 0, alignItems: "center", gap: 2, padding: 0 }}
        >
          {segments.map((seg, i) => (
            <span key={seg.path} style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
              {i > 1 && <span style={{ color: "#4d787d", fontFamily: "var(--font-mono)", fontSize: 12 }}>/</span>}
              <button
                type="button"
                disabled={busy}
                onClick={() => cdTo(seg.path)}
                style={{
                  border: 0,
                  background: i === segments.length - 1 ? "rgb(0 243 255 / 0.14)" : "transparent",
                  color: i === segments.length - 1 ? "#00f3ff" : "#9ec5ca",
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  padding: "3px 6px",
                  borderRadius: 4,
                  cursor: busy ? "not-allowed" : "pointer",
                  minHeight: 30,
                  touchAction: "manipulation",
                }}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setShowFolders((v) => !v)}
            aria-expanded={showFolders}
            style={toolBtnStyle(showFolders)}
            title="Toggle quick folder navigation"
          >
            Dirs{subdirs.length > 0 ? ` (${subdirs.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => setWrapOutput((v) => !v)}
            style={toolBtnStyle(wrapOutput)}
            title="Toggle line wrapping vs horizontal scroll for wide tables"
          >
            {wrapOutput ? "Wrap" : "Scroll"}
          </button>
          {log.length > 0 && (
            <button type="button" onClick={() => setLog([])} style={toolBtnStyle(false)} title="Clear output log">
              Clear
            </button>
          )}
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              style={toolBtnStyle(fullscreen)}
              title={fullscreen ? "Show app header and tabs" : "Expand console to fill screen"}
            >
              {fullscreen ? "Exit Full" : "Full"}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible 1-tap directory navigator (executes cd immediately without popping keyboard) */}
      {showFolders && (
        <div
          className="forge-console-chips"
          style={{
            flexShrink: 0,
            padding: "4px 6px",
            background: "rgb(3 12 14 / 0.75)",
            border: "1px solid rgb(11 127 134 / 0.5)",
            borderRadius: 4,
          }}
        >
          {cwd !== "/" && (
            <button type="button" disabled={busy} onClick={() => cdTo("..")} style={toolBtnStyle(true)}>
              ↑ ..
            </button>
          )}
          <button type="button" disabled={busy} onClick={() => cdTo("/projects")} style={toolBtnStyle(false)}>
            /projects
          </button>
          <button type="button" disabled={busy} onClick={() => cdTo("/opt/the-forge")} style={toolBtnStyle(false)}>
            /opt/the-forge
          </button>
          <button type="button" disabled={busy} onClick={() => cdTo("~")} style={toolBtnStyle(false)}>
            ~
          </button>
          {subdirs.map((d) => (
            <button key={d} type="button" disabled={busy} onClick={() => cdTo(d)} style={toolBtnStyle(false)}>
              {d}/
            </button>
          ))}
        </div>
      )}

      {/* Main terminal output viewport (fills all available height) */}
      <div
        ref={logBoxRef}
        style={{
          flex: "1 1 0%",
          minHeight: 120,
          overflowY: "auto",
          overflowX: "hidden",
          WebkitOverflowScrolling: "touch",
          background: "#02080a",
          border: "1px solid #0b7f86",
          borderRadius: 4,
          padding: "8px 10px",
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          lineHeight: 1.45,
        }}
      >
        {log.length === 0 && !busy && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" }}>
            <div style={{ color: "#7aa5aa", fontSize: 13 }}>
              Tap a quick command, browse <strong style={{ color: "#00f3ff" }}>Dirs</strong>, or type below.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {QUICK_STARTERS.map((q) => (
                <button
                  key={q.cmd}
                  type="button"
                  onClick={() => void run(q.cmd)}
                  style={{
                    minHeight: 36,
                    padding: "6px 12px",
                    borderRadius: 4,
                    border: "1px solid #0b7f86",
                    background: "rgb(0 243 255 / 0.08)",
                    color: "#00f3ff",
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    cursor: "pointer",
                    touchAction: "manipulation",
                  }}
                >
                  ▶ {q.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {log.map((e) => (
          <div
            key={e.id}
            style={{
              marginBottom: 10,
              paddingBottom: 8,
              borderBottom: "1px solid rgb(11 127 134 / 0.22)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
              <div style={{ flex: "1 1 180px", minWidth: 0, wordBreak: "break-word", color: e.ok ? "#39ff14" : "#ff3366" }}>
                <span style={{ opacity: 0.65, fontSize: 11 }}>{e.cwd}</span>
                <span> $ </span>
                <strong style={{ color: "#d6fbff" }}>{e.line}</strong>
                {typeof e.exitCode === "number" && e.exitCode !== 0 && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: "#ff3366" }}>[exit {e.exitCode}]</span>
                )}
                {e.durationMs !== undefined && e.durationMs >= 1000 && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: "#7aa5aa" }}>{(e.durationMs / 1000).toFixed(1)}s</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => {
                    setLine(e.line);
                    inputRef.current?.focus();
                  }}
                  aria-label={`Edit ${e.line}`}
                  title="Put command in input"
                  style={{
                    border: "1px solid rgb(11 127 134 / 0.5)",
                    background: "transparent",
                    color: "#7aa5aa",
                    borderRadius: 4,
                    minWidth: 28,
                    minHeight: 26,
                    fontSize: 12,
                    cursor: "pointer",
                    padding: "0 6px",
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(e.line)}
                  aria-label={`Re-run ${e.line}`}
                  title="Re-run command"
                  style={{
                    border: "1px solid rgb(11 127 134 / 0.5)",
                    background: "transparent",
                    color: "#00f3ff",
                    borderRadius: 4,
                    minWidth: 28,
                    minHeight: 26,
                    fontSize: 12,
                    cursor: busy ? "not-allowed" : "pointer",
                    padding: "0 6px",
                  }}
                >
                  ↻
                </button>
                <button
                  type="button"
                  onClick={() => void copyEntry(e)}
                  aria-label="Copy output"
                  title="Copy output"
                  style={{
                    border: "1px solid rgb(11 127 134 / 0.5)",
                    background: "transparent",
                    color: copiedId === e.id ? "#39ff14" : "#7aa5aa",
                    borderRadius: 4,
                    minWidth: 28,
                    minHeight: 26,
                    fontSize: 11,
                    cursor: "pointer",
                    padding: "0 6px",
                  }}
                >
                  {copiedId === e.id ? "✓" : "Copy"}
                </button>
              </div>
            </div>

            {e.output ? (
              <div style={{ overflowX: wrapOutput ? "hidden" : "auto", WebkitOverflowScrolling: "touch", maxWidth: "100%" }}>
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: wrapOutput ? "pre-wrap" : "pre",
                    wordBreak: wrapOutput ? "break-word" : "normal",
                    color: e.ok ? "#d6fbff" : "#ff8da6",
                    fontSize: 12.5,
                    lineHeight: 1.45,
                  }}
                >
                  {e.output}
                </pre>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "#5e858a" }}>(no output)</div>
            )}
            {e.truncated && <div style={{ fontSize: 11, color: "#ff9900", marginTop: 4 }}>(output truncated at 60 KB)</div>}
          </div>
        ))}

        {busy && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#00f3ff", padding: "4px 0" }}>
            <span>$ {busyCmd} — running…</span>
          </div>
        )}
      </div>

      {/* On-demand Ollama AI ideas drawer (only visible when requested) */}
      {ideaState !== "idle" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexShrink: 0,
            padding: "4px 6px",
            background: "rgb(199 146 255 / 0.08)",
            border: "1px solid rgb(199 146 255 / 0.4)",
            borderRadius: 4,
          }}
        >
          <div className="forge-console-chips" style={{ flex: 1, minWidth: 0, alignItems: "center" }}>
            {ideaState === "thinking" && <span style={{ color: "#c792ff", fontSize: 12 }}>Ollama is thinking…</span>}
            {ideaState === "off" && <span style={{ color: "#9ec5ca", fontSize: 12 }}>Ollama unavailable</span>}
            {ideaState === "ready" && ideas.length === 0 && <span style={{ color: "#9ec5ca", fontSize: 12 }}>No AI suggestions</span>}
            {ideas.map((c, i) => chipButton(c, `i${i}`))}
          </div>
          <button
            type="button"
            onClick={() => {
              aiAbortRef.current?.abort();
              setIdeas([]);
              setIdeaState("idle");
            }}
            aria-label="Close AI suggestions"
            style={{ ...toolBtnStyle(false), minWidth: 32, padding: "4px 6px" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Instant local suggestions strip */}
      {chips.length > 0 && (
        <div className="forge-console-chips" style={{ flexShrink: 0 }}>
          {chips.map((c, i) => chipButton(c, `c${i}`))}
        </div>
      )}

      {/* Mobile quick-key strip: Tab, history arrows, AI ideas, hard-to-type shell punctuation */}
      <div className="forge-console-chips" style={{ flexShrink: 0, alignItems: "center" }}>
        <button
          type="button"
          onClick={applyTab}
          disabled={chips.length === 0}
          style={{ ...toolBtnStyle(false), opacity: chips.length === 0 ? 0.45 : 1 }}
          title="Apply top suggestion"
        >
          Tab
        </button>
        <button
          type="button"
          onClick={() => stepHistory(-1)}
          disabled={history.length === 0}
          style={{ ...toolBtnStyle(false), opacity: history.length === 0 ? 0.45 : 1 }}
          aria-label="Previous command"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => stepHistory(1)}
          disabled={historyCursor === null}
          style={{ ...toolBtnStyle(false), opacity: historyCursor === null ? 0.45 : 1 }}
          aria-label="Next command"
        >
          ↓
        </button>
        <button
          type="button"
          onClick={askAi}
          style={{
            ...toolBtnStyle(ideaState === "thinking" || ideaState === "ready"),
            borderColor: "#c792ff",
            color: "#c792ff",
          }}
          title="Ask local Ollama for command suggestions"
        >
          {ideaState === "thinking" ? "AI…" : "AI"}
        </button>
        {QUICK_KEYS.map((k) => (
          <button key={k} type="button" onClick={() => insertToken(k)} style={{ ...toolBtnStyle(false), minWidth: 34, textAlign: "center" }}>
            {k}
          </button>
        ))}
      </div>

      {/* Pinned command input bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(line);
        }}
        style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "stretch" }}
      >
        <input
          ref={inputRef}
          value={line}
          onChange={(e) => {
            setLine(e.target.value);
            setHistoryCursor(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              stepHistory(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              stepHistory(1);
            } else if (e.key === "Tab" && chips.length > 0) {
              e.preventDefault();
              applyTab();
            }
          }}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          placeholder="command…"
          // 16px stops iOS Safari from auto-zooming on focus.
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 44,
            fontSize: 16,
            fontFamily: "var(--font-mono)",
            padding: "0 12px",
            borderRadius: 6,
            border: "1px solid #0b7f86",
            background: "#02080a",
            color: "#d6fbff",
          }}
        />
        {line && !busy && (
          <button
            type="button"
            onClick={() => {
              setLine("");
              setHistoryCursor(null);
            }}
            style={{
              minHeight: 44,
              minWidth: 40,
              borderRadius: 6,
              border: "1px solid #0b7f86",
              background: "#030c0e",
              color: "#7aa5aa",
              fontSize: 16,
              cursor: "pointer",
              touchAction: "manipulation",
            }}
            aria-label="Clear input"
          >
            ✕
          </button>
        )}
        {busy ? (
          <button
            type="button"
            onClick={stopRunning}
            style={{
              minHeight: 44,
              padding: "0 16px",
              borderRadius: 6,
              border: "1px solid #ff3366",
              background: "rgb(255 51 102 / 0.2)",
              color: "#ff3366",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: "pointer",
              touchAction: "manipulation",
            }}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!line.trim()}
            style={{
              minHeight: 44,
              padding: "0 18px",
              borderRadius: 6,
              border: 0,
              background: line.trim() ? "#00f3ff" : "#1d3a3e",
              color: line.trim() ? "#030a0c" : "#6b8b90",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: line.trim() ? "pointer" : "not-allowed",
              touchAction: "manipulation",
            }}
          >
            Run
          </button>
        )}
      </form>
    </div>
  );
}
