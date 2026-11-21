import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResolveSteps, describeConflict, parseUnmerged, previewMerge } from "../src/git/conflicts.js";
import { handleRepoRoute } from "../src/git/repoActions.js";
import { summarizeRepo } from "../src/git/repoSummary.js";
import { checkRepoDrift, DriftParams, summarizeDrift } from "../src/jobs/gitDriftCheck.js";
import type { TaskRecord } from "../src/state/forgeState.js";
import { runningTaskIds } from "../src/worker/taskStore.js";

vi.setConfig({ testTimeout: 30_000 });

const AUTHOR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let root: string;
let projects: string;
let n = 0;

/** projects/<name> cloned from a bare origin, with `main` pushed. `ai-work` is branched off but not yet diverged. */
function makeRepo(files: Record<string, string>) {
  const name = `r${++n}`;
  const origin = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(projects, name);
  git(root, "clone", "-q", origin, repo);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  git(repo, "push", "-q", "-u", "origin", "HEAD:main");
  git(repo, "checkout", "-q", "-b", "ai-work");
  git(repo, "push", "-q", "-u", "origin", "ai-work");
  return { name, origin, repo };
}

/** Someone else commits to origin/main from a second clone. */
function pushToMain(origin: string, files: Record<string, string | null>) {
  const dir = mkdtempSync(join(root, "other-"));
  git(root, "clone", "-q", origin, dir);
  for (const [f, c] of Object.entries(files)) {
    if (c === null) git(dir, "rm", "-q", f);
    else writeFileSync(join(dir, f), c);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "main change");
  git(dir, "push", "-q", "origin", "main");
}

function commitOnBranch(repo: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "branch change");
}

const fingerprint = (repo: string) =>
  [git(repo, "status", "--porcelain=v1"), git(repo, "rev-parse", "HEAD", "refs/heads/ai-work", "refs/remotes/origin/main"), createHash("sha1").update(readFileSync(join(repo, ".git", "index"))).digest("hex")].join("|");

const BASE = { "both.txt": "a\nb\nc\nd\ne\nf\n", "conf.txt": "x\n", "gone.txt": "del\n", "keep.txt": "k\n" };

const cfg = (activeTasks?: (dir: string) => string[]) => ({ projectsRoot: projects, mainBranch: "main", integrationBranch: "ai-work", model: "m", activeTasks });
const call = (name: string, action: string, body: Record<string, unknown> = {}, c = cfg()) =>
  handleRepoRoute(c, { method: "POST", name, action, query: new URLSearchParams(), body });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "git-conflicts-"));
  projects = join(root, "projects");
  mkdirSync(projects);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("previewMerge", () => {
  it("reports non-overlapping edits to the same file as clean, and touches nothing", async () => {
    const { origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "both.txt": "A\nb\nc\nd\ne\nf\n" });
    pushToMain(origin, { "both.txt": "a\nb\nc\nd\ne\nF\n" });
    git(repo, "fetch", "-q");
    const before = fingerprint(repo);
    const p = await previewMerge(repo, "refs/heads/ai-work", "refs/remotes/origin/main");
    expect(p).toMatchObject({ status: "clean", conflictFiles: [], behind: 1, ahead: 1 });
    expect(fingerprint(repo)).toBe(before);
  });

  it("finds overlapping edits and modify/delete conflicts", async () => {
    const { origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "conf.txt": "ours\n", "gone.txt": "changed\n", "newfile.txt": "n\n" });
    pushToMain(origin, { "conf.txt": "theirs\n", "gone.txt": null, "other.txt": "o\n" });
    git(repo, "fetch", "-q");
    const before = fingerprint(repo);
    const p = await previewMerge(repo, "refs/heads/ai-work", "refs/remotes/origin/main");
    expect(p.status).toBe("conflicts");
    expect(p.conflictFiles).toEqual(["conf.txt", "gone.txt"]);
    expect(fingerprint(repo)).toBe(before);
  });

  it("matches what a real merge does", async () => {
    const { origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "conf.txt": "ours\n" });
    pushToMain(origin, { "conf.txt": "theirs\n" });
    git(repo, "fetch", "-q");
    const p = await previewMerge(repo, "refs/heads/ai-work", "refs/remotes/origin/main");
    expect(() => git(repo, "merge", "--no-edit", "origin/main")).toThrow();
    const real = git(repo, "diff", "--name-only", "--diff-filter=U").trim().split("\n");
    git(repo, "merge", "--abort");
    expect(p.conflictFiles).toEqual(real);
  });

  it("is up-to-date when the branch already contains the target, and unknown for a missing ref", async () => {
    const { repo } = makeRepo(BASE);
    expect((await previewMerge(repo, "refs/heads/ai-work", "refs/remotes/origin/main")).status).toBe("up-to-date");
    const missing = await previewMerge(repo, "refs/heads/ai-work", "refs/remotes/origin/nope");
    expect(missing.status).toBe("unknown");
    expect(missing.reason).toMatch(/does not exist/);
  });
});

