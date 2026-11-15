import type { GitActionResult } from "../types";

/**
 * Local fetch helpers for /api/git/repo/<name>/<action>. Unlike the shared `postAction`, these keep the whole JSON
 * body on HTTP 400 (so `detail`, `conflict`, `results[]` ... survive) and never throw for POSTs.
 */
const base = (name: string) => `/api/git/repo/${encodeURIComponent(name)}`;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function detailOf(data: unknown, fallback: string): string {
  const d = data as { detail?: unknown; error?: unknown } | null;
  if (d && typeof d.detail === "string" && d.detail) return d.detail;
  if (d && typeof d.error === "string" && d.error) return d.error;
  return fallback;
}

/** GET; throws Error(detail) on any failure. */
export async function gitGet<T>(name: string, action: string, query?: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const res = await fetch(`${base(name)}/${action}${qs}`, { signal });
  const data = await readJson(res);
  if (!res.ok) throw new Error(detailOf(data, `Request failed (${res.status})`));
  return data as T;
}

/**
 * POST; resolves with the backend body for both 200 and 400. On a transport/parse failure it resolves with
 * `{ ok: false, detail }` only (other fields absent), so callers must treat extra fields as optional.
 * Aborted requests reject with the AbortError so callers can ignore them.
 */
export async function gitPost<T extends { ok: boolean } = GitActionResult>(
  name: string,
  action: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  try {
    const res = await fetch(`${base(name)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = await readJson(res);
    if (data && typeof data === "object" && typeof (data as { ok?: unknown }).ok === "boolean") {
      const r = data as T & { detail?: string };
      // A non-2xx status is a failure even if the body says ok; a failure always carries a detail string.
      const ok = res.ok && r.ok;
      return ok ? r : ({ ...r, ok: false, detail: r.detail || detailOf(data, `Request failed (${res.status})`) } as T);
    }
    return { ok: false, detail: detailOf(data, `Request failed (${res.status})`) } as unknown as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ok: false, detail: e instanceof Error ? e.message : String(e) } as unknown as T;
  }
}
