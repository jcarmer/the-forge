import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { resolve } from "node:path";
import { listRepoNames, resolveRepo } from "./repoResolve.js";

const execFileAsync = promisify(execFile);

export const OpenPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  isDraft: z.boolean(),
});
export type OpenPr = z.infer<typeof OpenPrSchema>;

export const RepoSummarySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Current checked-out branch, or "(detached)". */
  branch: z.string(),
  dirty: z.boolean(),
  /** Uncommitted files, including untracked. */
  changedFiles: z.number(),
  ahead: z.number(),
  /** Commits on the upstream we have not pulled. */
  behind: z.number(),
  noUpstream: z.boolean(),
  /** Local branches not fully merged into the main branch (main itself excluded; includes the current branch if unmerged). */
  openBranches: z.array(z.string()),
  /** null = unknown (gh unavailable or failed). */
  openPrs: z.array(OpenPrSchema).nullable(),
  ghAvailable: z.boolean(),
  stashes: z.number(),
  /** Highest-priority reason, or "clean". */
  attention: z.enum(["dirty", "behind", "ahead", "prs", "branches", "clean"]),
  /** All reasons, in priority order: dirty, behind, ahead, prs, branches. */
  reasons: z.array(z.enum(["dirty", "behind", "ahead", "prs", "branches"])),
});
export type RepoSummary = z.infer<typeof RepoSummarySchema>;

export interface SummaryOpts {
  mainBranch: string;
  integrationBranch: string;
  /** How long to reuse a `gh pr list` result per repo. Default 30s; 0 disables. */
  ghCacheMs?: number;
  /** Minimum time between `git fetch` runs per repo. Default 60s; 0 fetches every time. */
  fetchTtlMs?: number;
  /** Explicit user refresh: fetch now and re-query gh, ignoring both caches. */
  refresh?: boolean;
}

async function run(cmd: string, args: string[], cwd: string, timeout: number) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

const git = (dir: string, args: string[], timeout = 15_000) => run("git", ["-C", dir, ...args], dir, timeout);
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/** Per-repo caches, keyed by the resolved repo directory. */
const ghCache = new Map<string, { at: number; prs: OpenPr[] | null }>();
const lastFetch = new Map<string, number>();

/** Drops cached `gh pr list` results for a repo (e.g. right after a PR was created) so the next summary re-queries. */
export function invalidateRepoCaches(dir: string): void {
  ghCache.delete(resolve(dir));
}

async function listOpenPrs(dir: string, cacheMs: number, bypass: boolean): Promise<OpenPr[] | null> {
  const hit = ghCache.get(dir);
  if (!bypass && cacheMs > 0 && hit && Date.now() - hit.at < cacheMs) return hit.prs;
  const r = await run(
    "gh",
    ["pr", "list", "--state", "open", "--json", "number,title,url,headRefName,baseRefName,isDraft"],
    dir,
    10_000,
  );
  let prs: OpenPr[] | null = null;
  if (r.code === 0) {
    try {
      const parsed = z.array(OpenPrSchema).safeParse(JSON.parse(r.out));
      prs = parsed.success ? parsed.data : null;
    } catch {
      prs = null;
    }
  }
  if (cacheMs > 0) ghCache.set(dir, { at: Date.now(), prs });
  return prs;
}

/**
 * Summarises one repo. Read-only apart from `git fetch` (at most once per `fetchTtlMs` unless `refresh`).
 * Throws RepoActionError for an invalid or unknown repo name; never throws for per-command failures.
 */
