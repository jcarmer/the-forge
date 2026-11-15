import { execFile } from "node:child_process";
import { run } from "../ops.js";

export interface PrResult {
  ok: boolean;
  /** URL of the created (or already-open) pull request. */
  url?: string;
  /** True when the PR was also merged. */
  merged?: boolean;
  detail: string;
}

export interface PrOpts {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

interface GhResult {
  code: number;
  out: string;
  missing: boolean;
  timedOut?: boolean;
}

const URL_RE = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/;

function gh(repoDir: string, ...args: string[]): GhResult {
  return run("gh", args, { cwd: repoDir });
}

/** Non-blocking gh call for the web server: never prompts, killed after `timeoutMs`. */
function ghAsync(repoDir: string, args: string[], timeoutMs: number): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        cwd: repoDir,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const out = (stdout ?? "") + (stderr ?? "");
        if (!err) return resolve({ code: 0, out, missing: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        resolve({
          code: typeof e.code === "number" ? e.code : 1,
          out,
          missing: e.code === "ENOENT",
          timedOut: Boolean(e.killed),
        });
      },
    );
  });
}

/** Cheap check that `gh` is installed and authenticated (via GH_TOKEN or a login). */
export function ghAvailable(repoDir = process.cwd()): { ok: boolean; detail: string } {
  const r = gh(repoDir, "auth", "status");
  if (r.missing) return { ok: false, detail: "gh is not installed (rebuild the image: sandboxctl rebuild)" };
  return { ok: r.code === 0, detail: r.code === 0 ? "authenticated" : r.out.trim().split("\n")[0] || "not authenticated" };
}

// Shared by the sync and async variants.
const listArgs = (o: PrOpts) => ["pr", "list", "--head", o.head, "--base", o.base, "--state", "open", "--json", "url", "--jq", ".[0].url"];
const createArgs = (o: PrOpts) => ["pr", "create", "--head", o.head, "--base", o.base, "--title", o.title, "--body", o.body, ...(o.draft ? ["--draft"] : [])];

function existingResult(r: GhResult): PrResult | null {
  if (r.missing) return { ok: false, detail: "gh is not installed" };
  if (r.timedOut) return { ok: false, detail: "gh timed out while looking for an open pull request" };
  const found = r.out.match(URL_RE)?.[0];
  return r.code === 0 && found ? { ok: true, url: found, detail: "pull request already open" } : null;
}

function createdResult(r: GhResult): PrResult {
  if (r.timedOut) return { ok: false, detail: "gh timed out while creating the pull request; check GitHub before retrying" };
  const url = r.out.match(URL_RE)?.[0];
  if (r.code !== 0 || !url) return { ok: false, detail: r.out.trim() || "gh pr create failed" };
  return { ok: true, url, detail: "pull request opened" };
}

/**
 * Opens a PR `head` -> `base`, or returns the existing open one (so retries are idempotent).
 * Never force-pushes, never edits branches, and never modifies repo-level settings (`gh repo edit`),
 * so `GH_TOKEN` only needs `Contents: Read & Write` and `Pull requests: Read & Write` (no Administration).
 * Synchronous (CLI use); the web server uses `openPullRequestAsync`.
 */
export function openPullRequest(repoDir: string, opts: PrOpts): PrResult {
  const existing = existingResult(gh(repoDir, ...listArgs(opts)));
  if (existing) return existing;
  return createdResult(gh(repoDir, ...createArgs(opts)));
}

/** Same as `openPullRequest`, but async (does not block the event loop), non-interactive and time-limited per gh call. */
export async function openPullRequestAsync(repoDir: string, opts: PrOpts, o: { timeoutMs?: number } = {}): Promise<PrResult> {
  const timeout = o.timeoutMs ?? 60_000;
  const existing = existingResult(await ghAsync(repoDir, listArgs(opts), timeout));
  if (existing) return existing;
  return createdResult(await ghAsync(repoDir, createArgs(opts), timeout));
}

function mergeResult(r: GhResult, target: string): PrResult {
  if (r.missing) return { ok: false, merged: false, detail: "gh is not installed" };
  if (r.timedOut) return { ok: false, merged: false, detail: "gh timed out while merging the pull request; check GitHub before retrying" };
  const url = r.out.match(URL_RE)?.[0] ?? (URL_RE.test(target) ? target : undefined);
  return {
    ok: r.code === 0,
    ...(url ? { url } : {}),
    merged: r.code === 0,
    detail: r.out.trim() || (r.code === 0 ? "merged and deleted remote branch" : "gh pr merge failed"),
  };
}

/** Squash-merges a PR and deletes its branch. Fails (without side effects) if checks/protections block it. */
export function squashMergePullRequest(repoDir: string, prUrlOrNumber: string): PrResult {
  const r = gh(repoDir, "pr", "merge", prUrlOrNumber, "--squash", "--delete-branch");
  return mergeResult(r, prUrlOrNumber);
}

/** Async, non-interactive variant of `squashMergePullRequest` for the web server. */
export async function squashMergePullRequestAsync(
  repoDir: string,
  prUrlOrNumber: string,
  o: { timeoutMs?: number } = {},
): Promise<PrResult> {
  const timeout = o.timeoutMs ?? 60_000;
  const r = await ghAsync(repoDir, ["pr", "merge", prUrlOrNumber, "--squash", "--delete-branch"], timeout);
  return mergeResult(r, prUrlOrNumber);
}

