import { describe, expect, it } from "vitest";
import { attentionCount, branchNames, tileChips } from "../web/src/views/gitTileChips";
import type { GitRepoSummary } from "../web/src/types";

const base: GitRepoSummary = {
  name: "r", path: "/r", branch: "main", dirty: false, changedFiles: 0, ahead: 0, behind: 0,
  noUpstream: false, openBranches: [], openPrs: [], ghAvailable: true, stashes: 0, attention: "clean", reasons: [],
};

describe("tileChips", () => {
  it("shows Clean only when no reasons", () => {
    expect(tileChips(base).map((c) => c.label)).toEqual(["Clean"]);
  });
  it("derives chips", () => {
    const labels = tileChips({
      ...base, dirty: true, changedFiles: 3, behind: 2, ahead: 1, noUpstream: true, stashes: 1,
      openBranches: ["a"], openPrs: [{ number: 1, title: "t", url: "", headRefName: "", baseRefName: "", isDraft: false }],
      reasons: ["dirty", "behind"],
    }).map((c) => c.label);
    expect(labels).toEqual(["3 uncommitted", "behind 2 - needs pull", "ahead 1", "no upstream", "1 open PR", "1 open branch", "1 stash"]);
  });
  it("flags unknown PRs", () => {
    expect(tileChips({ ...base, openPrs: null }).map((c) => c.label)).toContain("PRs unknown (gh unavailable)");
  });
  it("truncates branches and counts attention", () => {
    expect(branchNames(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
    expect(attentionCount([base, { ...base, reasons: ["ahead"] }])).toBe(1);
  });
});
