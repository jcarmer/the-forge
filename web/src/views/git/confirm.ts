/** Pure helpers for typed confirmations of destructive Git actions. */

export const discardPhrase = (repoName: string): string => `DISCARD ${repoName}`;
export const deleteBranchesPhrase = (repoName: string): string => `DELETE BRANCHES ${repoName}`;

/**
 * The confirm button is enabled only when the user typed the repo name or the exact phrase (case-sensitive; only
 * surrounding whitespace is forgiven). The backend separately requires the exact phrase in `confirm`.
 */
export function isConfirmed(typed: string, repoName: string, phrase: string): boolean {
  const t = typed.trim();
  return t.length > 0 && (t === phrase || t === repoName);
}

export interface DiscardPlanFile {
  path: string;
  status: string;
}

export interface DiscardPlan {
  /** Paths that will be restored to HEAD. */
  tracked: string[];
  /** Untracked paths that will be deleted (only when includeUntracked). */
  deleted: string[];
  /** Untracked paths that stay on disk. */
  kept: string[];
  /** True when nothing would happen (the backend would answer 400). */
  nothingToDo: boolean;
  /** Paths to send to the backend (everything the user sees in the list that will actually be touched). */
  send: string[];
}

export function planDiscard(files: DiscardPlanFile[], includeUntracked: boolean): DiscardPlan {
  const tracked = files.filter((f) => f.status !== "?").map((f) => f.path);
  const untracked = files.filter((f) => f.status === "?").map((f) => f.path);
  const deleted = includeUntracked ? untracked : [];
  const kept = includeUntracked ? [] : untracked;
  return {
    tracked,
    deleted,
    kept,
    nothingToDo: tracked.length + deleted.length === 0,
    // Always send an explicit list so a change that appeared after the page loaded is never discarded unseen.
    send: files.map((f) => f.path),
  };
}
