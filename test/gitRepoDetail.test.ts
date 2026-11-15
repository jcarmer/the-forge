import { describe, expect, it } from "vitest";
import { classifyDiffLine, parseDiff } from "../web/src/views/git/diffLines";
import { deleteBranchesPhrase, discardPhrase, isConfirmed, planDiscard } from "../web/src/views/git/confirm";
import {
  changesSignature,
  DETACHED_BRANCH,
  groupBranches,
  guessBaseBranch,
  isDetached,
  isSubset,
  pruneBranchSelection,
  pruneDeselected,
  pullBlockedReason,
  selectAll,
  selectNone,
  selectedFiles,
  stageWord,
  summarySignature,
  syncBlockedReason,
  toggleSelected,
} from "../web/src/views/git/selection";
import type { GitBranchInfo, GitChangedFile } from "../web/src/types";

const file = (path: string, over: Partial<GitChangedFile> = {}): GitChangedFile => ({
  path, status: "M", staged: false, unstaged: true, additions: 1, deletions: 0, binary: false, ...over,
});
const branch = (name: string, over: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  name, merged: false, ahead: 0, behind: 0, compareTo: null, lastCommit: { sha: "abc", subject: "s", date: "d" }, isCurrent: false, hasRemote: false, ...over,
});

describe("parseDiff", () => {
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "index 111..222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " keep",
    "--- a deleted line starting with dashes",
    "+++ an added line starting with pluses",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  it("treats header lines as meta only before the first hunk", () => {
    expect(parseDiff(diff).map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk", "context", "del", "add", "note"]);
  });
  it("resets to header mode at each new file", () => {
    const two = `${diff}diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-x\n+y\n`;
    const kinds = parseDiff(two).map((l) => l.kind);
    expect(kinds.slice(-6)).toEqual(["meta", "meta", "meta", "hunk", "del", "add"]);
    expect(kinds.filter((k) => k === "meta")).toHaveLength(7);
  });
  it("handles empty input, binary notices and untracked-directory placeholders", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("Binary files a/x and b/x differ\n")[0]?.kind).toBe("meta");
    expect(parseDiff("(untracked directory d/: probably a nested repository)\n")[0]?.kind).toBe("meta");
  });
  it("keeps blank context lines inside a hunk", () => {
    expect(parseDiff("@@ -1,2 +1,2 @@\n a\n\n").map((l) => l.kind)).toEqual(["hunk", "context", "context"]);
  });
  it("classifies a single line", () => {
    expect(classifyDiffLine("@@ -1 +1 @@")).toBe("hunk");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
  });
});

describe("confirm helpers", () => {
  it("builds the exact phrases the backend expects", () => {
    expect(discardPhrase("repo")).toBe("DISCARD repo");
    expect(deleteBranchesPhrase("repo")).toBe("DELETE BRANCHES repo");
  });
  it("accepts the repo name or the exact phrase, nothing else", () => {
    const p = discardPhrase("my-repo");
    expect(isConfirmed("my-repo", "my-repo", p)).toBe(true);
    expect(isConfirmed("  DISCARD my-repo ", "my-repo", p)).toBe(true);
    expect(isConfirmed("discard my-repo", "my-repo", p)).toBe(false);
    expect(isConfirmed("my-rep", "my-repo", p)).toBe(false);
    expect(isConfirmed("", "my-repo", p)).toBe(false);
    expect(isConfirmed("   ", "", "")).toBe(false);
  });
  it("plans discards: untracked files are kept unless opted in, and an untracked-only plan is a no-op", () => {
    const files = [file("a"), file("n", { status: "?" })];
    expect(planDiscard(files, false)).toMatchObject({ tracked: ["a"], deleted: [], kept: ["n"], nothingToDo: false });
    expect(planDiscard(files, true)).toMatchObject({ tracked: ["a"], deleted: ["n"], kept: [], nothingToDo: false });
    expect(planDiscard([file("n", { status: "?" })], false).nothingToDo).toBe(true);
    expect(planDiscard([file("n", { status: "?" })], true).nothingToDo).toBe(false);
    expect(planDiscard([], true).nothingToDo).toBe(true);
    expect(planDiscard(files, false).send).toEqual(["a", "n"]);
  });
  it("never deletes or sends nested repositories (untracked dir/ entries)", () => {
    const files = [file("a"), file("inner/", { status: "?" }), file("n", { status: "?" })];
    const plan = planDiscard(files, true);
    expect(plan).toMatchObject({ tracked: ["a"], deleted: ["n"], kept: ["inner/"], nested: ["inner/"], send: ["a", "n"] });
    expect(planDiscard([file("inner/", { status: "?" })], true)).toMatchObject({ nothingToDo: true, send: [] });
  });
});

