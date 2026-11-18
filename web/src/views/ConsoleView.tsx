import { useCallback, useEffect, useRef, useState } from "react";

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
}

const HEADERS = { "content-type": "application/json", "x-forge-console": "1" };
const KIND_COLOR: Record<Chip["kind"], string> = {
  dir: "#5ec8ff",
  path: "#c9d1d9",
  flag: "#e3b341",
  idea: "#b48cff",
  start: "#7ee787",
  history: "#8b949e",
};

async function call<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** Phone-first shell: tap suggestions instead of typing. Directories and flags are instant; Ollama adds ideas a moment later. */
export function ConsoleView() {
  const [cwd, setCwd] = useState("/projects");
  const [line, setLine] = useState("");
  const [log, setLog] = useState<Entry[]>([]);
  const [chips, setChips] = useState<Chip[]>([]);
  const [ideas, setIdeas] = useState<Chip[]>([]);
  const [ideaState, setIdeaState] = useState<"idle" | "thinking" | "off">("idle");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Instant suggestions on every keystroke; the model is only asked after a short pause so it never blocks typing.
  useEffect(() => {
    const ctl = new AbortController();
    setIdeas([]);
    const fast = setTimeout(() => {
      call<{ chips: Chip[]; normalized: string }>("/api/console/suggest", { cwd, line, history }, ctl.signal)
        .then((r) => {
          setChips(r.chips);
          if (r.normalized !== line) setLine(r.normalized);
        })
        .catch(() => undefined);
    }, 80);
    setIdeaState("thinking");
    const slow = setTimeout(() => {
      call<{ chips: Chip[]; ok: boolean }>("/api/console/suggest", { cwd, line, history, ai: true }, ctl.signal)
        .then((r) => {
          setIdeas(r.chips);
          setIdeaState(r.ok ? "idle" : "off");
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      ctl.abort();
      clearTimeout(fast);
      clearTimeout(slow);
    };
    // history only matters when the line is empty; avoid re-querying after every run twice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, line, history.length]);

  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [log]);

  const run = useCallback(
    async (text: string) => {
      const cmd = text.trim();
      if (!cmd || busy) return;
      setBusy(true);
      try {
        const r = await call<{ ok: boolean; output: string; cwd: string }>("/api/console/run", { cwd, line: cmd });
        setLog((l) => [...l.slice(-49), { id: nextId.current++, cwd, line: cmd, output: r.output, ok: r.ok }]);
        setCwd(r.cwd);
        setHistory((h) => [...h.filter((x) => x !== cmd), cmd].slice(-30));
      } catch (e) {
        setLog((l) => [...l, { id: nextId.current++, cwd, line: cmd, output: e instanceof Error ? e.message : String(e), ok: false }]);
      } finally {
        setBusy(false);
        setLine("");
        inputRef.current?.focus();
      }
    },
    [busy, cwd],
  );

  // Tapping a folder or a flag fills the line; tapping an idea does too (you still press Run, so nothing surprising executes).
  const pick = (c: Chip) => {
    setLine(c.line);
    inputRef.current?.focus();
  };

  const chipButton = (c: Chip, key: string) => (
    <button
      key={key}
      type="button"
      onClick={() => pick(c)}
      title={c.hint}
      style={{
        flex: "0 0 auto",
        minHeight: 40,
        padding: "6px 12px",
        borderRadius: 20,
        border: `1px solid ${KIND_COLOR[c.kind]}`,
        background: "transparent",
        color: KIND_COLOR[c.kind],
        fontFamily: "monospace",
        fontSize: 14,
        textAlign: "left",
      }}
    >
      {c.label}
      {c.hint && <span style={{ opacity: 0.6, fontSize: 11, display: "block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.hint}</span>}
    </button>
  );

  const row = { display: "flex", gap: 8, overflowX: "auto" as const, padding: "4px 0", WebkitOverflowScrolling: "touch" as const };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 900 }}>
      <div style={{ fontFamily: "monospace", fontSize: 13, opacity: 0.7, wordBreak: "break-all" }}>{cwd}</div>

      <div style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 8, padding: 10, minHeight: 160, maxHeight: "40vh", overflowY: "auto", fontFamily: "monospace", fontSize: 13 }}>
        {log.length === 0 && <div style={{ opacity: 0.5 }}>Tap a suggestion below, or type. Try “cd” or “git”.</div>}
        {log.map((e) => (
          <div key={e.id} style={{ marginBottom: 10 }}>
            <div style={{ color: "#7ee787", wordBreak: "break-all" }}>
              {e.cwd} $ {e.line}
            </div>
            {e.output && <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: e.ok ? "#c9d1d9" : "#ff7b72" }}>{e.output}</pre>}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {chips.length > 0 && <div style={row}>{chips.map((c, i) => chipButton(c, `c${i}`))}</div>}
      <div style={{ ...row, minHeight: 44, alignItems: "center" }}>
        {ideas.map((c, i) => chipButton(c, `i${i}`))}
        {ideaState === "thinking" && <span style={{ opacity: 0.5, fontSize: 12 }}>Ollama is thinking…</span>}
        {ideaState === "off" && <span style={{ opacity: 0.5, fontSize: 12 }}>Ollama unavailable — showing local suggestions only</span>}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(line);
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          ref={inputRef}
          value={line}
          onChange={(e) => setLine(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder="command…"
          // 16px stops iOS from zooming the page when the field is focused.
          style={{ flex: 1, minWidth: 0, minHeight: 44, fontSize: 16, fontFamily: "monospace", padding: "0 12px", borderRadius: 8, border: "1px solid #30363d", background: "#0d1117", color: "#c9d1d9" }}
        />
        <button type="button" onClick={() => setLine("")} style={{ minHeight: 44, minWidth: 44, borderRadius: 8, border: "1px solid #30363d", background: "transparent", color: "#8b949e" }} aria-label="Clear">
          ✕
        </button>
        <button type="submit" disabled={busy || !line.trim()} style={{ minHeight: 44, padding: "0 18px", borderRadius: 8, border: 0, background: "#238636", color: "#fff", fontWeight: 600 }}>
          {busy ? "…" : "Run"}
        </button>
      </form>
    </div>
  );
}
