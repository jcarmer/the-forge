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

/** Repo merge settings applied before every PR: squash-only, auto-delete merged branches, allow auto-merge. */
const repoSettingsArgs = [
  "repo", "edit",
  "--enable-squash-merge",
  "--enable-merge-commit=false",
  "--enable-rebase-merge=false",
  "--delete-branch-on-merge",
  "--enable-auto-merge",
];

/**
 * Best-effort: a token without repo-admin rights fails here, which must not block the PR itself.
 * Returns a warning to append to the result detail, or undefined on success.
 */
function settingsWarning(r: GhResult): string | undefined {
  if (r.missing || r.code === 0) return undefined;
  return r.timedOut ? "repo merge settings update timed out" : `repo merge settings not updated: ${r.out.trim().split("\n")[0] || "gh repo edit failed"}`;
}

function withWarning(res: PrResult, warning: string | undefined): PrResult {
  return warning ? { ...res, detail: `${res.detail} (warning: ${warning})` } : res;
}

/**
 * Opens a PR `head` -> `base`, or returns the existing open one (so retries are idempotent).
 * Never force-pushes, never edits branches: it only talks to the GitHub API via `gh`.
 * Synchronous (CLI use); the web server uses `openPullRequestAsync`.
 */
export function openPullRequest(repoDir: string, opts: PrOpts): PrResult {
  const warning = settingsWarning(gh(repoDir, ...repoSettingsArgs));
  const existing = existingResult(gh(repoDir, ...listArgs(opts)));
  if (existing) return withWarning(existing, warning);
  return withWarning(createdResult(gh(repoDir, ...createArgs(opts))), warning);
}

/** Same as `openPullRequest`, but async (does not block the event loop), non-interactive and time-limited per gh call. */
export async function openPullRequestAsync(repoDir: string, opts: PrOpts, o: { timeoutMs?: number } = {}): Promise<PrResult> {
  const timeout = o.timeoutMs ?? 60_000;
  const warning = settingsWarning(await ghAsync(repoDir, repoSettingsArgs, timeout));
  const existing = existingResult(await ghAsync(repoDir, listArgs(opts), timeout));
  if (existing) return withWarning(existing, warning);
  return withWarning(createdResult(await ghAsync(repoDir, createArgs(opts), timeout)), warning);
}

/** Squash-merges a PR and deletes its branch. Fails (without side effects) if checks/protections block it. */
export function squashMergePullRequest(repoDir: string, prUrl: string): PrResult {
  const r = gh(repoDir, "pr", "merge", prUrl, "--squash", "--delete-branch");
  return { ok: r.code === 0, url: prUrl, merged: r.code === 0, detail: r.out.trim() || "merged" };
}
