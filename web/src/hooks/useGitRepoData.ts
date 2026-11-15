import { useCallback, useEffect, useRef, useState } from "react";
import type { GitBranchesResponse, GitChangesResponse, GitLinks, GitStashEntry } from "../types";
import { gitGet } from "./useGitRepoApi";

export interface RepoDataErrors {
  changes?: string;
  branches?: string;
  stashes?: string;
  links?: string;
}

/**
 * Loads the read-only panels of one repo (changes, branches, stashes, links) independently, so slow `gh` calls for
 * links never hold up the file list. Responses for a previous repo/refresh generation are dropped.
 */
export function useGitRepoData(name: string) {
  const [changes, setChanges] = useState<GitChangesResponse | null>(null);
  const [branches, setBranches] = useState<GitBranchesResponse | null>(null);
  const [stashes, setStashes] = useState<GitStashEntry[] | null>(null);
  const [links, setLinks] = useState<GitLinks | null>(null);
  const [errors, setErrors] = useState<RepoDataErrors>({});
  const [loading, setLoading] = useState(true);
  const gen = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const my = ++gen.current;
    setLoading(true);
    const current = () => alive.current && gen.current === my;
    const load = async <T,>(key: keyof RepoDataErrors, action: string, set: (v: T) => void) => {
      try {
        const v = await gitGet<T>(name, action);
        if (!current()) return;
        set(v);
        setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
      } catch (e) {
        if (current()) setErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : String(e) }));
      }
    };
    await Promise.all([
      load<GitChangesResponse>("changes", "changes", setChanges),
      load<GitBranchesResponse>("branches", "branches", setBranches),
      load<GitStashEntry[]>("stashes", "stashes", setStashes),
      load<GitLinks>("links", "links", setLinks),
    ]);
    if (current()) setLoading(false);
  }, [name]);

  useEffect(() => {
    setChanges(null);
    setBranches(null);
    setStashes(null);
    setLinks(null);
    setErrors({});
    void refresh();
  }, [refresh]);

  return { changes, branches, stashes, links, errors, loading, refresh };
}

export type GitRepoData = ReturnType<typeof useGitRepoData>;