export async function summarizeRepo(projectsRoot: string, repoName: string, opts: SummaryOpts): Promise<RepoSummary> {
  const dir = resolveRepo(projectsRoot, repoName);
  const remotes = await git(dir, ["remote"]);
  const hasRemote = remotes.code === 0 && remotes.out.trim().length > 0;
  // Refresh remote-tracking refs so "behind" is accurate; failures (offline) just leave stale refs.
  const ttl = opts.fetchTtlMs ?? 60_000;
  const last = lastFetch.get(dir);
  if (hasRemote && (opts.refresh || ttl <= 0 || last === undefined || Date.now() - last >= ttl)) {
    lastFetch.set(dir, Date.now());
    await git(dir, ["fetch", "--quiet"], 20_000);
  }

  const [branchRes, statusRes, revRes, stashRes, mainRef, prs] = await Promise.all([
    git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]),
    // Same expansion as the detail page (getChanges), so the tile count matches its file list.
    git(dir, ["status", "--porcelain", "--untracked-files=all"]),
    git(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]),
    git(dir, ["stash", "list"]),
    git(dir, ["rev-parse", "--verify", "-q", `refs/heads/${opts.mainBranch}`]),
    listOpenPrs(dir, opts.ghCacheMs ?? 30_000, Boolean(opts.refresh)),
  ]);

  const detached = branchRes.code !== 0 || !branchRes.out.trim();
  const branch = detached ? "(detached)" : branchRes.out.trim();
  const changedFiles = statusRes.code === 0 ? lines(statusRes.out).length : 0;

  let behind = 0;
  let ahead = 0;
  if (revRes.code === 0) {
    const parts = revRes.out.trim().split(/\s+/);
    behind = Number(parts[0]) || 0;
    ahead = Number(parts[1]) || 0;
  }
  const noUpstream = revRes.code !== 0 && hasRemote && !detached;
  if (noUpstream) {
    const own = await git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    ahead = Number(own.out.trim()) || 0;
  }

  // Compare against the local main branch; fall back to origin/<main> if it has not been checked out locally.
  let openBranches: string[] = [];
  const base = mainRef.code === 0 ? `refs/heads/${opts.mainBranch}` : `refs/remotes/origin/${opts.mainBranch}`;
  const baseOk = mainRef.code === 0 || (await git(dir, ["rev-parse", "--verify", "-q", base])).code === 0;
  if (baseOk) {
    const nm = await git(dir, ["for-each-ref", "--format=%(refname:short)", "--no-merged", base, "refs/heads"]);
    if (nm.code === 0) openBranches = lines(nm.out).filter((b) => b !== opts.mainBranch);
  }

  const reasons: RepoSummary["reasons"] = [];
  if (changedFiles > 0) reasons.push("dirty");
  if (behind > 0) reasons.push("behind");
  if (ahead > 0) reasons.push("ahead");
  if (prs && prs.length > 0) reasons.push("prs");
  if (openBranches.length > 0) reasons.push("branches");

  return {
    name: repoName,
    path: dir,
    branch,
    dirty: changedFiles > 0,
    changedFiles,
    ahead,
    behind,
    noUpstream,
    openBranches,
    openPrs: prs,
    ghAvailable: prs !== null,
    stashes: stashRes.code === 0 ? lines(stashRes.out).length : 0,
    attention: reasons[0] ?? "clean",
    reasons,
  };
}

/** Pure: repos needing attention first (more reasons first, then name); fully clean repos last (by name). */
export function sortRepoSummaries<T extends { name: string; reasons: readonly string[] }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const ca = a.reasons.length === 0 ? 1 : 0;
    const cb = b.reasons.length === 0 ? 1 : 0;
    if (ca !== cb) return ca - cb;
    if (ca === 0 && a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length;
    return a.name.localeCompare(b.name);
  });
}

/** Discovers repos (same rules as `resolveRepo`, no git commands) and summarises each in parallel, sorted for display. */
export async function summarizeAllRepos(projectsRoot: string, opts: SummaryOpts): Promise<RepoSummary[]> {
  const settled = await Promise.allSettled(listRepoNames(projectsRoot).map((name) => summarizeRepo(projectsRoot, name, opts)));
  // A repo removed between listing and summarising is simply skipped.
  return sortRepoSummaries(settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
}
