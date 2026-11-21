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
  const conflicts = r.mainConflicts?.length ?? 0;
  if (conflicts > 0) {
    chips.push({ key: "conflicts", label: `would conflict with ${r.mainBranch ?? "main"} (${conflicts} file${conflicts === 1 ? "" : "s"})`, variant: "danger" });
  } else if ((r.behindMain ?? 0) > 0) {
    chips.push({ key: "behindMain", label: `${r.behindMain} behind ${r.mainBranch ?? "main"}`, variant: "secondary" });
  }
  if ((r.agentBusy?.length ?? 0) > 0) {
    chips.push({ key: "agentBusy", label: `agent working (${r.agentBusy!.length}) - avoid pushing`, variant: "warning" });
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
  const mergedCount = r.mergedBranches?.length ?? 0;
  if (mergedCount > 0) {
    chips.push({
      key: "merged",
      label: `${mergedCount} merged branch${mergedCount === 1 ? "" : "es"}`,
      variant: "default",
    });
  }
  if (r.stashes > 0) chips.push({ key: "stashes", label: `${r.stashes} stash${r.stashes === 1 ? "" : "es"}`, variant: "default" });
  if (r.reasons.length === 0 && mergedCount === 0) chips.push({ key: "clean", label: "Clean", variant: "success" });
  return chips;
}

export function isClean(r: GitRepoSummary): boolean {
  return r.reasons.length === 0;
}

export function attentionCount(repos: GitRepoSummary[]): number {
  return repos.filter((r) => !isClean(r)).length;
}

export type RepoFilter = "all" | "attention" | "dirty" | "prs" | "clean";

export function filterRepos(repos: GitRepoSummary[], filter: RepoFilter): GitRepoSummary[] {
  switch (filter) {
    case "attention":
      return repos.filter((r) => !isClean(r) || (r.mergedBranches?.length ?? 0) > 0);
    case "dirty":
      return repos.filter((r) => r.dirty || r.changedFiles > 0);
    case "prs":
      return repos.filter((r) => (r.openPrs?.length ?? 0) > 0);
    case "clean":
      return repos.filter((r) => isClean(r) && (r.mergedBranches?.length ?? 0) === 0);
    default:
      return repos;
  }
}

export interface TileQuickActionFlags {
  canPull: boolean;
  canPush: boolean;
  canSyncMain: boolean;
  canCreatePr: boolean;
  canCleanMerged: boolean;
}

/** Pure helper determining which contextual quick-action buttons apply to a repo card on the overview. */
export function tileQuickActions(r: GitRepoSummary): TileQuickActionFlags {
  const detached = !r.branch || r.branch === "(detached)";
  const mainBranch = r.mainBranch ?? "main";
  const onMain = r.branch === mainBranch;
  const hasOpenPrForBranch = Boolean(r.openPrs?.some((p) => p.headRefName === r.branch));
  const branchUnmerged = r.openBranches.includes(r.branch);

  return {
    canPull: !detached && !r.noUpstream && r.behind > 0,
    canPush: !detached && (r.ahead > 0 || (r.noUpstream && branchUnmerged)),
    canSyncMain: !detached && !onMain && !r.dirty && r.changedFiles === 0,
    canCreatePr: !detached && !hasOpenPrForBranch && ((!onMain && (r.ahead > 0 || branchUnmerged)) || (onMain && (r.dirty || r.changedFiles > 0))),
    canCleanMerged: (r.mergedBranches?.length ?? 0) > 0,
  };
}

