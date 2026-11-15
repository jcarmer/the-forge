import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAiCache,
  draftMessage,
  type Fetcher,
  getChanges,
  getFileDiff,
  handleRepoRoute,
  normalizeRemoteUrl,
  redact,
  summarizeChanges,
} from "../src/git/repoActions.js";
import { createForgeRequestHandler } from "../src/web-api/server.js";

vi.setConfig({ testTimeout: 30_000 });

const AUTHOR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...AUTHOR }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let root: string;
let projects: string;
let binDir: string;
const saved: Record<string, string | undefined> = {};

/** `projects/<name>` cloned from a fresh bare origin, one commit on main tracking origin/main. */
function makeRepo(name: string, files: Record<string, string> = { "a.txt": "one\n", "b.txt": "two\n" }) {
  const origin = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const repo = join(projects, name);
  git(root, "clone", "-q", origin, repo);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(repo, f), c);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "-u", "origin", "HEAD:main");
  git(repo, "fetch", "-q");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
  return { origin, repo };
}

/** A second working clone of `origin` (outside projects), for simulating someone else pushing. */
function otherClone(origin: string, name: string) {
  const dir = join(root, `other-${name}`);
  git(root, "clone", "-q", origin, dir);
  return dir;
}

const cfg = (fetchImpl?: Fetcher) => ({ projectsRoot: projects, mainBranch: "main", integrationBranch: "ai-work", model: "qwen-test", fetchImpl });
const call = (name: string, action: string, body: Record<string, unknown> = {}, method?: string, query = "") =>
  handleRepoRoute(cfg(), {
    method: method ?? (["changes", "diff", "branches", "stashes", "links"].includes(action) ? "GET" : "POST"),
    name,
    action,
    query: new URLSearchParams(query),
    body,
  });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repo-actions-"));
  projects = join(root, "projects");
  mkdirSync(projects);
  binDir = join(root, "bin");
  mkdirSync(binDir);
  // Fake gh: `pr create` records a PR in $FAKE_GH_STATE; `pr list` reports it (raw URL with --jq, else JSON).
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/bash
state="$FAKE_GH_STATE"
jq=0; for a in "$@"; do [ "$a" = "--jq" ] && jq=1; done
case "$1 $2" in
  "repo edit") exit 1;;
  "pr list")
    if [ -f "$state" ]; then u=$(cat "$state"); if [ $jq = 1 ]; then echo "$u"; else echo "[{\\"url\\":\\"$u\\"}]"; fi
    else [ $jq = 1 ] || echo "[]"; fi; exit 0;;
  "pr create") echo "https://github.com/o/r/pull/9" > "$state"; echo "$*" >> "$state.creates"; echo "https://github.com/o/r/pull/9"; exit 0;;
  "pr merge")
    echo "$*" >> "$state.merges"
    rm -f "$state"
    echo "https://github.com/o/r/pull/9"; exit 0;;
esac
exit 1
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  for (const k of ["PATH", "FAKE_GH_STATE", ...Object.keys(AUTHOR)]) saved[k] = process.env[k];
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  process.env.FAKE_GH_STATE = join(root, "gh-state");
  Object.assign(process.env, AUTHOR);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("repo resolution and path safety", () => {
  beforeAll(() => makeRepo("safe"));

  it.each(["..", "../safe", "safe/..", "a/b", "a\\b", ".git", ".hidden", "", "x\0y", "%2e%2e"])("rejects repo name %j", async (name) => {
    const r = await call(name, "changes");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false });
  });

  it("404s for an unknown repo and a non-repo directory", async () => {
    mkdirSync(join(projects, "plain-dir"));
    expect((await call("nope", "changes")).status).toBe(404);
    expect((await call("plain-dir", "changes")).status).toBe(404);
  });

  it.each(["../safe/a.txt", "../../etc/passwd", "/etc/passwd", ".git/config", "a/../../x", "C:/x", "..\\x"])("rejects file path %j", async (p) => {
    writeFileSync(join(projects, "safe", "a.txt"), "dirty\n");
    expect((await call("safe", "diff", {}, "GET", `path=${encodeURIComponent(p)}`)).status).toBe(400);
    expect((await call("safe", "stage", { files: [p] })).status).toBe(400);
    expect((await call("safe", "discard", { confirm: "DISCARD safe", files: [p], includeUntracked: true })).status).toBe(400);
    expect((await call("safe", "commit-push", { message: "x", files: [p] })).status).toBe(400);
  });

  it("rejects a real but unchanged file (only changed paths are accepted)", async () => {
    const r = await call("safe", "diff", {}, "GET", "path=b.txt");
    expect(r).toMatchObject({ status: 400, body: { detail: "not a changed file: b.txt" } });
  });

  it("rejects wrong methods, unknown actions and non-array files", async () => {
    expect((await call("safe", "discard", {}, "GET")).status).toBe(405);
    expect((await call("safe", "rm-rf")).status).toBe(404);
    expect((await call("safe", "stage", { files: "a.txt" })).status).toBe(400);
    expect((await call("safe", "stage", { files: [] })).status).toBe(400);
  });
});

