import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { previewMerge } from "../git/conflicts.js";
import { listRepoNames, resolveRepo } from "../git/repoResolve.js";
import { type JobContext, type JobResult, defineJob } from "../schedule/registry.js";

const execFileAsync = promisify(execFile);

export const DriftParams = z.object({
  mainBranch: z.string().default("main").describe("The branch the integration branch is promoted into"),
  integrationBranch: z.string().default("ai-work").describe("The branch agents land work on"),
  fetch: z.boolean().default(true).describe("Run `git fetch` in each repo first so the check reflects GitHub"),
  repos: z.array(z.string()).default([]).describe("Only check these repo folder names; leave empty to check every repo under /projects"),
});
export type DriftParams = z.infer<typeof DriftParams>;

export interface DriftRepoResult {
  repo: string;
  status: "clean" | "conflicts" | "up-to-date" | "skipped";
  /** Commits on origin/<main> the integration branch lacks. */
  behindMain: number;
  /** Commits on the integration branch origin/<main> lacks. */
  aheadOfMain: number;
  conflictFiles: string[];
  note?: string;
}

async function git(dir: string, args: string[], signal: AbortSignal): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 90_000,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    return { code: 0, out: stdout };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: err.stdout ?? "" };
  }
}

/** Compares origin/<integration> with origin/<main> in one repo. Read-only apart from `git fetch`. */
export async function checkRepoDrift(dir: string, repo: string, p: DriftParams, signal: AbortSignal): Promise<DriftRepoResult> {
  const skipped = (note: string): DriftRepoResult => ({ repo, status: "skipped", behindMain: 0, aheadOfMain: 0, conflictFiles: [], note });
  if ((await git(dir, ["remote", "get-url", "origin"], signal)).code !== 0) return skipped("no origin remote");
  let note: string | undefined;
  if (p.fetch && (await git(dir, ["fetch", "--quiet", "origin"], signal)).code !== 0) note = "fetch failed; used the last fetched state";
  const ours = `refs/remotes/origin/${p.integrationBranch}`;
  const theirs = `refs/remotes/origin/${p.mainBranch}`;
  const pv = await previewMerge(dir, ours, theirs);
  if (pv.status === "unknown") return skipped(pv.reason ?? "could not compare");
  return { repo, status: pv.status, behindMain: pv.behind, aheadOfMain: pv.ahead, conflictFiles: pv.conflictFiles, ...(note ? { note } : {}) };
}

/** Pure: the one-line run summary and whether the run found something worth looking at. */
export function summarizeDrift(results: readonly DriftRepoResult[], p: Pick<DriftParams, "mainBranch" | "integrationBranch">): { summary: string; findings: boolean } {
  const conflicts = results.filter((r) => r.status === "conflicts");
  const behind = results.filter((r) => r.status !== "skipped" && r.behindMain > 0);
  const skipped = results.filter((r) => r.status === "skipped").length;
  const checked = results.length - skipped;
  // Never say "no conflicts" when nothing was compared: that would be false reassurance.
  if (checked === 0) {
    return { summary: `nothing compared: none of ${results.length} repo${results.length === 1 ? "" : "s"} has origin/${p.integrationBranch} and origin/${p.mainBranch} to compare (${skipped} skipped)`, findings: false };
  }
  const parts = [`${checked} of ${results.length} repo${results.length === 1 ? "" : "s"} checked`];
  if (conflicts.length) parts.push(`${conflicts.length} would conflict (${conflicts.map((r) => `${r.repo}: ${r.conflictFiles.length} file${r.conflictFiles.length === 1 ? "" : "s"}`).join("; ")})`);
  else parts.push(`no conflicts between ${p.integrationBranch} and ${p.mainBranch}`);
  if (behind.length) parts.push(`${behind.length} behind ${p.mainBranch} (${behind.map((r) => `${r.repo} -${r.behindMain}`).join(", ")})`);
  if (skipped) parts.push(`${skipped} skipped`);
  return { summary: parts.join("; "), findings: conflicts.length > 0 };
}

/**
 * Daily "has the integration branch drifted from main, and would they conflict?" check. It never merges, pushes or
 * changes a working tree; it only reports, so conflicts get resolved while they are still small.
 */
export const gitDriftCheckJob = defineJob({
  id: "git-drift-check",
  title: "Git drift check",
  description:
    "Fetches each repo and predicts whether merging main into the integration branch (ai-work) would conflict. Read-only: it reports drift and conflicting files, it never merges or pushes.",
  params: DriftParams,
  async run(params: DriftParams, ctx: JobContext): Promise<JobResult> {
    const names = params.repos.length ? params.repos : listRepoNames(ctx.projectsRoot);
    const results: DriftRepoResult[] = [];
    for (const name of names) {
      if (ctx.signal.aborted) break;
      let dir: string;
      try {
        dir = resolveRepo(ctx.projectsRoot, name);
      } catch {
        ctx.log(`${name}: not a repo under ${ctx.projectsRoot}, skipped`);
        continue;
      }
      const r = await checkRepoDrift(dir, name, params, ctx.signal);
      ctx.log(`${name}: ${r.status}${r.behindMain ? `, behind ${params.mainBranch} by ${r.behindMain}` : ""}${r.conflictFiles.length ? `, conflicts in ${r.conflictFiles.join(", ")}` : ""}${r.note ? ` (${r.note})` : ""}`);
      results.push(r);
    }
    const { summary, findings } = summarizeDrift(results, params);
    return { summary, status: findings ? "findings" : "ok", details: results };
  },
});
