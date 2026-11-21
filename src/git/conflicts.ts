/**
 * Read-only merge conflict prediction, used by the Git page (sync preview, tile chips), the CLI and the drift job.
 *
 * `git merge-tree --write-tree` needs git 2.38; the container ships 2.34, so this uses plumbing that works everywhere:
 * a three-way `read-tree` into a THROWAWAY index file (the repo's real index, working tree and refs are never
 * touched), then a content merge (`git merge-file`) for the files changed on both sides, so non-overlapping edits are
 * correctly reported as clean.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** At most this many both-sides-changed files get a content merge; the rest are reported as conflicting (conservative). */
const MAX_CONTENT_CHECKS = 300;

export type MergePreviewStatus = "clean" | "conflicts" | "up-to-date" | "unknown";

export interface MergePreview {
  status: MergePreviewStatus;
  /** Files that would conflict, sorted. Empty unless status is "conflicts". */
  conflictFiles: string[];
  /** True when more files changed on both sides than were content-checked; the extras are counted as conflicts. */
  truncated: boolean;
  /** Commits on `theirs` that `ours` lacks (what a merge would bring in). */
  behind: number;
  /** Commits on `ours` that `theirs` lacks. */
  ahead: number;
  /** Why the status is "unknown" (missing ref, unrelated histories...). */
  reason?: string;
}

interface Exec {
  code: number;
  out: string;
}

async function exec(dir: string, args: string[], env: Record<string, string> = {}): Promise<Exec> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
    });
    return { code: 0, out: stdout };
  } catch (e: unknown) {
    const err = e as { code?: number | string; stdout?: string };
    return { code: typeof err.code === "number" ? err.code : 1, out: err.stdout ?? "" };
  }
}

async function blobTo(dir: string, sha: string, file: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "cat-file", "blob", sha], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    writeFileSync(file, stdout);
    return true;
  } catch {
    return false;
  }
}

interface Stages {
  1?: { mode: string; sha: string };
  2?: { mode: string; sha: string };
  3?: { mode: string; sha: string };
}

/** Parses `git ls-files -u -z` into per-path stage entries. */
export function parseUnmerged(out: string): Map<string, Stages> {
  const byPath = new Map<string, Stages>();
  for (const rec of out.split("\0")) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const st = byPath.get(m[4]) ?? {};
    st[Number(m[3]) as 1 | 2 | 3] = { mode: m[1], sha: m[2] };
    byPath.set(m[4], st);
  }
  return byPath;
}

/**
 * Predicts whether merging `theirs` into `ours` would conflict. Both must be fully qualified refs or commit ids
 * (callers pass `refs/heads/<b>` / `refs/remotes/origin/<b>`). Never throws for git failures: returns "unknown".
 */