describe("over HTTP", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    makeRepo("web");
    const ctx = {
      manifest: { git: { mainBranch: "main", integrationBranch: "ai-work" }, ollama: { primaryModel: "qwen-test" } },
      projectsRoot: projects,
      stateDir: root,
      webDistDir: join(root, "no-dist"),
      services: {},
    };
    server = createServer(createForgeRequestHandler(ctx as never, {} as never));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const raw = (method: string, path: string, body?: string) =>
    new Promise<{ status: number; json: Record<string, unknown> }>((res, rej) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        r.on("end", () => res({ status: r.statusCode ?? 0, json: JSON.parse(data || "{}") as Record<string, unknown> }));
      });
      req.on("error", rej);
      if (body !== undefined) req.write(body);
      req.end();
    });

  it("rejects an encoded-slash traversal in the repo name", async () => {
    expect((await raw("GET", "/api/git/repo/..%2F..%2Fetc/changes")).status).toBe(400);
    expect((await raw("GET", "/api/git/repo/web%2F..%2Fweb/changes")).status).toBe(400);
  });

  it("refuses discard without the exact confirm string and leaves the file alone", async () => {
    writeFileSync(join(projects, "web", "a.txt"), "edited\n");
    for (const confirm of [undefined, "DISCARD", "discard web", "DISCARD other", "DISCARD web "]) {
      const r = await raw("POST", "/api/git/repo/web/discard", JSON.stringify({ confirm }));
      expect(r.status).toBe(400);
    }
    expect(readFileSync(join(projects, "web", "a.txt"), "utf8")).toBe("edited\n");
  });

  it("returns 400 (not 500) for malformed JSON", async () => {
    expect((await raw("POST", "/api/git/repo/web/stage", "{not json")).status).toBe(400);
    expect((await raw("POST", "/api/git/repo/web/stage", "[1,2]")).status).toBe(400);
  });

  it("summarises a single validated repo via /api/git/repos?repo=", async () => {
    const one = await raw("GET", "/api/git/repos?repo=web");
    expect(one.status).toBe(200);
    expect((one.json.repos as { name: string }[]).map((r) => r.name)).toEqual(["web"]);
    expect((await raw("GET", "/api/git/repos?repo=..%2Fweb")).status).toBe(400);
    expect((await raw("GET", "/api/git/repos?repo=nope&refresh=1")).status).toBe(404);
  });

  it("serves changes", async () => {
    const r = await raw("GET", "/api/git/repo/web/changes");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ branch: "main", files: [{ path: "a.txt", status: "M" }] });
  });
});

describe("changes and diff", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("chg"));
    writeFileSync(join(repo, "a.txt"), "one\nmore\n");
    writeFileSync(join(repo, "new.txt"), "x\ny\nz");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([1, 0, 2, 3]));
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "deep.txt"), "deep\n");
    git(repo, "mv", "b.txt", "renamed.txt");
    git(repo, "rm", "-q", "--cached", "a.txt");
    git(repo, "add", "a.txt");
  });

  it("lists staged, unstaged, renamed, untracked and binary files with line counts", async () => {
    const { branch, files } = await getChanges(repo);
    expect(branch).toBe("main");
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["a.txt"]).toMatchObject({ status: "M", staged: true, additions: 1, deletions: 0, binary: false });
    expect(by["renamed.txt"]).toMatchObject({ status: "R", oldPath: "b.txt", staged: true });
    expect(by["new.txt"]).toMatchObject({ status: "?", staged: false, additions: 3, binary: false });
    expect(by["bin.dat"]).toMatchObject({ status: "?", binary: true, additions: 0 });
    expect(by["sub/deep.txt"]).toMatchObject({ status: "?", additions: 1 });
  });

  it("diffs a tracked file vs HEAD and an untracked file vs /dev/null", async () => {
    const tracked = await getFileDiff(repo, "a.txt");
    expect(tracked).toMatchObject({ path: "a.txt", truncated: false });
    expect(tracked.diff).toContain("+more");
    const untracked = await getFileDiff(repo, "new.txt");
    expect(untracked.diff).toContain("--- /dev/null");
    expect(untracked.diff).toContain("+x");
    expect((await getFileDiff(repo, "bin.dat")).diff).toMatch(/Binary files/);
  });

  it("truncates very large diffs", async () => {
    writeFileSync(join(repo, "big.txt"), "line of text\n".repeat(30_000));
    const d = await getFileDiff(repo, "big.txt");
    expect(d.truncated).toBe(true);
    expect(d.diff.length).toBeLessThanOrEqual(200_000);
  });
});

