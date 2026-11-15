import { useCallback, useEffect, useRef, useState } from "react";
import type { GitDraftMessage, GitSummaryResponse } from "../../types";
import { gitPost } from "../../hooks/useGitRepoApi";

export interface SummaryState {
  status: "idle" | "loading" | "ok" | "error";
  model?: string;
  summary?: string;
  cached?: boolean;
  detail?: string;
}

/**
 * Requests the AI summary of the working-tree changes (POST /summary; may take ~2 minutes) whenever `enabled` and the
 * change signature changes. Never blocks the page; a response for an earlier request (or after unmount / repo change)
 * is ignored, and the previous summary stays visible while a new one loads.
 */
export function useAiSummary(repoName: string, enabled: boolean, signature: string) {
  const [state, setState] = useState<SummaryState>({ status: "idle" });
  const ctl = useRef<AbortController | null>(null);

  const request = useCallback(
    async (regenerate: boolean) => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      setState((s) => ({ ...s, status: "loading", detail: undefined }));
      try {
        const r = await gitPost<GitSummaryResponse>(repoName, "summary", regenerate ? { regenerate: true } : {}, c.signal);
        if (c.signal.aborted) return;
        if (r.ok && r.summary) setState({ status: "ok", model: r.model, summary: r.summary, cached: r.cached });
        else setState((s) => ({ status: "error", model: r.model || s.model, detail: r.detail || "The local model did not return a summary." }));
      } catch (e) {
        if (!c.signal.aborted) setState({ status: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [repoName],
  );

  useEffect(() => {
    if (!enabled) {
      ctl.current?.abort();
      setState({ status: "idle" });
      return;
    }
    void request(false);
    return () => ctl.current?.abort();
    // `signature` re-triggers the request when the changes differ; the backend caches by diff so this is cheap.
  }, [enabled, signature, request]);

  return { state, regenerate: () => request(true) };
}

export interface DraftState {
  status: "idle" | "loading" | "ok" | "error";
  draft?: GitDraftMessage;
  detail?: string;
}

/** Fetches an AI draft of the commit message / PR title+body. Call `load()` on mount; `load(true)` regenerates. */
export function useDraft(repoName: string) {
  const [state, setState] = useState<DraftState>({ status: "idle" });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const load = useCallback(
    async (regenerate = false): Promise<GitDraftMessage | null> => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      setState((s) => ({ ...s, status: "loading", detail: undefined }));
      try {
        const r = await gitPost<GitDraftMessage>(repoName, "draft-message", regenerate ? { regenerate: true } : {}, c.signal);
        if (c.signal.aborted) return null;
        if (r.ok) {
          setState({ status: "ok", draft: r });
          return r;
        }
        setState({ status: "error", detail: r.detail || "The local model did not return a draft." });
      } catch (e) {
        if (!c.signal.aborted) setState({ status: "error", detail: e instanceof Error ? e.message : String(e) });
      }
      return null;
    },
    [repoName],
  );

  return { state, load };
}