describe("file selection", () => {
  const files = [file("a"), file("b"), file("c")];
  it("selects everything by default and toggles individual files", () => {
    let d = selectAll();
    expect(selectedFiles(files, d).map((f) => f.path)).toEqual(["a", "b", "c"]);
    d = toggleSelected(d, "b");
    expect(selectedFiles(files, d).map((f) => f.path)).toEqual(["a", "c"]);
    expect(isSubset(files, selectedFiles(files, d))).toBe(true);
    d = toggleSelected(d, "b");
    expect(isSubset(files, selectedFiles(files, d))).toBe(false);
  });
  it("selects none and keeps new files selected after a refresh", () => {
    const d = selectNone(files);
    expect(selectedFiles(files, d)).toEqual([]);
    const refreshed = [...files, file("d")];
    expect(selectedFiles(refreshed, d).map((f) => f.path)).toEqual(["d"]);
  });
  it("prunes deselected paths that are no longer changed", () => {
    const d = new Set(["a", "gone"]);
    expect([...pruneDeselected(d, files)]).toEqual(["a"]);
    const same = new Set(["a"]);
    expect(pruneDeselected(same, files)).toBe(same);
  });
  it("labels staging state and changes the signature when a file changes", () => {
    expect(stageWord(file("a", { staged: true, unstaged: true }))).toBe("partly staged");
    expect(stageWord(file("a", { staged: true, unstaged: false }))).toBe("staged");
    expect(stageWord(file("a"))).toBe("unstaged");
    expect(stageWord(file("a", { status: "?" }))).toBe("untracked");
    expect(changesSignature(files)).toBe(changesSignature([...files]));
    expect(summarySignature([file("a", { staged: true, unstaged: false }), file("b"), file("c")])).toBe(summarySignature(files));
    expect(changesSignature(files)).not.toBe(changesSignature([file("a", { additions: 2 }), file("b"), file("c")]));
  });
});

