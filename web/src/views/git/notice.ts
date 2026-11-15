import type { GitActionResult } from "../../types";

/** Only plain http(s) URLs may become clickable links (never `javascript:`, `data:` ...). */
export function isHttpUrl(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

export type NoticeKind = "success" | "error" | "warning";

export interface NoticeData {
  kind: NoticeKind;
  /** Short title, e.g. "Commit + push". */
  title: string;
  /** Backend `detail`. */
  text: string;
  url?: string;
  recoveryRef?: string;
  conflict?: boolean;
  results?: { branch: string; ok: boolean; detail: string }[];
}

/** Maps a backend action result to a banner. A conflict, a partly-failed batch or a local-only commit is a warning. */
export function noticeFrom(title: string, r: Partial<GitActionResult> & { ok: boolean }): NoticeData {
  const results = Array.isArray(r.results) ? r.results : undefined;
  const someOk = results?.some((x) => x.ok) ?? false;
  let kind: NoticeKind;
  if (r.ok) kind = "success";
  else if (r.conflict || (results && someOk) || r.committed) kind = "warning";
  else kind = "error";
  return {
    kind,
    title,
    text: r.detail || r.error || (r.ok ? "Done." : "The action failed."),
    ...(typeof r.url === "string" && r.url ? { url: r.url } : {}),
    ...(typeof r.recoveryRef === "string" && r.recoveryRef ? { recoveryRef: r.recoveryRef } : {}),
    ...(r.conflict ? { conflict: true } : {}),
    ...(results ? { results } : {}),
  };
}
