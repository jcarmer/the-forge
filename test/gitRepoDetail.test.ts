import { describe, expect, it } from "vitest";
import { classifyDiffLine, parseDiff } from "../web/src/views/git/diffLines";
import { deleteBranchesPhrase, discardPhrase, isConfirmed, planDiscard } from "../web/src/views/git/confirm";
import {
  changesSignature,
  groupBranches,
  guessBaseBranch,
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
  it("separates unmerged, deletable merged and protected/current merged branches", () => {
    const g = groupBranches(bs);
    expect(g.unmerged.map((b) => b.name)).toEqual(["main", "feat-open"]);
    expect(g.deletable.map((b) => b.name)).toEqual(["feat-done"]);
    expect(g.merged.map((b) => b.name)).toEqual(["current-done", "ai-work"]);
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
