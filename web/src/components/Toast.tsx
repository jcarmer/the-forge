import { useSyncExternalStore } from "react";
import type { NoticeData, NoticeKind } from "../views/git/notice";

/** Only the latest toast is kept. Success toasts hide after 1s; warnings and errors stay until dismissed or replaced. */
export interface ToastData {
  id: number;
  kind: NoticeKind;
  title?: string;
  text: string;
  url?: string;
}

const SUCCESS_MS = 1000;
let current: ToastData | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismissToast(): void {
  clearTimeout(timer);
  current = null;
  emit();
}

export function showToast(kind: NoticeKind, text: string, title?: string, url?: string): void {
  clearTimeout(timer);
  const id = nextId++;
  current = { id, kind, text, ...(title ? { title } : {}), ...(url ? { url } : {}) };
  if (kind === "success") {
    timer = setTimeout(() => {
      if (current?.id === id) dismissToast();
    }, SUCCESS_MS);
  }
  emit();
}

/** Shows a git-style notice (extra details such as failed branches are folded into the single line). */
export function showNotice(n: NoticeData | null | undefined): void {
  if (!n) return dismissToast();
  const extra = [
    n.recoveryRef ? `Recover with: git stash apply ${n.recoveryRef}` : "",
    ...(n.results ?? []).map((r) => `${r.branch}: ${r.ok ? "deleted" : "NOT deleted"} - ${r.detail}`),
  ].filter(Boolean);
  showToast(n.kind, [n.text, ...extra].join(" | "), n.title, n.url);
}

/** Shows the error of a caught exception as a persistent toast. */
export function showError(e: unknown): void {
  showToast("error", e instanceof Error ? e.message : String(e));
}

const COLOR: Record<NoticeKind, string> = { success: "#39ff14", error: "#ff3366", warning: "#ff9900" };

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Render once near the app root: a one-line bar at the bottom of the screen. */
export function ToastHost() {
  const t = useSyncExternalStore(subscribe, () => current);
  if (!t) return null;
  const color = COLOR[t.kind];
  const sticky = t.kind !== "success";
  const full = `${t.title ? `${t.title}: ` : ""}${t.text}`;
  return (
    <div
      role={sticky ? "alert" : "status"}
      title={full}
      style={{
        position: "fixed",
        left: 16,
        right: 16,
        bottom: 12,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        background: "#02080a",
        border: `1px solid ${color}`,
        borderLeftWidth: 4,
        color: "#d6fbff",
        fontSize: 13,
        lineHeight: "20px",
        boxShadow: "0 2px 12px rgb(0 0 0 / 0.6)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.title && <strong>{t.title}: </strong>}
        {t.text}
        {t.url && /^https?:\/\//i.test(t.url) && (
          <>
            {" "}
            <a href={t.url} target="_blank" rel="noreferrer" style={{ color }}>
              {t.url}
            </a>
          </>
        )}
      </span>
      {sticky && (
        <button
          onClick={dismissToast}
          aria-label="Dismiss message"
          style={{ background: "none", border: 0, color: "#7aa5aa", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}
        >
          ×
        </button>
      )}
    </div>
  );
}
