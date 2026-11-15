import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitRepoSummary } from "../types";
import { coalesce, gitPollInterval, mergeFullList, replaceRepo } from "./gitPolling";

export interface ReloadOpts {
  /** Explicit user refresh: the server fetches now and re-queries gh instead of using its short caches. */
  refresh?: boolean;
}

interface ReposBody {
  repos: GitRepoSummary[];
  generatedAt: string;
}

async function getRepos(query: Record<string, string>): Promise<ReposBody> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`/api/git/repos${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { detail?: unknown };
      if (typeof b.detail === "string" && b.detail) detail = b.detail;
    } catch {
      /* keep the status text */
    }
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return (await res.json()) as ReposBody;
}

/**
 * Repo summaries for the Git tab and its "Git (n)" counter. Polls only while the browser tab is visible: every 30s
 * while the Git tab is open, every 120s otherwise (just for the counter). Reloads requested while one is running are
 * merged into one follow-up reload (never dropped). `reloadRepo` refreshes a single repo after an action.
 */
export function useGitRepos({ active }: { active: boolean }) {
  const [repos, setRepos] = useState<GitRepoSummary[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  /** Per repo: `seq` value when its last single-repo refresh landed. */
  const stamps = useRef(new Map<string, number>());

  const loadAll = useCallback(async (opts: ReloadOpts) => {
    const startedAt = ++seq.current;
    setLoading(true);
    try {
      const body = await getRepos(opts.refresh ? { refresh: "1" } : {});
      setRepos((prev) => mergeFullList(prev, body.repos, startedAt, stamps.current));
      setGeneratedAt(body.generatedAt);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const runner = useMemo(() => coalesce<ReloadOpts>(loadAll, (a, b) => ({ refresh: Boolean(a.refresh || b.refresh) })), [loadAll]);
  const reload = useCallback((opts: ReloadOpts = {}) => runner(opts), [runner]);

  const reloadRepo = useCallback(async (name: string, opts: ReloadOpts = {}) => {
    try {
      const body = await getRepos({ repo: name, ...(opts.refresh ? { refresh: "1" } : {}) });
      stamps.current.set(name, ++seq.current);
      setRepos((prev) => replaceRepo(prev, name, body.repos[0] ?? null));
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        stamps.current.set(name, ++seq.current);
        setRepos((prev) => replaceRepo(prev, name, null));
      } else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Load on mount and whenever the Git tab is opened.
  const wasActive = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasActive.current === null || (active && !wasActive.current)) void reload();
    wasActive.current = active;
  }, [active, reload]);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      if (id !== undefined) clearInterval(id);
      id = undefined;
      const ms = gitPollInterval(document.visibilityState === "visible", active);
      if (ms !== null) id = setInterval(() => void reload(), ms);
    };
    const onVisibility = () => {
      schedule();
      if (document.visibilityState === "visible" && active) void reload();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (id !== undefined) clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, reload]);

  return { repos, generatedAt, error, loading, reload, reloadRepo };
}

export type GitReposState = ReturnType<typeof useGitRepos>;
