import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../schema.js";
import { run } from "../ops.js";
import { pickProvider, type TaskComplexity } from "../usage/router.js";
import type { ProviderName, UsageSnapshot } from "../usage/schema.js";
import { createTaskWorktree, mergeTaskWorktree } from "../git/worktree.js";
import { loadProjectConfig, runDeterministicGate, runQwenStandardsReview } from "../gate/standards.js";

export interface TaskSpec {
  id: string;
  repoDir: string;
  prompt: string;
  complexity: TaskComplexity;
  standardsPath?: string;
}

export interface TaskOutcome {
  ok: boolean;
  attempts: { provider: ProviderName; gateOk: boolean; reviewOk: boolean; note: string }[];
  merged: boolean;
}

/** Dispatches a single provider run inside the task worktree. */
export function invokeProvider(provider: ProviderName, worktreeDir: string, prompt: string, ollamaModel: string): { code: number; out: string } {
  const escaped = prompt.replace(/'/g, "'\\''");
  if (provider === "ollama") {
    // OpenCode pointed at local Ollama; falls back to `ollama run` hint if opencode isn't configured
    return run("bash", ["-lc", `cd '${worktreeDir}' && opencode run --model ollama/${ollamaModel} '${escaped}'`]);
  }
  if (provider === "antigravity") {
    return run("bash", ["-lc", `cd '${worktreeDir}' && agy -p --dangerously-skip-permissions '${escaped}'`]);
  }
  return run("bash", ["-lc", `cd '${worktreeDir}' && claude -p --dangerously-skip-permissions '${escaped}'`]);
}

/**
 * Executes a task in its own git worktree, gates it (build/typecheck/test + qwen standards review),
 * escalates across providers on failure, and squash-merges into `ai-work` on pass.
 */
export async function executeTask(manifest: Manifest, snapshot: UsageSnapshot, spec: TaskSpec): Promise<TaskOutcome> {
  const wt = createTaskWorktree(spec.repoDir, spec.id, manifest.git.integrationBranch, manifest.git.taskBranchPrefix);
  if (!wt.ok) return { ok: false, attempts: [], merged: false };

  const projectCfg = loadProjectConfig(wt.worktreePath);
  const standardsMd = spec.standardsPath && existsSync(spec.standardsPath)
    ? readFileSync(spec.standardsPath, "utf8")
    : "- No secrets or credentials in code\n- Stay within the requested task scope\n- No unused imports or dead code";

  const excluded: ProviderName[] = [];
  const attempts: TaskOutcome["attempts"] = [];

  for (let i = 0; i < 3; i++) {
    const decision = pickProvider(manifest, snapshot, { complexity: spec.complexity, exclude: excluded });
    if (!decision.provider) break;

    const inv = invokeProvider(decision.provider, wt.worktreePath, spec.prompt, manifest.ollama.primaryModel);
    const gate = runDeterministicGate(wt.worktreePath, projectCfg);
    if (inv.code !== 0 || !gate.ok) {
      const failStep = gate.steps.find((s) => !s.ok);
      attempts.push({ provider: decision.provider, gateOk: false, reviewOk: false, note: failStep ? `${failStep.step} failed` : "worker exited non-zero" });
      excluded.push(decision.provider);
      continue;
    }

    const diff = run("git", ["-C", wt.worktreePath, "diff", "HEAD"]).out;
    const review = await runQwenStandardsReview(diff, standardsMd, manifest.ollama.primaryModel);
    if (!review.pass) {
      attempts.push({ provider: decision.provider, gateOk: true, reviewOk: false, note: review.escalate ? "escalated from qwen review" : "failed standards" });
      excluded.push(decision.provider);
      continue;
    }

    attempts.push({ provider: decision.provider, gateOk: true, reviewOk: true, note: "passed" });
    run("git", ["-C", wt.worktreePath, "add", "-A"]);
    run("git", ["-C", wt.worktreePath, "commit", "-m", `task(${spec.id}): ${spec.prompt.slice(0, 60)}`]);
    const merged = mergeTaskWorktree(spec.repoDir, spec.id, manifest.git.integrationBranch, manifest.git.taskBranchPrefix);
    return { ok: merged.ok, attempts, merged: merged.ok };
  }

  return { ok: false, attempts, merged: false };
}
