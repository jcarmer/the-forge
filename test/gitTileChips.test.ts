import { describe, expect, it } from "vitest";
import { attentionCount, branchNames, filterRepos, tileChips, tileQuickActions } from "../web/src/views/gitTileChips";
import type { GitRepoSummary } from "../web/src/types";

const base: GitRepoSummary = {
  name: "r",
  path: "/r",
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
};

describe("tileChips", () => {
  it("shows Clean only when no reasons and no merged branches waiting for cleanup", () => {
    expect(tileChips(base).map((c) => c.label)).toEqual(["Clean"]);
  });
  it("derives chips including merged branches", () => {
    const labels = tileChips({
      ...base,
      dirty: true,
      changedFiles: 3,
      behind: 2,
      ahead: 1,
      noUpstream: true,
      stashes: 1,
      openBranches: ["a"],
      mergedBranches: ["old-1", "old-2"],
      openPrs: [{ number: 1, title: "t", url: "", headRefName: "", baseRefName: "", isDraft: false }],
      reasons: ["dirty", "behind"],
    }).map((c) => c.label);
    expect(labels).toEqual([
      "3 uncommitted",
      "behind 2 - needs pull",
      "ahead 1",
      "no upstream",
      "1 open PR",
      "1 open branch",
      "2 merged branches",
      "1 stash",
    ]);
  });
  it("flags unknown PRs", () => {
    expect(tileChips({ ...base, openPrs: null }).map((c) => c.label)).toContain("PRs unknown (gh unavailable)");
  });
  it("truncates branches and counts attention", () => {
    expect(branchNames(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
    expect(attentionCount([base, { ...base, reasons: ["ahead"] }])).toBe(1);
  });
});

describe("tileQuickActions and filterRepos", () => {
  it("computes contextual quick-action flags", () => {
    expect(tileQuickActions(base)).toEqual({
      canPull: false,
      canPush: false,
      canSyncMain: false,
      canCreatePr: false,
      canCleanMerged: false,
    });
    const featureRepo: GitRepoSummary = {
      ...base,
      branch: "feat/x",
      ahead: 2,
      behind: 1,
      openBranches: ["feat/x"],
      mergedBranches: ["done"],
    };
    expect(tileQuickActions(featureRepo)).toEqual({
      canPull: true,
      canPush: true,
      canSyncMain: true,
      canCreatePr: true,
      canCleanMerged: true,
    });
  });

  it("filters repos by category", () => {
    const dirty: GitRepoSummary = { ...base, name: "dirty", dirty: true, changedFiles: 1, reasons: ["dirty"] };
    const prRepo: GitRepoSummary = {
      ...base,
      name: "pr",
      openPrs: [{ number: 2, title: "p", url: "https://github.com/o/r/pull/2", headRefName: "f", baseRefName: "main", isDraft: false }],
      reasons: ["prs"],
    };
    const list = [dirty, prRepo, base];
    expect(filterRepos(list, "all").map((r) => r.name)).toEqual(["dirty", "pr", "r"]);
    expect(filterRepos(list, "attention").map((r) => r.name)).toEqual(["dirty", "pr"]);
    expect(filterRepos(list, "dirty").map((r) => r.name)).toEqual(["dirty"]);
    expect(filterRepos(list, "prs").map((r) => r.name)).toEqual(["pr"]);
    expect(filterRepos(list, "clean").map((r) => r.name)).toEqual(["r"]);
  });
});