describe("pure helpers", () => {
  it("parses ls-files -u output", () => {
    // NB: "\u0000", not "\0": a "\0" followed by a digit would be read as an octal escape.
    const out = ["100644 aaa 1\ta.txt", "100644 bbb 2\ta.txt", "100644 ccc 3\ta.txt", "100644 ddd 2\tonly ours.txt", ""].join("\u0000");
    const m = parseUnmerged(out);
    expect(m.get("a.txt")).toEqual({ 1: { mode: "100644", sha: "aaa" }, 2: { mode: "100644", sha: "bbb" }, 3: { mode: "100644", sha: "ccc" } });
    expect(m.get("only ours.txt")).toEqual({ 2: { mode: "100644", sha: "ddd" } });
  });

  it("builds steps naming the branch, main and files", () => {
    const steps = buildResolveSteps("ai-work", "main", ["a.txt", "b.txt"]).join("\n");
    expect(steps).toContain("git checkout ai-work");
    expect(steps).toContain("git merge origin/main");
    expect(steps).toContain("git push origin ai-work");
    expect(steps).toContain("a.txt, b.txt");
    expect(describeConflict("ai-work", "main", ["a.txt"])).toMatch(/^1 file conflict: a\.txt\./);
  });
});

describe("sync-preview and sync-main", () => {
  it("previews a conflict without changing the repo, then sync-main reports files and steps", async () => {
    const { name, origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "conf.txt": "ours\n" });
    git(repo, "push", "-q", "origin", "ai-work");
    pushToMain(origin, { "conf.txt": "theirs\n" });
    const headBefore = git(repo, "rev-parse", "HEAD").trim();

    const prev = await call(name, "sync-preview");
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ ok: true, status: "conflicts", conflictFiles: ["conf.txt"], behind: 1, ahead: 1 });
    expect((prev.body as { resolveSteps: string[] }).resolveSteps.join("\n")).toContain("git merge origin/main");
    expect((prev.body as { detail: string }).detail).toContain("would conflict");
    // The preview fetches (remote refs move) but never touches the working tree, index or branch.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);

    const sync = await call(name, "sync-main");
    expect(sync.status).toBe(400);
    expect(sync.body).toMatchObject({ ok: false, conflict: true, conflictFiles: ["conf.txt"] });
    expect((sync.body as { detail: string }).detail).toContain("git merge origin/main");
    expect(git(repo, "status", "--porcelain")).toBe(""); // merge aborted
    expect(() => git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
  });

  it("previews a clean merge and sync-main then pushes it", async () => {
    const { name, origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "keep.txt": "mine\n" });
    git(repo, "push", "-q", "origin", "ai-work");
    pushToMain(origin, { "both.txt": "A\nb\nc\nd\ne\nf\n" });
    const prev = await call(name, "sync-preview");
    expect(prev.body).toMatchObject({ ok: true, status: "clean", conflictFiles: [] });
    const sync = await call(name, "sync-main");
    expect(sync.body).toMatchObject({ ok: true, pushed: true });
  });

  it("refuses to preview on main", async () => {
    const { name, repo } = makeRepo(BASE);
    git(repo, "checkout", "-q", "main");
    const r = await call(name, "sync-preview");
    expect(r.status).toBe(400);
  });
});

describe("agent-busy guard", () => {
  it("blocks push and sync on the integration branch while a task runs, unless overridden", async () => {
    const { name, origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "keep.txt": "mine\n" });
    const busy = cfg(() => ["t-1"]);

    const push = await call(name, "push", {}, busy);
    expect(push.status).toBe(409);
    expect((push.body as { detail: string }).detail).toContain("t-1");

    pushToMain(origin, { "both.txt": "A\nb\nc\nd\ne\nf\n" });
    const sync = await call(name, "sync-main", {}, busy);
    expect(sync.status).toBe(409);

    const forced = await call(name, "push", { allowWhileBusy: true }, busy);
    expect(forced.body).toMatchObject({ ok: true, pushed: true });
  });

  it("does not block other branches or idle repos", async () => {
    const { name, repo } = makeRepo(BASE);
    git(repo, "checkout", "-q", "-b", "feature");
    commitOnBranch(repo, { "keep.txt": "mine\n" });
    expect((await call(name, "push", {}, cfg(() => ["t-1"]))).body).toMatchObject({ ok: true });
    git(repo, "checkout", "-q", "ai-work");
    commitOnBranch(repo, { "keep.txt": "again\n" });
    expect((await call(name, "push", {}, cfg(() => []))).body).toMatchObject({ ok: true });
  });
});

