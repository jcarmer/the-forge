import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepos } from "../src/packages/hub.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });

let root: string;
let repo: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repos-"));
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  repo = join(root, "projects", "app");
  mkdirSync(join(root, "projects"));
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "-u", "origin", "HEAD:main");
  git(repo, "fetch", "-q");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const status = async () => (await scanRepos(join(root, "projects")))[0];

describe("repo status", () => {
  it("is clean when everything is on the remote", async () => {
    expect(await status()).toMatchObject({ dirty: false, unpushed: false, noUpstream: false, stashes: 0, localOnlyCommits: 0 });
  });

  it("treats a never-pushed branch as pending even with no new commits", async () => {
    git(repo, "checkout", "-q", "-b", "feat/new");
    expect(await status()).toMatchObject({ noUpstream: true, unpushed: true, ahead: 0 });
  });

  it("counts commits on a never-pushed branch", async () => {
    writeFileSync(join(repo, "b.txt"), "2");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "work");
    expect(await status()).toMatchObject({ noUpstream: true, unpushed: true, ahead: 1, localOnlyCommits: 1 });
  });

  it("is clean again after publishing the branch", async () => {
    git(repo, "push", "-q", "-u", "origin", "feat/new");
    expect(await status()).toMatchObject({ noUpstream: false, unpushed: false, ahead: 0, localOnlyCommits: 0 });
  });

  it("reports unpushed commits left on another branch", async () => {
    writeFileSync(join(repo, "c.txt"), "3");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "more");
    git(repo, "checkout", "-q", "main");
    expect(await status()).toMatchObject({ unpushed: true, ahead: 0, localOnlyCommits: 1 });
  });

  it("reports stashes and uncommitted files", async () => {
    writeFileSync(join(repo, "a.txt"), "changed");
    git(repo, "stash", "-q");
    expect((await status()).stashes).toBe(1);
    writeFileSync(join(repo, "untracked.txt"), "x");
    expect((await status()).dirty).toBe(true);
  });
});
