export type ProviderName = "ollama" | "antigravity" | "claude";
export type TaskComplexity = "trivial" | "normal" | "hard";

export interface ServiceStatus {
  id: string;
  name: string;
  kind: "preview" | "core";
  port: number;
  branch?: string;
  state: "starting" | "running" | "stopped" | "unknown";
  logFile?: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface UsageEntry {
  provider: ProviderName;
  scope: "5h" | "weekly" | "model_weekly";
  model?: string;
  remainingPct: number;
  resetsAt: string;
}

export interface UsageSnapshot {
  collectedAt: string;
  entries: UsageEntry[];
  sources: Record<string, string>;
}

export interface RepoStatus {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  noUpstream: boolean;
  localOnlyCommits: number;
  stashes: number;
  unpushed: boolean;
}

export interface GitRepoPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
}

export type GitRepoReason = "dirty" | "behind" | "ahead" | "prs" | "branches";

/** Mirrors RepoSummary in src/git/repoSummary.ts (GET /api/git/repos). */
export interface GitRepoSummary {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  changedFiles: number;
  ahead: number;
  behind: number;
  noUpstream: boolean;
  openBranches: string[];
  openPrs: GitRepoPr[] | null;
  ghAvailable: boolean;
  stashes: number;
  attention: GitRepoReason | "clean";
  reasons: GitRepoReason[];
}

export interface PackageConsumer {
  repo: string;
  repoPath: string;
  pinnedVersion: string;
  linked: boolean;
  updateAvailable: boolean;
}

export interface PackageStatus {
  name: string;
  version: string;
  repoName: string;
  repoPath: string;
  dirty: boolean;
  unpushed: boolean;
  hasApiDts: boolean;
  consumers: PackageConsumer[];
}

export interface TaskRecord {
  id: string;
  repoDir: string;
  prompt: string;
  complexity: TaskComplexity;
  status: "running" | "passed" | "failed";
  startedAt: string;
  finishedAt?: string;
  merged: boolean;
  prUrl?: string;
  error?: string;
  attempts: { provider: ProviderName; gateOk: boolean; reviewOk: boolean; note: string }[];
}

export interface ForgeState {
  version: number;
  updatedAt: string;
  hostname: string;
  integrationBranch: string;
  services: ServiceStatus[];
  diagnostics: { checkedAt: string; checks: CheckResult[] };
  auth: { checkedAt: string; items: CheckResult[] };
  usage: UsageSnapshot | null;
  repos: RepoStatus[];
  packages: PackageStatus[];
  tasks: TaskRecord[];
}

export interface RouteDecision {
  provider: ProviderName | null;
  reason: string;
  scores: Partial<Record<ProviderName, number>>;
  blocked: Partial<Record<ProviderName, string>>;
}

// ---- Per-repo Git detail page (mirrors src/git/repoActions.ts; /api/git/repo/:name/...) ----

/** One uncommitted file. `staged`/`unstaged` can both be true (partly staged). */
export interface GitChangedFile {
  path: string;
  oldPath?: string;
  status: "M" | "A" | "D" | "R" | "?";
  staged: boolean;
  unstaged: boolean;
  conflicted?: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** GET /changes */
export interface GitChangesResponse {
  branch: string;
  files: GitChangedFile[];
}

/** GET /diff?path= */
export interface GitDiffResponse {
  path: string;
  diff: string;
  truncated: boolean;
}

/** POST /summary {regenerate?} — ok:false with detail when Ollama fails (HTTP 200). */
export interface GitSummaryResponse {
  ok: boolean;
  model: string;
  summary: string;
  cached: boolean;
  detail?: string;
}

/** POST /draft-message {regenerate?} */
export interface GitDraftMessage {
  ok: boolean;
  model: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  cached: boolean;
  source?: "changes" | "commits";
  detail?: string;
}

/** One local branch from GET /branches. ahead/behind are relative to `compareTo` (upstream, else main). */
export interface GitBranchInfo {
  name: string;
  merged: boolean;
  ahead: number;
  behind: number;
  compareTo: string | null;
  lastCommit: { sha: string; subject: string; date: string };
  isCurrent: boolean;
  hasRemote: boolean;
  upstream?: string;
}

/** GET /branches */
export interface GitBranchesResponse {
  current: string;
  branches: GitBranchInfo[];
}

/** GET /stashes returns GitStashEntry[] */
export interface GitStashEntry {
  ref: string;
  message: string;
  sha: string;
  date: string;
}

/** GET /links */
export interface GitLinks {
  repoUrl?: string;
  prUrls: string[];
  compareUrl?: string;
  branch: string;
  ghAvailable: boolean;
}

/** Every POST action (200 when ok, else 400 with detail). Extras vary by action. */
export interface GitActionResult {
  ok: boolean;
  detail: string;
  error?: string;
  /** create-pr */
  url?: string;
  /** commit-push / create-pr / sync-main */
  pushed?: boolean;
  committed?: boolean;
  commit?: string;
  /** sync-main / stash-pop */
  conflict?: boolean;
  /** pull */
  diverged?: boolean;
  commits?: number;
  before?: string;
  after?: string;
  /** discard */
  discarded?: string[];
  skippedUntracked?: string[];
  recoveryRef?: string;
  /** stash */
  ref?: string;
  sha?: string;
  /** stage / unstage */
  files?: string[];
  /** delete-branches */
  results?: { branch: string; ok: boolean; detail: string }[];
}
