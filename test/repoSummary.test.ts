import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateRepoCaches, sortRepoSummaries, summarizeAllRepos, summarizeRepo } from "../src/git/repoSummary.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const opts = { mainBranch: "main", integrationBranch: "ai-work", ghCacheMs: 0 };

let root: string;
let projects: string;
let binDir: string;
let oldPath: string | undefined;

/** Creates `projects/<name>` cloned from a fresh bare origin with one commit on main. */
function makeRepo(name: string) {
  const origin = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(projects, name);
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "-u", "origin", "HEAD:main");
  git(repo, "fetch", "-q");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
  return { origin, repo };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-summary-"));
  projects = join(root, "projects");
  mkdirSync(projects);
  binDir = join(root, "bin");
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/bash
[ -n "$FAKE_GH_FAIL" ] && { echo "not logged in" >&2; exit 4; }
[ "$1 $2" = "pr list" ] && { echo "\${FAKE_GH_JSON:-[]}"; exit 0; }
exit 1
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
});
afterAll(() => {
  process.env.PATH = oldPath;
  delete process.env.FAKE_GH_FAIL;
  delete process.env.FAKE_GH_JSON;
  rmSync(root, { recursive: true, force: true });
});

describe("summarizeRepo", () => {
  it("reports a clean repo with lastCommit and branch config", async () => {
    makeRepo("clean");
    const s = await summarizeRepo(projects, "clean", opts);
    expect(s).toMatchObject({
      branch: "main",
      mainBranch: "main",
      integrationBranch: "ai-work",
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
      noUpstream: false,
      openBranches: [],
      mergedBranches: [],
      openPrs: [],
      ghAvailable: true,
      stashes: 0,
      attention: "clean",
      reasons: [],
    });
    expect(s.lastCommit).toMatchObject({ subject: "init" });
    expect(s.lastCommit?.sha).toBeTruthy();
  });

  it("counts uncommitted and untracked files as dirty", async () => {
    const { repo } = makeRepo("dirty");
    writeFileSync(join(repo, "a.txt"), "changed");
    writeFileSync(join(repo, "new.txt"), "x");
    const s = await summarizeRepo(projects, "dirty", opts);
    expect(s).toMatchObject({ dirty: true, changedFiles: 2, attention: "dirty", reasons: ["dirty"] });
  });

  it("detects behind after another clone pushes (fetches itself)", async () => {
    const { origin } = makeRepo("behind");
    const other = join(root, "behind-other");
    git(root, "clone", "-q", origin, other);
    writeFileSync(join(other, "b.txt"), "2");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "upstream work");
    git(other, "push", "-q", "origin", "main");
    const s = await summarizeRepo(projects, "behind", opts);
    expect(s).toMatchObject({ behind: 1, ahead: 0, attention: "behind", reasons: ["behind"] });
  });

  it("detects ahead", async () => {
    const { repo } = makeRepo("ahead");
    writeFileSync(join(repo, "c.txt"), "3");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "local");
    const s = await summarizeRepo(projects, "ahead", opts);
    expect(s).toMatchObject({ ahead: 1, behind: 0, attention: "ahead", reasons: ["ahead"] });
  });

  it("lists unmerged and merged local branches, excluding main, integration, and current from mergedBranches", async () => {
    const { repo } = makeRepo("branches");
    git(repo, "branch", "merged"); // same commit as main => fully merged
    git(repo, "branch", "ai-work"); // same commit as main => protected integration branch
    git(repo, "checkout", "-q", "-b", "feat/x");
    writeFileSync(join(repo, "d.txt"), "4");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "feature");
    const s = await summarizeRepo(projects, "branches", opts);
    expect(s.branch).toBe("feat/x");
    expect(s.openBranches).toEqual(["feat/x"]);
    expect(s.mergedBranches).toEqual(["merged"]);
    expect(s.reasons).toContain("branches");
    expect(s.noUpstream).toBe(true);
  });

  it("reports detached HEAD", async () => {
    const { repo } = makeRepo("detached");
    git(repo, "checkout", "-q", "--detach");
    expect((await summarizeRepo(projects, "detached", opts)).branch).toBe("(detached)");
  });

  it("lists open PRs from gh", async () => {
    makeRepo("prs");
    const pr = { number: 7, title: "Add thing", url: "https://github.com/o/r/pull/7", headRefName: "feat/x", baseRefName: "main", isDraft: false };
    process.env.FAKE_GH_JSON = JSON.stringify([pr]);
    try {
      const s = await summarizeRepo(projects, "prs", opts);
      expect(s.openPrs).toEqual([pr]);
      expect(s).toMatchObject({ ghAvailable: true, attention: "prs", reasons: ["prs"] });
    } finally {
      delete process.env.FAKE_GH_JSON;
    }
  });

  it("returns openPrs null (never throws) when gh fails", async () => {
    makeRepo("ghfail");
    process.env.FAKE_GH_FAIL = "1";
    try {
      const s = await summarizeRepo(projects, "ghfail", opts);
      expect(s).toMatchObject({ openPrs: null, ghAvailable: false, attention: "clean" });
    } finally {
      delete process.env.FAKE_GH_FAIL;
    }
  });

  it("caches gh results when a cache window is set", async () => {
    makeRepo("cached");
    const cached = { ...opts, ghCacheMs: 60_000 };
    process.env.FAKE_GH_JSON = "[]";
    expect((await summarizeRepo(projects, "cached", cached)).openPrs).toEqual([]);
    process.env.FAKE_GH_FAIL = "1";
    try {
      expect((await summarizeRepo(projects, "cached", cached)).openPrs).toEqual([]);
    } finally {
      delete process.env.FAKE_GH_FAIL;
      delete process.env.FAKE_GH_JSON;
    }
  });
});

