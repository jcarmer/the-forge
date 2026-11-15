import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRepoSummary } from "../types";

const POLL_MS = 30_000;

/** Polls GET /api/git/repos every 30s and when the tab regains focus. */
export function useGitRepos() {
  const [repos, setRepos] = useState<GitRepoSummary[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(false);

  const reload = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/git/repos");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { repos: GitRepoSummary[]; generatedAt: string };
      setRepos(body.repos);
      setGeneratedAt(body.generatedAt);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [reload]);

  return { repos, generatedAt, error, loading, reload };
}

export type GitReposState = ReturnType<typeof useGitRepos>;
