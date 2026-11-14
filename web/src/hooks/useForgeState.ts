import { useCallback, useEffect, useState } from "react";
import type { ForgeState } from "../types";

export async function postAction<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string; detail?: string }).error ?? (data as { detail?: string }).detail ?? `Request failed (${res.status})`);
  return data as T;
}

export function useForgeState() {
  const [state, setState] = useState<ForgeState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as ForgeState);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onmessage = (ev) => {
      try {
        setState(JSON.parse(ev.data) as ForgeState);
        setConnected(true);
        setError(null);
      } catch {
        // ignore malformed keepalive
      }
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [reload]);

  return { state, connected, error, reload };
}