describe("stage / unstage / commit-push", () => {
  let repo: string;
  let origin: string;
  beforeAll(() => {
    ({ repo, origin } = makeRepo("cp"));
  });

  it("stages and unstages single files", async () => {
    writeFileSync(join(repo, "a.txt"), "A\n");
    writeFileSync(join(repo, "b.txt"), "B\n");
    expect((await call("cp", "stage", { files: ["a.txt"] })).status).toBe(200);
    let by = Object.fromEntries((await getChanges(repo)).files.map((f) => [f.path, f]));
    expect(by["a.txt"].staged).toBe(true);
    expect(by["b.txt"].staged).toBe(false);
    expect((await call("cp", "unstage", { files: ["a.txt"] })).status).toBe(200);
    by = Object.fromEntries((await getChanges(repo)).files.map((f) => [f.path, f]));
    expect(by["a.txt"].staged).toBe(false);
  });

  it("refuses an empty message", async () => {
    expect((await call("cp", "commit-push", { message: "  " })).status).toBe(400);
  });

  it("commits only the given files and pushes with -u on a branch with no upstream", async () => {
    git(repo, "checkout", "-q", "-b", "feat/x");
    git(repo, "add", "b.txt"); // pre-staged but NOT selected: must stay out of the commit
    writeFileSync(join(repo, "c.txt"), "C\n");
    const r = await call("cp", "commit-push", { message: "subset", files: ["a.txt", "c.txt"] });
    expect(r).toMatchObject({ status: 200, body: { ok: true, pushed: true } });
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["a.txt", "c.txt"]);
    expect(git(repo, "rev-parse", "--abbrev-ref", "feat/x@{u}").trim()).toBe("origin/feat/x");
    expect(git(origin, "rev-parse", "feat/x").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect((await getChanges(repo)).files.map((f) => f.path)).toEqual(["b.txt"]);
  });

  it("commits everything without a file list and pushes to the existing upstream", async () => {
    writeFileSync(join(repo, "d.txt"), "D\n");
    const r = await call("cp", "commit-push", { message: "all" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, pushed: true } });
    expect((await getChanges(repo)).files).toEqual([]);
    expect(git(origin, "rev-parse", "feat/x").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("refuses when there is nothing to commit", async () => {
    expect(await call("cp", "commit-push", { message: "again" })).toMatchObject({ status: 400, body: { detail: "nothing to commit" } });
  });
});

describe("create-pr", () => {
  beforeAll(() => {
    const { repo } = makeRepo("pr");
    git(repo, "checkout", "-q", "-b", "feat/pr");
    writeFileSync(join(repo, "f.txt"), "f\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "f");
  });

  it("refuses head === base and invalid branch names", async () => {
    expect((await call("pr", "create-pr", { title: "t", head: "main", base: "main" })).status).toBe(400);
    expect((await call("pr", "create-pr", { title: "t", base: "feat/pr" })).status).toBe(400);
    expect((await call("pr", "create-pr", { title: "t", base: "bad..name" })).status).toBe(400);
    expect((await call("pr", "create-pr", { title: "t", base: "--force" })).status).toBe(400);
    expect((await call("pr", "create-pr", { title: "" })).status).toBe(400);
  });

  it("pushes the branch and opens a PR once (idempotent)", async () => {
    const a = await call("pr", "create-pr", { title: "My PR", body: "b", draft: true });
    expect(a).toMatchObject({ status: 200, body: { ok: true, url: "https://github.com/o/r/pull/9", pushed: true } });
    expect(git(join(root, "pr.git"), "rev-parse", "--verify", "feat/pr").trim()).toBeTruthy();
    const b = await call("pr", "create-pr", { title: "My PR" });
    expect(b).toMatchObject({ status: 200, body: { ok: true, url: "https://github.com/o/r/pull/9", detail: "pull request already open" } });
    const creates = readFileSync(`${process.env.FAKE_GH_STATE}.creates`, "utf8").trim().split("\n");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--draft");
    expect(creates[0]).toContain("--base main");
  });
});

describe("commit-pr (new branch from main)", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("cpr"));
    writeFileSync(join(repo, "keep.txt"), "keep\n");
    writeFileSync(join(repo, "ship.txt"), "ship\n");
  });
  const body = { branch: "feature/ship", message: "add ship", title: "Add ship", files: ["ship.txt"] };

  it("validates before touching anything", async () => {
    expect((await call("cpr", "commit-pr", { ...body, branch: "main" })).status).toBe(400);
    expect((await call("cpr", "commit-pr", { ...body, branch: "bad..name" })).status).toBe(400);
    expect((await call("cpr", "commit-pr", { ...body, message: "" })).status).toBe(400);
    expect((await call("cpr", "commit-pr", { ...body, files: ["nope.txt"] })).status).toBe(400);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
  });

  it("commits only the chosen files to a new branch, opens the PR and returns to main", async () => {
    const r = await call("cpr", "commit-pr", body);
    expect(r).toMatchObject({ status: 200, body: { ok: true, url: "https://github.com/o/r/pull/9", committed: true } });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(repo, "ls-tree", "--name-only", "feature/ship").split("\n")).toContain("ship.txt");
    expect(git(repo, "ls-tree", "--name-only", "feature/ship").split("\n")).not.toContain("keep.txt");
    expect(git(repo, "ls-tree", "--name-only", "main").split("\n")).not.toContain("ship.txt");
    expect(git(repo, "status", "--porcelain")).toContain("keep.txt");
    expect(git(join(root, "cpr.git"), "rev-parse", "--verify", "feature/ship").trim()).toBeTruthy();
  });

  it("refuses a branch name that already exists", async () => {
    expect((await call("cpr", "commit-pr", body)).status).toBe(400);
  });
});

