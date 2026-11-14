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
  unpushed: boolean;
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
