import type { Manifest } from "../schema.js";

export interface ModelRecommendation {
  current: string;
  candidates: { tag: string; note: string }[];
}

/**
 * Checks Ollama's public library for newer `qwen*-coder` models and 14B quantized options
 * that fit a 10 GB VRAM GPU (RTX 3080). Non-fatal if offline.
 */
export async function checkCoderModelUpdates(manifest: Manifest): Promise<ModelRecommendation> {
  const current = manifest.ollama.primaryModel;
  const candidates: { tag: string; note: string }[] = [];
  try {
    const res = await fetch("https://ollama.com/library?q=qwen+coder", { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const html = await res.text();
      const matches = new Set(html.match(/qwen[\d.]*-coder/gi) ?? []);
      for (const m of matches) {
        const name = m.toLowerCase();
        if (!current.startsWith(name)) {
          candidates.push({ tag: `${name}:latest`, note: "newer qwen-coder family found in Ollama library" });
        }
      }
    }
  } catch {
    // Offline or blocked; fall back to static 10GB-VRAM guidance
  }
  if (current === "qwen2.5-coder:7b") {
    candidates.push({
      tag: "qwen2.5-coder:14b-instruct-q4_K_M",
      note: "14B Q4 (~9.0 GB) fits RTX 3080 10 GB VRAM and improves tool-calling / agent loops",
    });
  }
  return { current, candidates };
}
