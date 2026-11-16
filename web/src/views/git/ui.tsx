import { useEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Button, Heading, Pane, Text } from "../../components";
import type { GitActionResult } from "../../types";
import { isHttpUrl, type NoticeData } from "./notice";

export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
export const ACCENT = "#00f3ff";

export interface RunOptions {
  /** On failure, do not raise the page banner: the caller (a dialog) shows the error inline. */
  inline?: boolean;
}

/** What every panel needs to run an action: the single busy key, the runner and a banner setter. */
export interface ActionCtx {
  /** Key of the running action, or null. All action buttons are disabled while it is set. */
  busy: string | null;
  /** Runs one action at a time (null when another is running), then refreshes the page data. */
  run: (key: string, title: string, fn: () => Promise<GitActionResult>, opts?: RunOptions) => Promise<GitActionResult | null>;
  notify: (n: NoticeData) => void;
}

/** Labelled native checkbox; the label text is the accessible name. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1, fontSize: 13 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3, accentColor: ACCENT, width: 16, height: 16, flex: "none" }} />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span>{label}</span>
        {hint && <span style={{ fontSize: 12, color: "#7aa5aa" }}>{hint}</span>}
      </span>
    </label>
  );
}

const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "#02080a",
  color: "#d6fbff",
  border: "1px solid #0b7f86",
  borderRadius: 2,
  padding: "8px 10px",
  font: "inherit",
  fontSize: 13,
  resize: "vertical",
};

/** Labelled multi-line field (Neon Blade has no textarea). */
export function TextArea({ label, rows = 4, ...rest }: { label: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Text muted>{label}</Text>
      <textarea rows={rows} style={fieldStyle} {...rest} />
    </label>
  );
}

/** Labelled single-line field built on the shared Input adapter's look (native element so the label wraps it). */
export function TextField({ label, ...rest }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Text muted>{label}</Text>
      <input type="text" style={{ ...fieldStyle, resize: undefined }} {...rest} />
    </label>
  );
}

/** Section card with a heading row (title left, extra controls right). */
export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Pane padding={12}>
      <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Heading>{title}</Heading>
          <div style={{ flex: 1 }} />
          {right}
        </div>
        {children}
      </section>
    </Pane>
  );
}

/** Opens an http(s) URL in a new tab; anything else is rendered as plain text, never as a link. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  if (!isHttpUrl(href)) return <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: ACCENT, fontSize: 13, textDecoration: "underline", overflowWrap: "anywhere" }}>
      {children} <span aria-hidden="true">↗</span>
      <span style={SR_ONLY}> (opens in a new tab)</span>
    </a>
  );
}

export const SR_ONLY: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

/** Copies text; falls back to a hidden textarea where the async clipboard API is unavailable (plain http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        setState((await copyText(text)) ? "copied" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2500);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed - select the text" : label}
    </Button>
  );
}

/** Wraps children in a flex-wrap row. */
export function Row({ children, gap = 8, align = "center" }: { children: ReactNode; gap?: number; align?: CSSProperties["alignItems"] }) {
  return <div style={{ display: "flex", flexWrap: "wrap", alignItems: align, gap }}>{children}</div>;
}

/** Inline error inside a dialog. */
export function InlineError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div role="alert" style={{ border: "1px solid #ff3366", padding: "8px 10px", fontSize: 13, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
      <strong>Failed: </strong>
      {text}
    </div>
  );
}