describe("review regressions", () => {
  it("counts every file in an untracked directory, like the detail page", async () => {
    const { repo } = makeRepo("udir");
    mkdirSync(join(repo, "newdir"));
    writeFileSync(join(repo, "newdir", "a.txt"), "a");
    writeFileSync(join(repo, "newdir", "b.txt"), "b");
    expect((await summarizeRepo(projects, "udir", opts)).changedFiles).toBe(2);
  });

  it.each(["..", "../x", "a/b", ".hidden", "", "nope"])("rejects repo name %j like resolveRepo", async (name) => {
    await expect(summarizeRepo(projects, name, opts)).rejects.toThrow(/invalid repo name|repo not found/);
  });

  it("throttles git fetch per repo; refresh bypasses the throttle", async () => {
    const { origin } = makeRepo("throttle");
    const ttl = { ...opts, fetchTtlMs: 60_000 };
    expect((await summarizeRepo(projects, "throttle", ttl)).behind).toBe(0); // fetches (first time)
    const other = join(root, "throttle-other");
    git(root, "clone", "-q", origin, other);
    writeFileSync(join(other, "b.txt"), "2");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "upstream work");
    git(other, "push", "-q", "origin", "main");
    expect((await summarizeRepo(projects, "throttle", ttl)).behind).toBe(0); // within the TTL: no fetch
    expect((await summarizeRepo(projects, "throttle", { ...ttl, refresh: true })).behind).toBe(1);
  });

  it("re-queries gh after invalidateRepoCaches or with refresh", async () => {
    makeRepo("inval");
    const cached = { ...opts, ghCacheMs: 60_000 };
    const pr = { number: 3, title: "New", url: "https://github.com/o/r/pull/3", headRefName: "f", baseRefName: "main", isDraft: false };
    try {
      process.env.FAKE_GH_JSON = "[]";
      expect((await summarizeRepo(projects, "inval", cached)).openPrs).toEqual([]);
      process.env.FAKE_GH_JSON = JSON.stringify([pr]);
      expect((await summarizeRepo(projects, "inval", cached)).openPrs).toEqual([]); // cached
      expect((await summarizeRepo(projects, "inval", { ...cached, refresh: true })).openPrs).toEqual([pr]);
      process.env.FAKE_GH_JSON = "[]";
      invalidateRepoCaches(join(projects, "inval"));
      expect((await summarizeRepo(projects, "inval", cached)).openPrs).toEqual([]);
    } finally {
      delete process.env.FAKE_GH_JSON;
    }
  });
});

describe("summarizeAllRepos", () => {
  it("discovers repos and sorts attention-needing ones first", async () => {
    const all = await summarizeAllRepos(projects, opts);
    const names = all.map((r) => r.name);
    expect(names.length).toBeGreaterThan(3);
    const firstClean = all.findIndex((r) => r.reasons.length === 0);
    expect(all.slice(firstClean).every((r) => r.reasons.length === 0)).toBe(true);
    expect(names.indexOf("clean")).toBeGreaterThanOrEqual(firstClean);
  });

  it("skips hidden, non-repo and invalidly named directories", async () => {
    mkdirSync(join(projects, "not-a-repo"));
    mkdirSync(join(projects, ".hidden-repo", ".git"), { recursive: true });
    const names = (await summarizeAllRepos(projects, opts)).map((r) => r.name);
    expect(names).not.toContain("not-a-repo");
    expect(names).not.toContain(".hidden-repo");
    expect(names).toContain("clean");
  });
});

describe("sortRepoSummaries", () => {
  const r = (name: string, reasons: string[]) => ({ name, reasons });
  it("puts more reasons first, then name, with clean repos last by name", () => {
    const sorted = sortRepoSummaries([
      r("zeta", []),
      r("beta", ["dirty"]),
      r("alpha", []),
      r("gamma", ["dirty", "behind"]),
      r("able", ["prs"]),
    ]);
    expect(sorted.map((x) => x.name)).toEqual(["gamma", "able", "beta", "alpha", "zeta"]);
  });

  it("does not mutate its input", () => {
    const input = [r("b", []), r("a", ["dirty"])];
    sortRepoSummaries(input);
    expect(input.map((x) => x.name)).toEqual(["b", "a"]);
  });
});
