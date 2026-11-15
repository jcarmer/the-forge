import type { GitBranchInfo, GitBranchesResponse, GitChangedFile, GitLinks } from "../../types";

/** What the backend reports as the branch when HEAD is detached. */
export const DETACHED_BRANCH = "(detached)";

/** True when there is no checked-out branch (detached HEAD, or unknown). Commit, PR, Pull and Sync need a branch. */
export function isDetached(branch: string | null | undefined): boolean {
  return !branch || branch === DETACHED_BRANCH;
}

/**
 * Selection is stored as the set of DESELECTED paths so every file is selected by default and files that appear
 * after a refresh are selected too.
 */
export function selectedFiles(files: GitChangedFile[], deselected: ReadonlySet<string>): GitChangedFile[] {
  return files.filter((f) => !deselected.has(f.path));
}

export function toggleSelected(deselected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(deselected);
  if (!next.delete(path)) next.add(path);
  return next;
}

export function selectAll(): Set<string> {
  return new Set();
}

export function selectNone(files: GitChangedFile[]): Set<string> {
  return new Set(files.map((f) => f.path));
}

/** Drops deselected paths that are no longer changed, so the set cannot grow forever. */
export function pruneDeselected(deselected: ReadonlySet<string>, files: GitChangedFile[]): Set<string> {
  const present = new Set(files.map((f) => f.path));
  const next = new Set<string>();
  for (const p of deselected) if (present.has(p)) next.add(p);
  return next.size === deselected.size ? (deselected as Set<string>) : next;
}

/** True when only some of the changed files are selected (so commit-push must send an explicit file list). */
export function isSubset(files: GitChangedFile[], selected: GitChangedFile[]): boolean {
  return selected.length < files.length;
}

export function statusWord(f: Pick<GitChangedFile, "status">): string {
  switch (f.status) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "untracked";
  }
}

export function stageWord(f: Pick<GitChangedFile, "staged" | "unstaged" | "status">): "staged" | "partly staged" | "unstaged" | "untracked" {
  if (f.staged && f.unstaged) return "partly staged";
  if (f.staged) return "staged";
  return f.status === "?" ? "untracked" : "unstaged";
}

/** Changes whenever the cached diff of a file may have changed. */
export function fileSignature(f: GitChangedFile): string {
  return [f.path, f.oldPath ?? "", f.status, f.staged ? 1 : 0, f.unstaged ? 1 : 0, f.additions, f.deletions].join("|");
}

/** Signature of the whole change set (staging included). */
export function changesSignature(files: GitChangedFile[]): string {
  return files.map(fileSignature).join("\n");
}

/** Like changesSignature but ignores staging: staging a file does not change what the AI summary should say. */
export function summarySignature(files: GitChangedFile[]): string {
  return files.map((f) => [f.path, f.oldPath ?? "", f.status, f.additions, f.deletions].join("|")).join("\n");
}

/** Fallback protected names when the backend did not report its configured main/integration branches. */
export const PROTECTED_BRANCHES = ["main", "master", "ai-work"];

/** The configured main + integration branches (never offered for deletion; the backend refuses them as well). */
export function protectedBranches(cfg?: Pick<GitBranchesResponse, "mainBranch" | "integrationBranch"> | null): string[] {
  const names = [cfg?.mainBranch, cfg?.integrationBranch].filter((n): n is string => Boolean(n));
  return names.length ? [...new Set(names)] : PROTECTED_BRANCHES;
}

export interface BranchGroups {
  /** The main and integration branches: listed on their own, never "unmerged" or deletable. */
  base: GitBranchInfo[];
  unmerged: GitBranchInfo[];
  /** Merged into main and safe to delete. */
  deletable: GitBranchInfo[];
  /** Merged but checked out: listed, not selectable. */
  merged: GitBranchInfo[];
}

export function groupBranches(branches: GitBranchInfo[], cfg?: Pick<GitBranchesResponse, "mainBranch" | "integrationBranch"> | null): BranchGroups {
  const prot = protectedBranches(cfg);
  const base: GitBranchInfo[] = [];
  const unmerged: GitBranchInfo[] = [];
  const deletable: GitBranchInfo[] = [];
  const merged: GitBranchInfo[] = [];
  for (const b of branches) {
    if (prot.includes(b.name)) base.push(b);
    else if (!b.merged) unmerged.push(b);
    else if (b.isCurrent) merged.push(b);
    else deletable.push(b);
  }
  return { base, unmerged, deletable, merged };
}

/** Selected names that are still deletable (drops anything that vanished after a refresh). */
export function pruneBranchSelection(selected: ReadonlySet<string>, deletable: GitBranchInfo[]): Set<string> {
  const ok = new Set(deletable.map((b) => b.name));
  return new Set([...selected].filter((n) => ok.has(n)));
}

/**
 * The PR base / main branch: the backend's configured main branch when known, else from the compare URL
 * (`.../compare/<base>...<head>`), else main/master, else "main".
 */
export function guessBaseBranch(links: GitLinks | null, branches: GitBranchInfo[] | null, configuredMain?: string): string {
  if (configuredMain) return configuredMain;
  const m = links?.compareUrl ? /\/compare\/(.+?)\.\.\./.exec(links.compareUrl) : null;
  if (m?.[1]) {
    try {
      return m[1].split("/").map(decodeURIComponent).join("/");
    } catch {
      /* fall through */
    }
  }
  const names = new Set((branches ?? []).map((b) => b.name));
  if (names.has("main")) return "main";
  if (names.has("master")) return "master";
  return "main";
}

/** Why Pull is unavailable, or null when it is allowed. */
export function pullBlockedReason(repo: { behind: number; noUpstream: boolean; branch: string }): string | null {
  if (isDetached(repo.branch)) return "Detached HEAD: check out a branch first.";
  if (repo.noUpstream) return "This branch has no upstream yet; push it first.";
  if (repo.behind <= 0) return "Already up to date: nothing to pull.";
  return null;
}

/** Why Sync-from-main is unavailable, or null when it is allowed. */
export function syncBlockedReason(opts: { branch: string; mainBranch: string; dirty: boolean }): string | null {
  if (isDetached(opts.branch)) return "Detached HEAD: check out a branch first.";
  if (opts.branch === opts.mainBranch) return `You are on ${opts.mainBranch}; use Pull instead.`;
  if (opts.dirty) return "Commit or stash your uncommitted changes first (a conflicted merge could not be cleanly aborted otherwise).";
  return null;
}
