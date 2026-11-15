/** Pure helpers behind useGitRepos (kept React-free so they are unit-testable). */

/** Poll cadence while the Git tab is open. */
export const GIT_POLL_ACTIVE_MS = 30_000;
/** Slow cadence that only keeps the "Git (n)" tab counter roughly current. */
export const GIT_POLL_BACKGROUND_MS = 120_000;

/** How often to poll GET /api/git/repos, or null for not at all (browser tab hidden). */
export function gitPollInterval(documentVisible: boolean, gitTabActive: boolean): number | null {
  if (!documentVisible) return null;
  return gitTabActive ? GIT_POLL_ACTIVE_MS : GIT_POLL_BACKGROUND_MS;
}

/**
 * Wraps an async loader so at most one run is in flight. A call made while one runs is not dropped: the calls are
 * merged (`merge`) into ONE follow-up run that starts when the current run ends. Each returned promise resolves
 * once a run that started after the call has finished. Errors are the loader's job to report; they never reject.
 */
export function coalesce<A>(fn: (arg: A) => Promise<void>, merge: (queued: A, next: A) => A): (arg: A) => Promise<void> {
  let current: Promise<void> | null = null;
  let queued: { arg: A; done: Promise<void>; resolve: () => void } | null = null;

  const call = (arg: A): Promise<void> => {
    if (!current) {
      current = fn(arg)
        .catch(() => undefined)
        .finally(() => {
          current = null;
          const q = queued;
          queued = null;
          if (q) void call(q.arg).then(q.resolve);
        });
      return current;
    }
    if (queued) {
      queued.arg = merge(queued.arg, arg);
      return queued.done;
    }
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    queued = { arg, done, resolve };
    return done;
  };
  return call;
}

/**
 * Merges a full list response into the current list, keeping any repo whose single-repo refresh landed AFTER the
 * full request started (that copy is newer than what the slow full request saw).
 */
export function mergeFullList<T extends { name: string }>(prev: T[] | null, next: T[], startedAt: number, stamps: ReadonlyMap<string, number>): T[] {
  if (!prev) return next;
  const byName = new Map(prev.map((r) => [r.name, r]));
  return next.map((r) => ((stamps.get(r.name) ?? -1) > startedAt ? (byName.get(r.name) ?? r) : r));
}

/** Replaces (or appends) one repo in the list; `null` removes it (e.g. the repo was deleted). */
export function replaceRepo<T extends { name: string }>(prev: T[] | null, name: string, next: T | null): T[] | null {
  if (!prev) return next ? [next] : prev;
  const i = prev.findIndex((r) => r.name === name);
  if (!next) return i < 0 ? prev : prev.filter((r) => r.name !== name);
  if (i < 0) return [...prev, next];
  const copy = prev.slice();
  copy[i] = next;
  return copy;
}