describe("discard", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("dis"));
  });

  it("requires the exact confirm string", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    for (const confirm of [undefined, "", "DISCARD", "DISCARD dis2", "discard dis"]) {
      expect((await call("dis", "discard", { confirm })).status).toBe(400);
    }
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("discards only the listed files (staged and unstaged)", async () => {
    writeFileSync(join(repo, "b.txt"), "changed b\n");
    git(repo, "add", "b.txt");
    const r = await call("dis", "discard", { confirm: "DISCARD dis", files: ["b.txt"] });
    expect(r).toMatchObject({ status: 200, body: { ok: true, discarded: ["b.txt"] } });
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("whole-repo discard keeps untracked files unless includeUntracked", async () => {
    writeFileSync(join(repo, "u.txt"), "untracked\n");
    const r = await call("dis", "discard", { confirm: "DISCARD dis" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, discarded: ["a.txt"], skippedUntracked: ["u.txt"] } });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(repo, "u.txt"))).toBe(true);
  });

  it("whole-repo discard with untracked files returns a usable recoveryRef", async () => {
    writeFileSync(join(repo, "a.txt"), "precious edit\n");
    writeFileSync(join(repo, "b.txt"), "staged edit\n");
    git(repo, "add", "b.txt");
    mkdirSync(join(repo, "newdir"));
    writeFileSync(join(repo, "newdir", "n.txt"), "new\n");
    const stashesBefore = git(repo, "stash", "list");
    const r = await call("dis", "discard", { confirm: "DISCARD dis", includeUntracked: true });
    const body = r.body as { ok: boolean; recoveryRef: string; detail: string; discarded: string[] };
    expect(r.status).toBe(200);
    expect(body.recoveryRef).toMatch(/^[0-9a-f]{40}$/);
    expect(body.detail).toContain(`git stash apply ${body.recoveryRef}`);
    expect(body.discarded.sort()).toEqual(["a.txt", "b.txt", "newdir/n.txt", "u.txt"]);
    expect((await getChanges(repo)).files).toEqual([]);
    expect(git(repo, "stash", "list")).toBe(stashesBefore); // the stash list is never touched

    git(repo, "stash", "apply", body.recoveryRef);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("precious edit\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("staged edit\n");
    expect(readFileSync(join(repo, "newdir", "n.txt"), "utf8")).toBe("new\n");
    expect(readFileSync(join(repo, "u.txt"), "utf8")).toBe("untracked\n");
  });

  it("per-file discard removes an untracked file only with includeUntracked", async () => {
    expect((await call("dis", "discard", { confirm: "DISCARD dis", files: ["u.txt"] })).status).toBe(400);
    expect(existsSync(join(repo, "u.txt"))).toBe(true);
    const r = await call("dis", "discard", { confirm: "DISCARD dis", files: ["u.txt"], includeUntracked: true });
    expect(r).toMatchObject({ status: 200, body: { discarded: ["u.txt"] } });
    expect(existsSync(join(repo, "u.txt"))).toBe(false);
    expect(existsSync(join(repo, "newdir", "n.txt"))).toBe(true);
  });
});

describe("pull and sync-main", () => {
  let repo: string;
  let other: string;
  beforeAll(() => {
    const made = makeRepo("pl");
    repo = made.repo;
    other = otherClone(made.origin, "pl");
  });
  const pushFromOther = (file: string, content: string, branch = "main") => {
    git(other, "checkout", "-q", branch);
    git(other, "pull", "-q", "--ff-only");
    writeFileSync(join(other, file), content);
    git(other, "add", "-A");
    git(other, "commit", "-qm", `other ${file}`);
    git(other, "push", "-q", "origin", branch);
  };

  it("fast-forwards when possible", async () => {
    pushFromOther("o.txt", "o\n");
    const r = await call("pl", "pull");
    expect(r).toMatchObject({ status: 200, body: { ok: true, commits: 1 } });
    expect(readFileSync(join(repo, "o.txt"), "utf8")).toBe("o\n");
  });

  it("refuses to pull a diverged branch without rewriting anything", async () => {
    writeFileSync(join(repo, "mine.txt"), "m\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "mine");
    const before = git(repo, "rev-parse", "HEAD");
    pushFromOther("o2.txt", "o2\n");
    const r = await call("pl", "pull");
    expect(r).toMatchObject({ status: 400, body: { ok: false, diverged: true } });
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("merges origin/main into a feature branch", async () => {
    git(repo, "checkout", "-q", "-b", "feat/sync", "origin/main");
    pushFromOther("o3.txt", "o3\n");
    const r = await call("pl", "sync-main");
    expect(r).toMatchObject({ status: 200, body: { ok: true, conflict: false } });
    expect(existsSync(join(repo, "o3.txt"))).toBe(true);
  });

  it("aborts a conflicting merge and reports conflict:true", async () => {
    writeFileSync(join(repo, "a.txt"), "feature version\n");
    git(repo, "commit", "-qam", "feature edit");
    pushFromOther("a.txt", "main version\n");
    const before = git(repo, "rev-parse", "HEAD");
    const r = await call("pl", "sync-main");
    expect(r).toMatchObject({ status: 400, body: { ok: false, conflict: true } });
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("feature version\n");
  });
});

describe("stash / stash-pop / stashes", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("st"));
  });

  it("stashes with a message (incl. untracked), lists, and pops", async () => {
    writeFileSync(join(repo, "a.txt"), "wip\n");
    writeFileSync(join(repo, "n.txt"), "new\n");
    const s = await call("st", "stash", { message: "my wip", includeUntracked: true });
    expect(s).toMatchObject({ status: 200, body: { ok: true, ref: "stash@{0}" } });
    expect((await getChanges(repo)).files).toEqual([]);
    const list = (await call("st", "stashes")).body as { ref: string; message: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ref: "stash@{0}" });
    expect(list[0].message).toContain("my wip");
    expect(await call("st", "stash-pop", { ref: "stash@{0}" })).toMatchObject({ status: 200, body: { ok: true } });
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("wip\n");
    expect(existsSync(join(repo, "n.txt"))).toBe(true);
    expect((await call("st", "stashes")).body).toEqual([]);
  });

  it("refuses an empty stash and bad refs", async () => {
    git(repo, "checkout", "-q", "--", "a.txt");
    rmSync(join(repo, "n.txt"));
    expect((await call("st", "stash", {})).status).toBe(400);
    expect((await call("st", "stash-pop", { ref: "HEAD" })).status).toBe(400);
    expect((await call("st", "stash-pop", { ref: "stash@{5}" })).status).toBe(400);
  });

  it("reports a conflicting pop and keeps the stash", async () => {
    writeFileSync(join(repo, "a.txt"), "stashed\n");
    await call("st", "stash", {});
    writeFileSync(join(repo, "a.txt"), "committed\n");
    git(repo, "commit", "-qam", "conflicting");
    const r = await call("st", "stash-pop", {});
    expect(r).toMatchObject({ status: 400, body: { ok: false, conflict: true } });
    expect((await call("st", "stashes")).body).toHaveLength(1);
  });
});

