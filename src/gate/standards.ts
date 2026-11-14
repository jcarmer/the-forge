import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../ops.js";

export interface ProjectGateConfig {
  build?: string;
  typecheck?: string;
  test?: string;
  preview?: string;
}

/** Reads `.agents/project.yml` (simple `key: value` lines) or infers from `package.json`. */
export function loadProjectConfig(repoDir: string): ProjectGateConfig {
  const yml = join(repoDir, ".agents", "project.yml");
  const cfg: ProjectGateConfig = {};
  if (existsSync(yml)) {
    for (const line of readFileSync(yml, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(build|typecheck|test|preview)\s*:\s*(.+?)\s*$/);
      if (m) cfg[m[1] as keyof ProjectGateConfig] = m[2].replace(/^["']|["']$/g, "");
    }
    return cfg;
  }
  const pkgPath = join(repoDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const s = pkg.scripts ?? {};
      if (s.typecheck) cfg.typecheck = "npm run typecheck";
      if (s.build) cfg.build = "npm run build";
      if (s.test) cfg.test = "npm test";
      if (s.dev) cfg.preview = "npm run dev -- --host 0.0.0.0";
    } catch {
      // ignore invalid package.json
    }
  }
  return cfg;
}

export interface GateStepResult {
  step: string;
  ok: boolean;
  output: string;
}

/** Runs deterministic checks (build, typecheck, test) in the task worktree. */
export function runDeterministicGate(worktreeDir: string, cfg: ProjectGateConfig): { ok: boolean; steps: GateStepResult[] } {
  const steps: GateStepResult[] = [];
  for (const key of ["typecheck", "build", "test"] as const) {
    const cmd = cfg[key];
    if (!cmd) continue;
    const shell = process.platform === "win32" ? "powershell" : "bash";
    const flag = process.platform === "win32" ? "-Command" : "-lc";
    const r = run(shell, [flag, cmd], { cwd: worktreeDir });
    steps.push({ step: key, ok: r.code === 0, output: r.out.slice(-2000) });
    if (r.code !== 0) return { ok: false, steps };
  }
  return { ok: true, steps };
}

export const ReviewFindingSchema = z.object({
  rule: z.string(),
  pass: z.boolean(),
  uncertain: z.boolean().default(false),
  note: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  pass: z.boolean(),
  escalate: z.boolean().default(false),
  findings: z.array(ReviewFindingSchema),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * Tier-2 local standards review: asks qwen-coder to check a git diff against yes/no rules in `standards.md`.
 * Escalates to cloud review only if qwen marks any finding uncertain or fails to produce valid JSON.
 */
export async function runQwenStandardsReview(
  diff: string,
  standardsMd: string,
  model = "qwen2.5-coder:7b",
  ollamaUrl = "http://127.0.0.1:11434/api/generate",
): Promise<ReviewResult> {
  if (!diff.trim()) return { pass: true, escalate: false, findings: [] };
  const prompt = `Check this git diff against each rule in the standards below.
Return ONLY JSON: {"pass":boolean,"escalate":boolean,"findings":[{"rule":string,"pass":boolean,"uncertain":boolean,"note":string}]}.
Set "escalate": true ONLY if you are unsure about a rule.

STANDARDS:
${standardsMd.slice(0, 4000)}

DIFF:
${diff.slice(0, 12000)}`;

  try {
    const res = await fetch(ollamaUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { pass: false, escalate: true, findings: [{ rule: "ollama", pass: false, uncertain: true, note: `HTTP ${res.status}` }] };
    const data = (await res.json()) as { response?: string };
    const parsed = ReviewResultSchema.safeParse(JSON.parse(data.response ?? ""));
    if (!parsed.success) return { pass: false, escalate: true, findings: [{ rule: "schema", pass: false, uncertain: true, note: "invalid JSON from qwen" }] };
    const escalate = parsed.data.escalate || parsed.data.findings.some((f) => f.uncertain);
    return { ...parsed.data, escalate };
  } catch (e) {
    return { pass: false, escalate: true, findings: [{ rule: "ollama", pass: false, uncertain: true, note: String(e) }] };
  }
}