export async function previewMerge(dir: string, ours: string, theirs: string): Promise<MergePreview> {
  const unknown = (reason: string, extra: Partial<MergePreview> = {}): MergePreview => ({
    status: "unknown",
    conflictFiles: [],
    truncated: false,
    behind: 0,
    ahead: 0,
    reason,
    ...extra,
  });

  const [o, t] = await Promise.all([exec(dir, ["rev-parse", "--verify", "-q", `${ours}^{commit}`]), exec(dir, ["rev-parse", "--verify", "-q", `${theirs}^{commit}`])]);
  if (o.code !== 0) return unknown(`${ours} does not exist`);
  if (t.code !== 0) return unknown(`${theirs} does not exist`);
  const oursOid = o.out.trim();
  const theirsOid = t.out.trim();

  const counts = await exec(dir, ["rev-list", "--left-right", "--count", `${theirsOid}...${oursOid}`]);
  const [behindStr, aheadStr] = counts.out.trim().split(/\s+/);
  const behind = Number(behindStr) || 0;
  const ahead = Number(aheadStr) || 0;
  if (behind === 0) return { status: "up-to-date", conflictFiles: [], truncated: false, behind, ahead };

  const baseRes = await exec(dir, ["merge-base", oursOid, theirsOid]);
  const base = baseRes.out.trim();
  if (baseRes.code !== 0 || !base) return unknown("no common history between the two branches", { behind, ahead });

  const tmp = mkdtempSync(join(tmpdir(), "forge-merge-preview-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    const rt = await exec(dir, ["read-tree", "-m", "--aggressive", base, oursOid, theirsOid], env);
    if (rt.code !== 0) return unknown("could not compute a three-way merge", { behind, ahead });
    const un = parseUnmerged((await exec(dir, ["ls-files", "-u", "-z"], env)).out);

    const conflicts: string[] = [];
    let checked = 0;
    let truncated = false;
    for (const [path, st] of un) {
      const { 1: b, 2: a, 3: th } = st;
      if (a && th && a.sha === th.sha && a.mode === th.mode) continue; // identical on both sides
      if (!a || !th || !b) {
        conflicts.push(path); // modify/delete or add/add with different content
        continue;
      }
      if (a.mode !== th.mode || a.mode === "160000") {
        conflicts.push(path); // mode change or submodule pointer changed on both sides
        continue;
      }
      if (checked >= MAX_CONTENT_CHECKS) {
        truncated = true;
        conflicts.push(path);
        continue;
      }
      checked++;
      const fa = join(tmp, "a");
      const fb = join(tmp, "b");
      const ft = join(tmp, "t");
      const ok = (await blobTo(dir, a.sha, fa)) && (await blobTo(dir, b.sha, fb)) && (await blobTo(dir, th.sha, ft));
      if (!ok) {
        conflicts.push(path);
        continue;
      }
      // Exit 0 = merged cleanly; 1..127 = that many conflicts; anything else is an error (treated as a conflict).
      const mf = await exec(dir, ["merge-file", "-p", "--quiet", fa, fb, ft]);
      if (mf.code !== 0) conflicts.push(path);
    }
    conflicts.sort((x, y) => x.localeCompare(y));
    return { status: conflicts.length > 0 ? "conflicts" : "clean", conflictFiles: conflicts, truncated, behind, ahead };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Paths git currently reports as unmerged (call while a conflicted merge is still in progress). */
export async function unmergedFiles(dir: string): Promise<string[]> {
  const r = await exec(dir, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return r.out.split("\0").filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** Copy-able steps for resolving `main` into `branch` in a local clone (e.g. on the Windows desktop with GitComet). */
export function buildResolveSteps(branch: string, mainBranch: string, files: readonly string[] = []): string[] {
  const shown = files.slice(0, 10);
  const more = files.length > shown.length ? ` (+${files.length - shown.length} more)` : "";
  return [
    "In your own clone (e.g. on Windows):",
    "  git fetch origin",
    `  git checkout ${branch}`,
    "  git pull --ff-only",
    `  git merge origin/${mainBranch}`,
    ...(shown.length ? [`Resolve the conflicts in GitComet: ${shown.join(", ")}${more}`] : ["Resolve the conflicts in GitComet."]),
    "  git add <resolved files> && git commit",
    `  git push origin ${branch}`,
    `Then pull ${branch} here (Pull / sync). Do not push while an agent task is running on it.`,
  ];
}

/** One readable block for a conflict result: which files, then the steps. */
export function describeConflict(branch: string, mainBranch: string, files: readonly string[]): string {
  const list = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} conflict: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` (+${files.length - 10} more)` : ""}.` : "Files conflict.";
  return `${list}\n${buildResolveSteps(branch, mainBranch, files).join("\n")}`;
}

/** Cache keyed by the two commit ids: a preview of the same pair never changes, so polling stays cheap. */
const previewCache = new Map<string, MergePreview>();

export async function previewMergeCached(dir: string, ours: string, theirs: string): Promise<MergePreview> {
  const [o, t] = await Promise.all([exec(dir, ["rev-parse", "--verify", "-q", `${ours}^{commit}`]), exec(dir, ["rev-parse", "--verify", "-q", `${theirs}^{commit}`])]);
  if (o.code !== 0 || t.code !== 0) return previewMerge(dir, ours, theirs);
  const key = `${dir}\0${o.out.trim()}\0${t.out.trim()}`;
  const hit = previewCache.get(key);
  if (hit) return hit;
  const res = await previewMerge(dir, ours, theirs);
  if (res.status !== "unknown") {
    if (previewCache.size > 500) previewCache.clear();
    previewCache.set(key, res);
  }
  return res;
}