describe("branches and delete-branches", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("br"));
    git(repo, "branch", "done"); // at main: merged
    git(repo, "branch", "ai-work"); // merged but protected
    git(repo, "checkout", "-q", "-b", "wip");
    writeFileSync(join(repo, "w.txt"), "w\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "wip");
    git(repo, "checkout", "-q", "-b", "current", "main");
  });

  it("lists branches with merged/ahead/current info", async () => {
    const r = (await call("br", "branches")).body as { current: string; branches: { name: string; merged: boolean; ahead: number; isCurrent: boolean; hasRemote: boolean; lastCommit: { subject: string } }[] };
    expect(r.current).toBe("current");
    const by = Object.fromEntries(r.branches.map((b) => [b.name, b]));
    expect(by.done).toMatchObject({ merged: true, ahead: 0, isCurrent: false, hasRemote: false });
    expect(by.wip).toMatchObject({ merged: false, ahead: 1, lastCommit: { subject: "wip" } });
    expect(by.current).toMatchObject({ isCurrent: true });
    expect(by.main).toMatchObject({ merged: false, hasRemote: true });
  });

  it("requires the confirm string", async () => {
    expect((await call("br", "delete-branches", { branches: ["done"] })).status).toBe(400);
    expect((await call("br", "delete-branches", { branches: ["done"], confirm: "DELETE BRANCHES other" })).status).toBe(400);
    expect(git(repo, "branch", "--list", "done").trim()).toBe("done");
  });

  it("deletes only merged branches; refuses current, main, integration and unmerged", async () => {
    const r = await call("br", "delete-branches", { branches: ["done", "wip", "current", "main", "ai-work"], confirm: "DELETE BRANCHES br" });
    expect(r.status).toBe(400); // not all succeeded
    const results = Object.fromEntries((r.body as { results: { branch: string; ok: boolean }[] }).results.map((x) => [x.branch, x.ok]));
    expect(results).toEqual({ done: true, wip: false, current: false, main: false, "ai-work": false });
    const left = git(repo, "branch", "--format=%(refname:short)").trim().split("\n").sort();
    expect(left).toEqual(["ai-work", "current", "main", "wip"]);
  });

  it("rejects invalid branch names", async () => {
    expect((await call("br", "delete-branches", { branches: ["-D"], confirm: "DELETE BRANCHES br" })).status).toBe(400);
    expect((await call("br", "delete-branches", { branches: ["a b"], confirm: "DELETE BRANCHES br" })).status).toBe(400);
  });
});

