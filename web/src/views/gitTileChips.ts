import type { GitRepoSummary } from "../types";
import type { Variant } from "../components";

export interface TileChip {
  key: string;
  label: string;
  variant: Variant;
}

const MAX_BRANCH_NAMES = 3;

/** Truncates a branch list to a short human string, e.g. "a, b, c +2 more". */
export function branchNames(branches: string[], max = MAX_BRANCH_NAMES): string {
  const shown = branches.slice(0, max).join(", ");
  return branches.length > max ? `${shown} +${branches.length - max} more` : shown;
}

/** Status chips for a repo tile. Always text-labelled (colour is never the only signal). */
export function tileChips(r: GitRepoSummary): TileChip[] {
  const chips: TileChip[] = [];
  if (r.changedFiles > 0 || r.dirty) {
    chips.push({ key: "dirty", label: `${r.changedFiles} uncommitted`, variant: "warning" });
  }
  if (r.behind > 0) chips.push({ key: "behind", label: `behind ${r.behind} - needs pull`, variant: "danger" });
  if (r.ahead > 0) chips.push({ key: "ahead", label: `ahead ${r.ahead}`, variant: "info" });
  if (r.noUpstream) chips.push({ key: "noUpstream", label: "no upstream", variant: "warning" });
  if (r.openPrs === null) {
    chips.push({ key: "prs", label: "PRs unknown (gh unavailable)", variant: "default" });
  } else if (r.openPrs.length > 0) {
    chips.push({ key: "prs", label: `${r.openPrs.length} open PR${r.openPrs.length === 1 ? "" : "s"}`, variant: "info" });
  }
  if (r.openBranches.length > 0) {
    chips.push({
      key: "branches",
      label: `${r.openBranches.length} open branch${r.openBranches.length === 1 ? "" : "es"}`,
      variant: "secondary",
    });
  }
  if (r.stashes > 0) chips.push({ key: "stashes", label: `${r.stashes} stash${r.stashes === 1 ? "" : "es"}`, variant: "default" });
  if (r.reasons.length === 0) chips.push({ key: "clean", label: "Clean", variant: "success" });
  return chips;
}

export function isClean(r: GitRepoSummary): boolean {
  return r.reasons.length === 0;
}

export function attentionCount(repos: GitRepoSummary[]): number {
  return repos.filter((r) => !isClean(r)).length;
}
