import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "../ops.js";

export interface SyncResult {
  ok: boolean;
  conflict: boolean;
  detail: string;
}

function git(repoDir: string, ...args: string[]) {
  return run("git", ["-C", repoDir, ...args]);
}

/** Ensures the integration branch (e.g. `ai-work`) exists locally and on origin. */
export function ensureIntegrationBranch(repoDir: string, mainBranch: string, integrationBranch: string): SyncResult {
  git(repoDir, "fetch", "origin");
  const hasRemote = git(repoDir, "ls-remote", "--heads", "origin", integrationBranch).out.trim().length > 0;
  if (hasRemote) {
    const co = git(repoDir, "checkout", "-B", integrationBranch, `origin/${integrationBranch}`);
    return { ok: co.code === 0, conflict: false, detail: co.out.trim() || `checked out ${integrationBranch}` };
  }
  const create = git(repoDir, "checkout", "-B", integrationBranch, `origin/${mainBranch}`);
  if (create.code !== 0) return { ok: false, conflict: false, detail: create.out.trim() };
  const push = git(repoDir, "push", "-u", "origin", integrationBranch);
  return { ok: push.code === 0, conflict: false, detail: push.out.trim() || `created and pushed ${integrationBranch}` };
}

/**
 * Merges `origin/<mainBranch>` into `<integrationBranch>` without rewriting history.
 * If there is a merge conflict, aborts the merge and returns `conflict: true` so an agent task can resolve it.
 */
export function syncMainToIntegration(repoDir: string, mainBranch: string, integrationBranch: string): SyncResult {
  const prep = ensureIntegrationBranch(repoDir, mainBranch, integrationBranch);
  if (!prep.ok) return prep;

  const merge = git(repoDir, "merge", "--no-edit", `origin/${mainBranch}`);
  if (merge.code !== 0) {
    const isConflict = /CONFLICT|Automatic merge failed/i.test(merge.out);
    if (isConflict) git(repoDir, "merge", "--abort");
    return { ok: false, conflict: isConflict, detail: merge.out.trim() };
  }
  const push = git(repoDir, "push", "origin", integrationBranch);
  return { ok: push.code === 0, conflict: false, detail: push.out.trim() || "synced and pushed" };
}

/** Creates an isolated git worktree for `task/<taskId>` branched from `origin/<integrationBranch>`. */
export function createTaskWorktree(
  repoDir: string,
  taskId: string,
  integrationBranch: string,
  prefix = "task/",
): { ok: boolean; worktreePath: string; branch: string; detail: string } {
  const branch = `${prefix}${taskId}`;
  const wtRoot = join(repoDir, ".worktrees");
  mkdirSync(wtRoot, { recursive: true });
  const worktreePath = join(wtRoot, taskId);

  if (existsSync(worktreePath)) {
    return { ok: true, worktreePath, branch, detail: "worktree already exists" };
  }
  git(repoDir, "fetch", "origin");
  const base = git(repoDir, "rev-parse", "--verify", `origin/${integrationBranch}`).code === 0
    ? `origin/${integrationBranch}`
    : integrationBranch;
  const res = git(repoDir, "worktree", "add", "-b", branch, worktreePath, base);
  return { ok: res.code === 0, worktreePath, branch, detail: res.out.trim() };
}

/** Squash-merges a finished task branch into `integrationBranch`, pushes, and cleans up the worktree. */
export function mergeTaskWorktree(
  repoDir: string,
  taskId: string,
  integrationBranch: string,
  prefix = "task/",
): SyncResult {
  const branch = `${prefix}${taskId}`;
  const worktreePath = join(repoDir, ".worktrees", taskId);

  const co = git(repoDir, "checkout", integrationBranch);
  if (co.code !== 0) return { ok: false, conflict: false, detail: co.out.trim() };
  git(repoDir, "pull", "--ff-only", "origin", integrationBranch);

  const merge = git(repoDir, "merge", "--squash", branch);
  if (merge.code !== 0) {
    const conflict = /CONFLICT/i.test(merge.out);
    if (conflict) git(repoDir, "reset", "--hard", "HEAD");
    return { ok: false, conflict, detail: merge.out.trim() };
  }
  const commit = git(repoDir, "commit", "-m", `feat(${taskId}): merge gated task`);
  if (commit.code !== 0 && !/nothing to commit/i.test(commit.out)) {
    return { ok: false, conflict: false, detail: commit.out.trim() };
  }
  const push = git(repoDir, "push", "origin", integrationBranch);
  if (push.code !== 0) return { ok: false, conflict: false, detail: push.out.trim() };

  if (existsSync(worktreePath)) git(repoDir, "worktree", "remove", "--force", worktreePath);
  git(repoDir, "branch", "-D", branch);
  return { ok: true, conflict: false, detail: `merged ${branch} -> ${integrationBranch}` };
}

/** Pushes `task/<taskId>` to origin (plain push with upstream; never forced). */
export function pushTaskBranch(repoDir: string, taskId: string, prefix = "task/"): SyncResult {
  const branch = `${prefix}${taskId}`;
  const push = git(repoDir, "push", "-u", "origin", branch);
  return { ok: push.code === 0, conflict: false, detail: push.out.trim() || `pushed ${branch}` };
}

/** Removes a task's worktree; optionally deletes the local branch too (only once it is merged or no longer needed). */
export function cleanupTaskWorktree(repoDir: string, taskId: string, prefix = "task/", deleteBranch = false): void {
  const worktreePath = join(repoDir, ".worktrees", taskId);
  if (existsSync(worktreePath)) git(repoDir, "worktree", "remove", "--force", worktreePath);
  if (deleteBranch) git(repoDir, "branch", "-D", `${prefix}${taskId}`);
}
