import type { SessionDetail, Step } from "./parse.js";

export interface StepFlag {
  stepId: string;
  /** Position in the session (1-based) so the UI can say "step 12". */
  index: number;
  kind: "cache-spike" | "long-output" | "mcp-heavy" | "top-cost";
  message: string;
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** Pure, deterministic findings: no model involved. Thresholds are relative to the session so they scale. */
export function deterministicFlags(d: SessionDetail): StepFlag[] {
  const flags: StepFlag[] = [];
  const steps = d.steps;
  if (!steps.length) return flags;
  const sortedFresh = [...steps].map((s) => s.fresh).sort((a, b) => a - b);
  const median = sortedFresh[Math.floor(sortedFresh.length / 2)] || 1;
  const top = new Set([...steps].sort((a, b) => b.fresh - a.fresh).slice(0, 3).map((s) => s.id));

  steps.forEach((s, i) => {
    const index = i + 1;
    if (s.cacheCreate >= 20_000 && s.cacheCreate >= 3 * median)
      flags.push({ stepId: s.id, index, kind: "cache-spike", message: `${fmt(s.cacheCreate)} tokens written to cache (large new context, usually a big tool result or file read)` });
    if (s.output >= 8_000) flags.push({ stepId: s.id, index, kind: "long-output", message: `${fmt(s.output)} output tokens in one response` });
    const mcpCalls = s.tools.filter((t) => t.server);
    if (mcpCalls.length && s.fresh >= 2 * median)
      flags.push({ stepId: s.id, index, kind: "mcp-heavy", message: `called ${[...new Set(mcpCalls.map((t) => t.name))].join(", ")} with ${fmt(s.fresh)} fresh tokens` });
    if (top.has(s.id)) flags.push({ stepId: s.id, index, kind: "top-cost", message: `one of the 3 costliest steps (${fmt(s.fresh)} fresh tokens)` });
  });
  return flags;
}

export interface StepNote {
  stepId: string;
  note: string;
}

export interface OllamaAnalysis {
  ok: boolean;
  model: string;
  notes: StepNote[];
  detail?: string;
}

interface Fetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

function metadata(s: Step, i: number, prev?: Step) {
  // Only counts and tool names: no prompts, file contents or tool inputs ever reach the model.
  return {
    step: i + 1,
    id: s.id,
    freshTokens: s.fresh,
    outputTokens: s.output,
    cacheWriteTokens: s.cacheCreate,
    cacheReadTokens: s.cacheRead,
    tools: s.tools.map((t) => t.name),
    previousStepTools: prev?.tools.map((t) => t.name) ?? [],
  };
}

/** Asks local Ollama to explain, in one sentence each, why the costliest steps were expensive. */
export async function annotateWithOllama(
  d: SessionDetail,
  opts: { model: string; baseUrl?: string; top?: number; fetchImpl?: Fetcher; timeoutMs?: number },
): Promise<OllamaAnalysis> {
  const top = opts.top ?? 8;
  const picked = d.steps
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.fresh - a.s.fresh)
    .slice(0, top)
    .sort((a, b) => a.i - b.i);
  if (!picked.length) return { ok: true, model: opts.model, notes: [] };

  const prompt = [
    "You review token usage of an AI coding session. For each step below, write ONE short sentence explaining the most likely reason it used many tokens,",
    "using only the numbers and tool names given (for example: a big cache write after a file-reading tool, a long generated answer, an MCP call returning a large payload).",
    "If the data does not support a reason, say 'unclear'. Reply with JSON only: {\"notes\":[{\"id\":\"<step id>\",\"note\":\"<sentence>\"}]}.",
    "",
    JSON.stringify(picked.map(({ s, i }) => metadata(s, i, d.steps[i - 1]))),
  ].join("\n");

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetcher);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetchImpl(`${opts.baseUrl ?? "http://127.0.0.1:11434"}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, prompt, stream: false, format: "json", options: { temperature: 0 } }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, model: opts.model, notes: [], detail: `Ollama returned HTTP ${res.status}` };
    const body = (await res.json()) as { response?: string };
    const parsed = JSON.parse(body.response ?? "{}") as { notes?: { id?: unknown; note?: unknown }[] };
    const valid = new Set(picked.map((p) => p.s.id));
    const notes = (parsed.notes ?? [])
      .filter((n): n is { id: string; note: string } => typeof n.id === "string" && typeof n.note === "string" && valid.has(n.id))
      .map((n) => ({ stepId: n.id, note: n.note.slice(0, 300) }));
    return { ok: true, model: opts.model, notes };
  } catch (e) {
    return { ok: false, model: opts.model, notes: [], detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
