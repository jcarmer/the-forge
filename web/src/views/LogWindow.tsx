import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const LINE_H = 18;
const OVERSCAN = 20;
const POLL_MS = 1000;
const INITIAL_TAIL = 2000;
const MAX_BUFFER = 50_000;

interface LogSlice {
  total: number;
  start: number;
  lines: string[];
  missing: boolean;
}

async function fetchLines(name: string, query: string): Promise<LogSlice> {
  const res = await fetch(`/api/logs/${encodeURIComponent(name)}/lines?${query}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LogSlice;
}

/**
 * Standalone log viewer (opened in its own window). Polls for new lines, follows the end of the log, and once the user scrolls away it pins the
 * top visible *line* so appended text never moves what they are reading. Scrolling moves in whole lines.
 */
export function LogWindow({ name }: { name: string }) {
  const [start, setStart] = useState(0); // absolute index of lines[0]
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [following, setFollowing] = useState(true);

  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const anchorRef = useRef<number | null>(null); // absolute index of the top visible line while not following
  const totalRef = useRef(0);
  const startRef = useRef(0);
  const bufRef = useRef<string[]>([]); // authoritative lines, shared by the poller and loadEarlier
  const loadingEarlier = useRef(false);

  useEffect(() => {
    document.title = `Logs: ${name}`;
  }, [name]);

  const maxScroll = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);

  /** Called after the DOM reflects the latest lines: stick to the end, or restore the pinned top line. */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (followRef.current) el.scrollTop = maxScroll(el);
    else if (anchorRef.current !== null) el.scrollTop = Math.min(maxScroll(el), Math.max(0, (anchorRef.current - start) * LINE_H));
    setViewport({ top: el.scrollTop, height: el.clientHeight });
  }, [lines, start]);

  const apply = useCallback((nextStart: number, nextLines: string[], total: number) => {
    totalRef.current = total;
    startRef.current = nextStart;
    bufRef.current = nextLines;
    setStart(nextStart);
    setLines(nextLines);
  }, []);

  // Poll: first load the tail, then only what was appended.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;

    const tick = async () => {
      try {
        const query = first ? `tail=${INITIAL_TAIL}` : `from=${startRef.current + bufRef.current.length}`;
        const slice = await fetchLines(name, query);
        if (cancelled) return;
        setError(null);
        setMissing(slice.missing);
        if (first || slice.total < startRef.current + bufRef.current.length) {
          // First load, or the file was truncated/rotated: start over from the end.
          if (!first) {
            followRef.current = true;
            setFollowing(true);
            anchorRef.current = null;
          }
          const tailSlice = first ? slice : await fetchLines(name, `tail=${INITIAL_TAIL}`);
          first = false;
          apply(tailSlice.start, tailSlice.lines, tailSlice.total);
        } else if (slice.lines.length > 0) {
          let buffer = bufRef.current.concat(slice.lines);
          let bufStart = startRef.current;
          // Only trim the front while following; otherwise the pinned line could vanish.
          if (followRef.current && buffer.length > MAX_BUFFER) {
            const drop = buffer.length - MAX_BUFFER;
            buffer = buffer.slice(drop);
            bufStart += drop;
          }
          apply(bufStart, buffer, slice.total);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, apply]);

  /** Prepend older lines when the user reaches the top of what is loaded. */
  const loadEarlier = useCallback(async () => {
    if (loadingEarlier.current || startRef.current === 0) return;
    loadingEarlier.current = true;
    try {
      const from = Math.max(0, startRef.current - INITIAL_TAIL);
      const slice = await fetchLines(name, `from=${from}&to=${startRef.current}`);
      if (slice.lines.length === 0) return;
      apply(slice.start, slice.lines.concat(bufRef.current), totalRef.current);
    } catch {
      /* the next scroll to the top retries */
    } finally {
      loadingEarlier.current = false;
    }
  }, [name, apply]);

  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const max = maxScroll(el);
    // Snap to a whole line (the very bottom may sit between lines when the viewport is not a multiple of the line height).
    const snapped = Math.min(max, Math.round(el.scrollTop / LINE_H) * LINE_H);
    if (Math.abs(snapped - el.scrollTop) > 0.5) el.scrollTop = snapped;
    const atBottom = max - snapped < 1;
    followRef.current = atBottom;
    setFollowing(atBottom);
    anchorRef.current = atBottom ? null : startRef.current + Math.round(snapped / LINE_H);
    setViewport({ top: snapped, height: el.clientHeight });
    if (snapped < LINE_H * OVERSCAN) void loadEarlier();
  }, [loadEarlier]);

  /** Wheel scrolls by whole lines, accumulating small trackpad deltas. */
  const wheelRemainder = useRef(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? Math.max(1, Math.floor(el.clientHeight / LINE_H) - 1) : 1 / LINE_H;
      wheelRemainder.current += e.deltaY * unit;
      const whole = Math.trunc(wheelRemainder.current);
      if (whole === 0) return;
      wheelRemainder.current -= whole;
      el.scrollTop = Math.min(maxScroll(el), Math.max(0, el.scrollTop + whole * LINE_H));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onScroll());
    ro.observe(el);
    return () => ro.disconnect();
  }, [onScroll]);

  const first = Math.max(0, Math.floor(viewport.top / LINE_H) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((viewport.top + viewport.height) / LINE_H) + OVERSCAN);
  const shown = lines.slice(first, last);

  const jumpToEnd = () => {
    const el = boxRef.current;
    if (el) el.scrollTop = maxScroll(el);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#0b0d12", color: "#d6dbe4" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 12px", borderBottom: "1px solid #232834", fontSize: 12 }}>
        <strong>{name}</strong>
        <span style={{ opacity: 0.7 }}>
          lines {start + 1}–{start + lines.length}
        </span>
        <span style={{ color: following ? "#4ade80" : "#fbbf24" }}>{following ? "following" : "paused (scrolled up)"}</span>
        {missing && <span style={{ color: "#fbbf24" }}>no log file yet</span>}
        {error && <span style={{ color: "#f87171" }}>{error}</span>}
        {!following && (
          <button onClick={jumpToEnd} style={{ marginLeft: "auto" }}>
            Jump to end
          </button>
        )}
      </div>
      <div ref={boxRef} onScroll={onScroll} style={{ flex: 1, overflowY: "auto", overflowX: "auto", position: "relative" }}>
        <div style={{ height: lines.length * LINE_H, position: "relative", minWidth: "max-content" }}>
          <pre
            style={{
              position: "absolute",
              top: first * LINE_H,
              left: 0,
              margin: 0,
              padding: "0 12px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: `${LINE_H}px`,
            }}
          >
            {shown.map((l, i) => (
              <div key={start + first + i} style={{ height: LINE_H, whiteSpace: "pre" }}>
                {l}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