describe("links", () => {
  it("normalises remotes and strips credentials", () => {
    expect(normalizeRemoteUrl("https://user:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(normalizeRemoteUrl("https://x-access-token:tok@github.com/o/r")).toBe("https://github.com/o/r");
    expect(normalizeRemoteUrl("git@github.com:o/r.git")).toBe("https://github.com/o/r");
    expect(normalizeRemoteUrl("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(normalizeRemoteUrl("/srv/git/r.git")).toBeUndefined();
    expect(normalizeRemoteUrl("file:///etc/passwd")).toBeUndefined();
    expect(redact("To https://user:secret@github.com/o/r.git")).toBe("To https://github.com/o/r.git");
  });

  it("returns repo, PR and compare URLs without leaking the token", async () => {
    const { repo } = makeRepo("ln");
    git(repo, "remote", "set-url", "origin", "https://user:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com/o/r.git");
    git(repo, "checkout", "-q", "-b", "feat/link");
    writeFileSync(process.env.FAKE_GH_STATE as string, "https://github.com/o/r/pull/9");
    const r = await call("ln", "links");
    expect(r.body).toEqual({
      repoUrl: "https://github.com/o/r",
      prUrls: ["https://github.com/o/r/pull/9"],
      compareUrl: "https://github.com/o/r/compare/main...feat/link",
      branch: "feat/link",
      ghAvailable: true,
    });
    expect(JSON.stringify(r.body)).not.toContain("ghp_");
  });
});

describe("AI summary and draft (fake Ollama)", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("ai"));
    clearAiCache();
  });

  const fakeFetch = (response: unknown, opts: { status?: number; throws?: boolean } = {}) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const impl: Fetcher = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (opts.throws) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => ({ response }) };
    };
    return { impl, calls };
  };

  it("says so without calling the model when the tree is clean", async () => {
    const f = fakeFetch("x");
    expect(await summarizeChanges(repo, { model: "q", fetchImpl: f.impl })).toMatchObject({ ok: true, summary: "No uncommitted changes." });
    expect(f.calls).toHaveLength(0);
  });

  it("summarises, caches by diff, regenerates on demand or when the diff changes", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "huge.txt"), "z".repeat(50_000));
    const f = fakeFetch("- changed a.txt");
    const first = await summarizeChanges(repo, { model: "q", fetchImpl: f.impl });
    expect(first).toEqual({ ok: true, model: "q", summary: "- changed a.txt", cached: false });
    expect(f.calls[0].url).toBe("http://127.0.0.1:11434/api/generate");
    expect(f.calls[0].body).toMatchObject({ model: "q", stream: false, options: { temperature: 0 } });
    const prompt = f.calls[0].body.prompt as string;
    expect(prompt.length).toBeLessThan(13_500);
    expect(prompt).toContain("M a.txt (+1 -0)");
    expect(prompt).toContain("? huge.txt");

    expect(await summarizeChanges(repo, { model: "q", fetchImpl: f.impl })).toMatchObject({ cached: true, summary: "- changed a.txt" });
    expect(f.calls).toHaveLength(1);
    expect(await summarizeChanges(repo, { model: "q", fetchImpl: f.impl, regenerate: true })).toMatchObject({ cached: false });
    expect(f.calls).toHaveLength(2);
    writeFileSync(join(repo, "a.txt"), "one\nthree\n");
    expect(await summarizeChanges(repo, { model: "q", fetchImpl: f.impl })).toMatchObject({ cached: false });
    expect(f.calls).toHaveLength(3);
  });

  it("reports Ollama failures as ok:false (never throws)", async () => {
    writeFileSync(join(repo, "a.txt"), "fresh change\n");
    const down = await summarizeChanges(repo, { model: "q", fetchImpl: fakeFetch("", { throws: true }).impl });
    expect(down).toMatchObject({ ok: false, cached: false, summary: "" });
    expect(down.detail).toContain("ECONNREFUSED");
    expect(await summarizeChanges(repo, { model: "q", fetchImpl: fakeFetch("", { status: 500 }).impl })).toMatchObject({ ok: false, detail: "Ollama returned HTTP 500" });
    const viaRoute = await handleRepoRoute({ ...cfg(fakeFetch("", { throws: true }).impl), ollamaBaseUrl: "http://127.0.0.1:1" }, { method: "POST", name: "ai", action: "summary", query: new URLSearchParams(), body: {} });
    expect(viaRoute.status).toBe(200);
    expect(viaRoute.body).toMatchObject({ ok: false });
  });

  it("drafts a commit message and PR text as JSON", async () => {
    const f = fakeFetch(JSON.stringify({ commitMessage: "Update a.txt", prTitle: "Update a", prBody: "## Summary\n- a" }));
    const d = await draftMessage(repo, { model: "q", mainBranch: "main", fetchImpl: f.impl });
    expect(d).toMatchObject({ ok: true, commitMessage: "Update a.txt", prTitle: "Update a", prBody: "## Summary\n- a", source: "changes" });
    expect(f.calls[0].body.format).toBe("json");
    expect(await draftMessage(repo, { model: "q", mainBranch: "main", fetchImpl: fakeFetch("not json").impl, regenerate: true })).toMatchObject({ ok: false });
  });

  it("drafts from commits ahead of main when the tree is clean", async () => {
    git(repo, "checkout", "-q", "-b", "feat/ai");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "Add the huge file");
    const f = fakeFetch(JSON.stringify({ commitMessage: "x", prTitle: "Add huge", prBody: "b" }));
    const d = await draftMessage(repo, { model: "q", mainBranch: "main", fetchImpl: f.impl });
    expect(d).toMatchObject({ ok: true, source: "commits", prTitle: "Add huge" });
    expect(f.calls[0].body.prompt).toContain("Add the huge file");
  });
});

// ---------------------------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------------------------

describe("branch names cannot become force-push refspecs", () => {
  let repo: string;
  let origin: string;
  let other: string;
  beforeAll(() => {
    ({ repo, origin } = makeRepo("plus"));
    other = otherClone(origin, "plus");
    // Someone else advances origin/main; the local main is now behind it.
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "-qm", "theirs");
    git(other, "push", "-q", "origin", "main");
  });

  it.each(["+main", "+", "@", "a:b", "a*b", "a?b", "a[b", "a\\b", "a~1", "a^b", "-x", "a b"])("create-pr rejects head/base %j", async (name) => {
    const tip = git(origin, "rev-parse", "main");
    expect((await call("plus", "create-pr", { title: "t", head: name, base: "main" })).status).toBe(400);
    expect((await call("plus", "create-pr", { title: "t", base: name })).status).toBe(400);
    expect((await call("plus", "delete-branches", { branches: [name], confirm: "DELETE BRANCHES plus" })).status).toBe(400);
    expect(git(origin, "rev-parse", "main")).toBe(tip);
  });

  it("commit-push on a checked-out branch named +main pushes refs/heads/+main, never force-pushes main", async () => {
    const tip = git(origin, "rev-parse", "main");
    git(repo, "checkout", "-q", "-b", "+main");
    writeFileSync(join(repo, "mine.txt"), "mine\n");
    const r = await call("plus", "commit-push", { message: "mine" });
    expect(git(origin, "rev-parse", "main")).toBe(tip); // origin/main was NOT rewound
    expect(r).toMatchObject({ status: 200, body: { ok: true, pushed: true } });
    expect(git(origin, "rev-parse", "refs/heads/+main").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
  });
});