describe("branch helpers", () => {
  const bs = [
    branch("main", { merged: false, isCurrent: false }),
    branch("feat-open"),
    branch("feat-done", { merged: true }),
    branch("current-done", { merged: true, isCurrent: true }),
    branch("ai-work", { merged: true }),
  ];
  it("separates main/integration, unmerged, deletable merged and current merged branches", () => {
    const g = groupBranches(bs);
    expect(g.base.map((b) => b.name)).toEqual(["main", "ai-work"]);
    expect(g.unmerged.map((b) => b.name)).toEqual(["feat-open"]); // main is never "not merged into main"
    expect(g.deletable.map((b) => b.name)).toEqual(["feat-done"]);
    expect(g.merged.map((b) => b.name)).toEqual(["current-done"]);
  });
  it("uses the backend's configured main/integration branches instead of guessing", () => {
    const g = groupBranches([branch("trunk"), branch("main", { merged: true }), branch("dev")], { mainBranch: "trunk", integrationBranch: "dev" });
    expect(g.base.map((b) => b.name)).toEqual(["trunk", "dev"]);
    expect(g.deletable.map((b) => b.name)).toEqual(["main"]);
    expect(guessBaseBranch(null, [branch("main")], "trunk")).toBe("trunk");
  });
  it("prunes branch selection to what is still deletable", () => {
    expect([...pruneBranchSelection(new Set(["feat-done", "x"]), groupBranches(bs).deletable)]).toEqual(["feat-done"]);
  });
  it("guesses the PR base", () => {
    const links = { prUrls: [], branch: "f", ghAvailable: true, compareUrl: "https://github.com/o/r/compare/release%2F1...f" };
    expect(guessBaseBranch(links, null)).toBe("release/1");
    expect(guessBaseBranch(null, [branch("master")])).toBe("master");
    expect(guessBaseBranch(null, null)).toBe("main");
  });
  it("explains why pull and sync are unavailable", () => {
    expect(pullBlockedReason({ behind: 0, noUpstream: false, branch: "x" })).toMatch(/up to date/);
    expect(pullBlockedReason({ behind: 2, noUpstream: true, branch: "x" })).toMatch(/no upstream/);
    expect(pullBlockedReason({ behind: 2, noUpstream: false, branch: "x" })).toBeNull();
    expect(syncBlockedReason({ branch: "main", mainBranch: "main", dirty: false })).toMatch(/Pull/);
    expect(syncBlockedReason({ branch: "f", mainBranch: "main", dirty: true })).toMatch(/stash/);
    expect(syncBlockedReason({ branch: "f", mainBranch: "main", dirty: false })).toBeNull();
  });
  it("treats the backend's (detached) marker as no branch", () => {
    expect(isDetached(DETACHED_BRANCH)).toBe(true);
    expect(isDetached("")).toBe(true);
    expect(isDetached("feat/x")).toBe(false);
    expect(pullBlockedReason({ behind: 2, noUpstream: false, branch: "(detached)" })).toMatch(/Detached HEAD/);
    expect(syncBlockedReason({ branch: "(detached)", mainBranch: "main", dirty: false })).toMatch(/Detached HEAD/);
  });
});

import { noticeFrom } from "../web/src/views/git/notice";

describe("noticeFrom", () => {
  it("maps outcomes to banner kinds and carries extras", () => {
    expect(noticeFrom("PR", { ok: true, detail: "made", url: "https://github.com/o/r/pull/1" })).toMatchObject({ kind: "success", url: "https://github.com/o/r/pull/1" });
    expect(noticeFrom("Sync", { ok: false, conflict: true, detail: "conflicts" })).toMatchObject({ kind: "warning", conflict: true });
    expect(noticeFrom("Commit", { ok: false, committed: true, detail: "push failed" }).kind).toBe("warning");
    expect(noticeFrom("Delete", { ok: false, detail: "1 of 2", results: [{ branch: "a", ok: true, detail: "" }, { branch: "b", ok: false, detail: "x" }] }).kind).toBe("warning");
    expect(noticeFrom("Delete", { ok: false, detail: "0 of 1", results: [{ branch: "b", ok: false, detail: "x" }] }).kind).toBe("error");
    expect(noticeFrom("Discard", { ok: true, detail: "d", recoveryRef: "abc123" }).recoveryRef).toBe("abc123");
    expect(noticeFrom("X", { ok: false, detail: "" }).text).toBe("The action failed.");
  });
});

import { afterEach, vi } from "vitest";
import { gitGet, gitPost } from "../web/src/hooks/useGitRepoApi";

describe("gitPost / gitGet", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));

  it("keeps the full body on HTTP 400 (results, conflict, detail)", async () => {
    stub(400, { ok: false, detail: "deleted 1 of 2", results: [{ branch: "a", ok: true, detail: "" }] });
    const r = await gitPost("my repo", "delete-branches", { branches: ["a"] });
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("deleted 1 of 2");
    expect(r.results).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/git/repo/my%20repo/delete-branches");
  });
  it("falls back to error text, then a generic message, and never throws on transport errors", async () => {
    stub(400, { ok: false, error: "bad" });
    expect((await gitPost("r", "pull")).detail).toBe("bad");
    stub(502, "<html>bad gateway</html>");
    expect((await gitPost("r", "pull")).detail).toBe("Request failed (502)");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await gitPost("r", "pull")).toEqual({ ok: false, detail: "offline" });
  });
  it("treats ok:true on a non-2xx status as a failure", async () => {
    stub(500, { ok: true });
    expect((await gitPost("r", "pull")).ok).toBe(false);
  });
  it("gitGet throws the backend detail", async () => {
    stub(404, { ok: false, error: "repo not found: x", detail: "repo not found: x" });
    await expect(gitGet("x", "changes")).rejects.toThrow("repo not found: x");
    stub(200, { branch: "m", files: [] });
    await expect(gitGet("x", "changes", { path: "a b" })).resolves.toEqual({ branch: "m", files: [] });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/git/repo/x/changes?path=a+b");
  });
});

