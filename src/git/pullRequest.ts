import { run } from "../ops.js";

export interface PrResult {
  ok: boolean;
  /** URL of the created (or already-open) pull request. */
  url?: string;
  /** True when the PR was also merged. */
  merged?: boolean;
  detail: string;
}

const URL_RE = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/;

function gh(repoDir: string, ...args: string[]) {
  return run("gh", args, { cwd: repoDir });
}

/** Cheap check that `gh` is installed and authenticated (via GH_TOKEN or a login). */
export function ghAvailable(repoDir = process.cwd()): { ok: boolean; detail: string } {
  const r = gh(repoDir, "auth", "status");
  if (r.missing) return { ok: false, detail: "gh is not installed (rebuild the image: sandboxctl rebuild)" };
  return { ok: r.code === 0, detail: r.code === 0 ? "authenticated" : r.out.trim().split("\n")[0] || "not authenticated" };
}

/**
 * Opens a PR `head` -> `base`, or returns the existing open one (so retries are idempotent).
 * Never force-pushes, never edits branches: it only talks to the GitHub API via `gh`.
 */
export function openPullRequest(
  repoDir: string,
  opts: { head: string; base: string; title: string; body: string; draft?: boolean },
): PrResult {
  const existing = gh(repoDir, "pr", "list", "--head", opts.head, "--base", opts.base, "--state", "open", "--json", "url", "--jq", ".[0].url");
  if (existing.missing) return { ok: false, detail: "gh is not installed" };
  const found = existing.out.match(URL_RE)?.[0];
  if (existing.code === 0 && found) return { ok: true, url: found, detail: "pull request already open" };

  const args = ["pr", "create", "--head", opts.head, "--base", opts.base, "--title", opts.title, "--body", opts.body];
  if (opts.draft) args.push("--draft");
  const created = gh(repoDir, ...args);
  const url = created.out.match(URL_RE)?.[0];
  if (created.code !== 0 || !url) return { ok: false, detail: created.out.trim() || "gh pr create failed" };
  return { ok: true, url, detail: "pull request opened" };
}

/** Squash-merges a PR and deletes its branch. Fails (without side effects) if checks/protections block it. */
export function squashMergePullRequest(repoDir: string, prUrl: string): PrResult {
  const r = gh(repoDir, "pr", "merge", prUrl, "--squash", "--delete-branch");
  return { ok: r.code === 0, url: prUrl, merged: r.code === 0, detail: r.out.trim() || "merged" };
}