describe("staged renames and deletions", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("rnm", { "a.txt": "one\n", "b.txt": "two\n", "c.txt": "three\n" }));
  });

  it("stages and unstages a staged rename and a staged deletion", async () => {
    git(repo, "mv", "b.txt", "b2.txt");
    git(repo, "rm", "-q", "c.txt");
    expect(await call("rnm", "stage", { files: ["b2.txt", "c.txt"] })).toMatchObject({ status: 200, body: { ok: true } });
    expect(await call("rnm", "unstage", { files: ["b2.txt", "c.txt"] })).toMatchObject({ status: 200, body: { ok: true } });
    const by = Object.fromEntries((await getChanges(repo)).files.map((f) => [f.path, f]));
    expect(by["c.txt"]).toMatchObject({ status: "D", staged: false });
    expect(by["b.txt"]).toMatchObject({ status: "D", staged: false });
    expect(by["b2.txt"]).toMatchObject({ status: "?" });
    expect(await call("rnm", "stage", { files: ["b.txt", "b2.txt", "c.txt"] })).toMatchObject({ status: 200, body: { ok: true } });
    const after = Object.fromEntries((await getChanges(repo)).files.map((f) => [f.path, f]));
    expect(after["b2.txt"]).toMatchObject({ status: "R", oldPath: "b.txt", staged: true });
    expect(after["c.txt"]).toMatchObject({ status: "D", staged: true });
  });

  it("commits a subset that contains a staged rename and a staged deletion", async () => {
    writeFileSync(join(repo, "a.txt"), "not selected\n");
    const r = await call("rnm", "commit-push", { message: "rename + delete", files: ["b2.txt", "c.txt"] });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(git(repo, "show", "--name-status", "--format=", "-M", "HEAD").trim().split("\n").sort()).toEqual(["D\tc.txt", "R100\tb.txt\tb2.txt"]);
    expect((await getChanges(repo)).files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("commits a subset with an unstaged deletion (rm without git rm)", async () => {
    rmSync(join(repo, "b2.txt"));
    const r = await call("rnm", "commit-push", { message: "delete b2", files: ["b2.txt"] });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(git(repo, "show", "--name-status", "--format=", "HEAD").trim()).toBe("D\tb2.txt");
  });
});

describe("per-file discard recovery", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("rec"));
  });

  it("recovery ref of a per-file discard applies while other files stay dirty", async () => {
    writeFileSync(join(repo, "a.txt"), "keep me dirty\n");
    writeFileSync(join(repo, "b.txt"), "discard me\n");
    const r = await call("rec", "discard", { confirm: "DISCARD rec", files: ["b.txt"] });
    const body = r.body as { recoveryRef: string; discarded: string[] };
    expect(r.status).toBe(200);
    expect(body.discarded).toEqual(["b.txt"]);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("two\n");
    git(repo, "stash", "apply", body.recoveryRef);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("discard me\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("keep me dirty\n");
    git(repo, "checkout", "-q", "--", "a.txt", "b.txt");
  });

  it("keeps the staged version of a partly-staged file in the recovery ref", async () => {
    writeFileSync(join(repo, "a.txt"), "other dirty\n");
    writeFileSync(join(repo, "b.txt"), "staged\n");
    git(repo, "add", "b.txt");
    writeFileSync(join(repo, "b.txt"), "staged\nplus worktree\n");
    const r = await call("rec", "discard", { confirm: "DISCARD rec", files: ["b.txt"] });
    const ref = (r.body as { recoveryRef: string }).recoveryRef;
    git(repo, "stash", "apply", "--index", ref);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("staged\nplus worktree\n");
    expect(git(repo, "show", ":b.txt")).toBe("staged\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("other dirty\n");
    git(repo, "reset", "-q");
    git(repo, "checkout", "-q", "--", "a.txt", "b.txt");
  });

  it("recovery ref of an untracked-only per-file discard applies while tracked files stay dirty", async () => {
    writeFileSync(join(repo, "a.txt"), "still dirty\n");
    mkdirSync(join(repo, "nd"));
    writeFileSync(join(repo, "nd", "u.txt"), "untracked\n");
    writeFileSync(join(repo, "keep.txt"), "kept\n");
    const r = await call("rec", "discard", { confirm: "DISCARD rec", files: ["nd/u.txt"], includeUntracked: true });
    const body = r.body as { recoveryRef: string; discarded: string[] };
    expect(body.discarded).toEqual(["nd/u.txt"]);
    expect(existsSync(join(repo, "nd", "u.txt"))).toBe(false);
    git(repo, "stash", "apply", body.recoveryRef);
    expect(readFileSync(join(repo, "nd", "u.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("still dirty\n");
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("kept\n");
  });

  it("whole-repo discard recovery still restores everything", async () => {
    writeFileSync(join(repo, "b.txt"), "b edit\n");
    const r = await call("rec", "discard", { confirm: "DISCARD rec", includeUntracked: true });
    const ref = (r.body as { recoveryRef: string }).recoveryRef;
    expect((await getChanges(repo)).files).toEqual([]);
    git(repo, "stash", "apply", ref);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("still dirty\n");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b edit\n");
    expect(readFileSync(join(repo, "nd", "u.txt"), "utf8")).toBe("untracked\n");
  });
});

describe("discard of nested repositories", () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = makeRepo("nest"));
    const inner = join(repo, "inner");
    mkdirSync(inner);
    git(inner, "init", "-q");
    writeFileSync(join(inner, "x.txt"), "x\n");
    writeFileSync(join(repo, "u.txt"), "u\n");
  });

  it("refuses a per-file discard that names a nested repository and changes nothing", async () => {
    expect((await getChanges(repo)).files.map((f) => f.path)).toContain("inner/");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
    const r = await call("nest", "discard", { confirm: "DISCARD nest", files: ["inner/", "a.txt", "u.txt"], includeUntracked: true });
    expect(r.status).toBe(400);
    expect((r.body as { detail: string }).detail).toContain("inner/");
    expect(existsSync(join(repo, "inner", "x.txt"))).toBe(true);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("dirty\n");
    expect(existsSync(join(repo, "u.txt"))).toBe(true);
  });

  it("whole-repo discard keeps nested repositories and does not report them as discarded", async () => {
    const r = await call("nest", "discard", { confirm: "DISCARD nest", includeUntracked: true });
    const body = r.body as { discarded: string[]; keptNestedRepos: string[]; detail: string };
    expect(r.status).toBe(200);
    expect(body.discarded.sort()).toEqual(["a.txt", "u.txt"]);
    expect(body.keptNestedRepos).toEqual(["inner/"]);
    expect(body.detail).toContain("inner/");
    expect(existsSync(join(repo, "inner", "x.txt"))).toBe(true);
  });
});