import { isHttpUrl } from "../web/src/views/git/notice";
import { coalesce, gitPollInterval, GIT_POLL_ACTIVE_MS, GIT_POLL_BACKGROUND_MS, mergeFullList, replaceRepo } from "../web/src/hooks/gitPolling";

describe("isHttpUrl (ExternalLink renders an anchor only for these)", () => {
  it("accepts http(s) and rejects other schemes", () => {
    expect(isHttpUrl("https://github.com/o/r")).toBe(true);
    expect(isHttpUrl("HTTP://x")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl(" https://x")).toBe(false);
    expect(isHttpUrl("data:text/html,x")).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});

describe("git polling helpers", () => {
  it("polls only while visible: fast with the Git tab open, slow for the counter otherwise", () => {
    expect(gitPollInterval(false, true)).toBeNull();
    expect(gitPollInterval(false, false)).toBeNull();
    expect(gitPollInterval(true, true)).toBe(GIT_POLL_ACTIVE_MS);
    expect(gitPollInterval(true, false)).toBe(GIT_POLL_BACKGROUND_MS);
  });

  it("coalesce: a reload requested mid-flight runs once more afterwards (merged), never dropped", async () => {
    const runs: { refresh: boolean }[] = [];
    const gates: (() => void)[] = [];
    const run = coalesce<{ refresh: boolean }>(
      (a) => {
        runs.push(a);
        return new Promise<void>((r) => gates.push(r));
      },
      (a, b) => ({ refresh: a.refresh || b.refresh }),
    );
    const p1 = run({ refresh: false });
    const p2 = run({ refresh: false });
    const p3 = run({ refresh: true });
    expect(runs).toHaveLength(1);
    gates[0]?.();
    await p1;
    await Promise.resolve();
    expect(runs).toEqual([{ refresh: false }, { refresh: true }]);
    let settled = false;
    void p2.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // resolves only after the follow-up run
    gates[1]?.();
    await Promise.all([p2, p3]);
    expect(runs).toHaveLength(2);
  });

  it("coalesce keeps working after a failing run", async () => {
    let n = 0;
    const run = coalesce<null>(async () => {
      n++;
      if (n === 1) throw new Error("boom");
    }, (a) => a);
    await run(null);
    await run(null);
    expect(n).toBe(2);
  });

  it("a slow full list does not overwrite a newer single-repo refresh", () => {
    const prev = [{ name: "a", v: 2 }, { name: "b", v: 1 }];
    const stamps = new Map([["a", 5]]);
    expect(mergeFullList(prev, [{ name: "a", v: 1 }, { name: "b", v: 9 }], 3, stamps)).toEqual([{ name: "a", v: 2 }, { name: "b", v: 9 }]);
    expect(mergeFullList(prev, [{ name: "a", v: 7 }], 6, stamps)).toEqual([{ name: "a", v: 7 }]);
  });

  it("replaceRepo replaces, appends or removes one repo", () => {
    const list = [{ name: "a", v: 1 }, { name: "b", v: 1 }];
    expect(replaceRepo(list, "b", { name: "b", v: 2 })).toEqual([{ name: "a", v: 1 }, { name: "b", v: 2 }]);
    expect(replaceRepo(list, "c", { name: "c", v: 1 })).toHaveLength(3);
    expect(replaceRepo(list, "a", null)).toEqual([{ name: "b", v: 1 }]);
  });
});