describe("summary: drift from main and busy", () => {
  it("adds counts, conflict files, a conflicts reason and the busy task ids", async () => {
    const { name, origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "conf.txt": "ours\n" });
    git(repo, "push", "-q", "origin", "ai-work");
    pushToMain(origin, { "conf.txt": "theirs\n" });
    git(repo, "fetch", "-q");
    const s = await summarizeRepo(projects, name, { mainBranch: "main", integrationBranch: "ai-work", fetchTtlMs: 0, ghCacheMs: 0, activeTasks: () => ["t-9"] });
    expect(s).toMatchObject({ behindMain: 1, aheadOfMain: 1, mainConflicts: ["conf.txt"], agentBusy: ["t-9"], attention: "conflicts" });
    expect(s.reasons).toContain("conflicts");
  });

  it("stays clean when main is simply ahead without conflicts, and on main itself", async () => {
    const { name, origin, repo } = makeRepo(BASE);
    commitOnBranch(repo, { "keep.txt": "mine\n" });
    git(repo, "push", "-q", "origin", "ai-work");
    pushToMain(origin, { "both.txt": "A\nb\nc\nd\ne\nf\n" });
    git(repo, "fetch", "-q");
    const s = await summarizeRepo(projects, name, { mainBranch: "main", integrationBranch: "ai-work", fetchTtlMs: 0, ghCacheMs: 0 });
    expect(s).toMatchObject({ behindMain: 1, mainConflicts: [], agentBusy: [] });
    expect(s.reasons).not.toContain("conflicts");
    git(repo, "checkout", "-q", "main");
    const onMain = await summarizeRepo(projects, name, { mainBranch: "main", integrationBranch: "ai-work", fetchTtlMs: 0, ghCacheMs: 0 });
    expect(onMain).toMatchObject({ behindMain: 0, aheadOfMain: 0, mainConflicts: [] });
  });
});

describe("git drift job", () => {
  it("checks origin/<integration> against origin/<main> and summarises findings", async () => {
    const bad = makeRepo(BASE);
    commitOnBranch(bad.repo, { "conf.txt": "ours\n" });
    git(bad.repo, "push", "-q", "origin", "ai-work");
    pushToMain(bad.origin, { "conf.txt": "theirs\n" });
    const ok = makeRepo(BASE);
    const params = DriftParams.parse({});
    const ctl = new AbortController();
    const rBad = await checkRepoDrift(bad.repo, bad.name, params, ctl.signal);
    const rOk = await checkRepoDrift(ok.repo, ok.name, params, ctl.signal);
    expect(rBad).toMatchObject({ status: "conflicts", conflictFiles: ["conf.txt"], behindMain: 1 });
    expect(rOk.status).toBe("up-to-date");
    const sum = summarizeDrift([rBad, rOk], params);
    expect(sum.findings).toBe(true);
    expect(sum.summary).toContain(`${bad.name}: 1 file`);
    expect(summarizeDrift([rOk], params)).toMatchObject({ findings: false });
    // Nothing compared must never read as "no conflicts".
    const none = summarizeDrift([{ repo: "x", status: "skipped", behindMain: 0, aheadOfMain: 0, conflictFiles: [], note: "no origin" }], params);
    expect(none.summary).toContain("nothing compared");
    expect(none.summary).not.toContain("no conflicts");
  });
});

describe("runningTaskIds", () => {
  it("returns only fresh running tasks for that repo", () => {
    const state = mkdtempSync(join(root, "state-"));
    const repoA = join(projects, "ta");
    const repoB = join(projects, "tb");
    mkdirSync(repoA);
    mkdirSync(repoB);
    const now = Date.now();
    const rec = (id: string, repoDir: string, status: TaskRecord["status"], ageMs: number): TaskRecord => ({
      id,
      repoDir,
      prompt: "p",
      complexity: "normal",
      status,
      startedAt: new Date(now - ageMs).toISOString(),
      merged: false,
      attempts: [],
    });
    writeFileSync(
      join(state, "tasks.json"),
      JSON.stringify([rec("run", repoA, "running", 1000), rec("done", repoA, "passed", 1000), rec("other", repoB, "running", 1000), rec("stale", repoA, "running", 7 * 3600 * 1000)]),
    );
    expect(runningTaskIds(state, repoA, now)).toEqual(["run"]);
    expect(runningTaskIds(state, join(projects, "none"), now)).toEqual([]);
  });
});