describe("detached HEAD guards", () => {
  beforeAll(() => {
    const { repo } = makeRepo("det");
    git(repo, "checkout", "-q", "--detach");
    writeFileSync(join(repo, "a.txt"), "dirty\n");
  });

  it.each(["commit-push", "push", "create-pr", "pull", "sync-main"])("%s answers 400 on a detached HEAD", async (action) => {
    const r = await call("det", action, { message: "m", title: "t" });
    expect(r.status).toBe(400);
    expect((r.body as { detail: string }).detail).toMatch(/detached/i);
  });
});

describe("branches response", () => {
  it("exposes the configured main/integration branch names (the UI groups by them instead of guessing)", async () => {
    const { repo } = makeRepo("brm");
    git(repo, "checkout", "-q", "-b", "feat");
    const r = (await call("brm", "branches")).body as { current: string; mainBranch: string; integrationBranch: string; branches: { name: string }[] };
    expect(r).toMatchObject({ current: "feat", mainBranch: "main", integrationBranch: "ai-work" });
    expect(r.branches.map((b) => b.name).sort()).toEqual(["feat", "main"]);
  });
});

describe("push, merge-pr, and clean-merged quick actions", () => {
  it("pushes unpushed commits on the current branch without needing a new commit", async () => {
    const { repo, origin } = makeRepo("qpush");
    git(repo, "checkout", "-q", "-b", "feat/quick");
    writeFileSync(join(repo, "q.txt"), "q\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "quick commit");
    const r = await call("qpush", "push");
    expect(r).toMatchObject({ status: 200, body: { ok: true, pushed: true } });
    expect(git(origin, "rev-parse", "refs/heads/feat/quick").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("squash-merges a PR via gh pr merge --squash --delete-branch and cleans up the local head branch", async () => {
    const { repo } = makeRepo("qmerge");
    git(repo, "branch", "feat/merged-pr"); // at main => merged and deletable once on main
    const r = await call("qmerge", "merge-pr", { number: 9, headBranch: "feat/merged-pr" });
    expect(r).toMatchObject({
      status: 200,
      body: { ok: true, merged: true, url: "https://github.com/o/r/pull/9", cleanedBranch: "feat/merged-pr" },
    });
    const merges = readFileSync(`${process.env.FAKE_GH_STATE}.merges`, "utf8").trim().split("\n");
    expect(merges.at(-1)).toBe("pr merge 9 --squash --delete-branch");
    expect(git(repo, "branch", "--list", "feat/merged-pr").trim()).toBe("");
  });

  it("rejects invalid merge-pr parameters", async () => {
    expect((await call("qmerge", "merge-pr", {})).status).toBe(400);
    expect((await call("qmerge", "merge-pr", { number: -1 })).status).toBe(400);
    expect((await call("qmerge", "merge-pr", { url: "https://evil.com/o/r/pull/1" })).status).toBe(400);
  });

  it("clean-merged deletes all merged non-protected branches in one click without deleting unmerged or protected ones", async () => {
    const { repo } = makeRepo("qclean");
    git(repo, "branch", "done-1");
    git(repo, "branch", "done-2");
    git(repo, "branch", "ai-work");
    git(repo, "checkout", "-q", "-b", "unmerged");
    writeFileSync(join(repo, "u.txt"), "u\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "unmerged work");
    git(repo, "checkout", "-q", "main");

    const r = await call("qclean", "clean-merged");
    expect(r).toMatchObject({ status: 200, body: { ok: true, detail: "cleaned 2 of 2 merged branch(es)" } });
    const left = git(repo, "branch", "--format=%(refname:short)").trim().split("\n").sort();
    expect(left).toEqual(["ai-work", "main", "unmerged"]);
  });
});

describe("draft-message for a PR prefers commit material", () => {
  it("uses commits ahead of main even when the tree is dirty", async () => {
    clearAiCache();
    const { repo } = makeRepo("dpr");
    git(repo, "checkout", "-q", "-b", "feat/dpr");
    writeFileSync(join(repo, "f.txt"), "f\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "Add the f file");
    writeFileSync(join(repo, "a.txt"), "uncommitted\n");
    const calls: string[] = [];
    const impl: Fetcher = async (_url, init) => {
      calls.push((JSON.parse(init.body) as { prompt: string }).prompt);
      return { ok: true, status: 200, json: async () => ({ response: JSON.stringify({ commitMessage: "c", prTitle: "p", prBody: "b" }) }) };
    };
    const pr = await handleRepoRoute(cfg(impl), { method: "POST", name: "dpr", action: "draft-message", query: new URLSearchParams(), body: { for: "pr" } });
    expect(pr.body).toMatchObject({ ok: true, source: "commits" });
    expect(calls[0]).toContain("Add the f file");
    const commit = await handleRepoRoute(cfg(impl), { method: "POST", name: "dpr", action: "draft-message", query: new URLSearchParams(), body: {} });
    expect(commit.body).toMatchObject({ ok: true, source: "changes" });
  });
});

