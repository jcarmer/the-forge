import { z } from "zod";
import { UsageSnapshotSchema } from "../usage/schema.js";

export const ServiceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["preview", "core"]),
  port: z.number(),
  branch: z.string().optional(),
  state: z.enum(["starting", "running", "stopped", "unknown"]),
  logFile: z.string().optional(),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const CheckResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const RepoStatusSchema = z.object({
  name: z.string(),
  path: z.string(),
  branch: z.string(),
  dirty: z.boolean(),
  ahead: z.number(),
  behind: z.number(),
  /** Current branch has no upstream although a remote exists (never published). */
  noUpstream: z.boolean().default(false),
  /** Commits on any local branch that exist on no remote (includes `ahead` when there is no upstream). */
  localOnlyCommits: z.number().default(0),
  stashes: z.number().default(0),
  /** True when anything committed locally has not reached a remote. */
  unpushed: z.boolean(),
});
export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const PackageConsumerSchema = z.object({
  repo: z.string(),
  repoPath: z.string(),
  pinnedVersion: z.string(),
  linked: z.boolean(),
  updateAvailable: z.boolean(),
});
export type PackageConsumer = z.infer<typeof PackageConsumerSchema>;

export const PackageStatusSchema = z.object({
  name: z.string(),
  version: z.string(),
  repoName: z.string(),
  repoPath: z.string(),
  dirty: z.boolean(),
  unpushed: z.boolean(),
  hasApiDts: z.boolean(),
  consumers: z.array(PackageConsumerSchema),
});
export type PackageStatus = z.infer<typeof PackageStatusSchema>;

export const TaskRecordSchema = z.object({
  id: z.string(),
  repoDir: z.string(),
  prompt: z.string(),
  complexity: z.enum(["trivial", "normal", "hard"]),
  status: z.enum(["running", "passed", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  merged: z.boolean(),
  prUrl: z.string().optional(),
  error: z.string().optional(),
  attempts: z.array(
    z.object({
      provider: z.enum(["ollama", "antigravity", "claude"]),
      gateOk: z.boolean(),
      reviewOk: z.boolean(),
      note: z.string(),
    }),
  ),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const ForgeStateSchema = z.object({
  version: z.number(),
  updatedAt: z.string(),
  hostname: z.string(),
  integrationBranch: z.string(),
  services: z.array(ServiceStatusSchema),
  diagnostics: z.object({
    checkedAt: z.string(),
    checks: z.array(CheckResultSchema),
  }),
  auth: z.object({
    checkedAt: z.string(),
    items: z.array(CheckResultSchema),
  }),
  usage: UsageSnapshotSchema.nullable(),
  repos: z.array(RepoStatusSchema),
  packages: z.array(PackageStatusSchema),
  tasks: z.array(TaskRecordSchema),
});
export type ForgeState = z.infer<typeof ForgeStateSchema>;

/** Pure comparison: checks if a pinned range/version differs from the local workspace package version. */
export function isPackageUpdateAvailable(localVersion: string, pinnedSpec: string): boolean {
  const cleanPinned = pinnedSpec.replace(/^[~^]/, "").trim();
  if (!cleanPinned || cleanPinned.startsWith("file:") || cleanPinned.startsWith("link:") || cleanPinned === "*") {
    return false;
  }
  const tagMatch = cleanPinned.match(/#v?(\d+\.\d+\.\d+)$/);
  const target = tagMatch ? tagMatch[1]! : cleanPinned;
  return /^\d+\.\d+\.\d+$/.test(target) && target !== localVersion;
}

/** Pure summary counts derived from ForgeState (Out of the Tarpit: derived data, never stored). */
export function deriveSummaryCounts(state: ForgeState) {
  return {
    failingChecks: state.diagnostics.checks.filter((c) => !c.ok).length,
    failingAuth: state.auth.items.filter((a) => !a.ok).length,
    dirtyPackages: state.packages.filter((p) => p.dirty || p.unpushed).length,
    runningTasks: state.tasks.filter((t) => t.status === "running").length,
    runningServices: state.services.filter((s) => s.state === "running").length,
  };
}
