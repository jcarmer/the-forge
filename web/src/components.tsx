import { createContext, useContext, useEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { CornerCutButton } from "./components/neonblade-ui/corner-cut-button";
import { Badge as NeonBadge } from "./components/neonblade-ui/badge";
import { NotchCard } from "./components/neonblade-ui/notch-card";
import { NeonSelect } from "./components/neonblade-ui/neon-select";
import { NeonModal } from "./components/neonblade-ui/neon-modal";
import NeonInput from "./components/neonblade-ui/neon-input";
import { ProgressBar } from "./components/neonblade-ui/progress-bar";

/**
 * Thin adapters over Neon Blade UI (components copied into ./components/neonblade-ui).
 * Layout stays with `@tbe/ui` (VStack/HStack/Spacer/Wrap/Scroll/Padded); everything with a visual identity
 * (surfaces, text, badges, buttons, inputs, tabs, dialogs) comes from here. The props mirror what the views
 * used with the previous component set, so views only import from this file.
 */

export type Variant = "default" | "primary" | "secondary" | "success" | "warning" | "danger" | "info" | "ghost";

/** Semantic variant -> neon colour. */
const COLOR: Record<Variant, string> = {
  default: "#6f9aa0",
  primary: "#00f3ff",
  secondary: "#00f3ff",
  success: "#39ff14",
  warning: "#ff9900",
  danger: "#ff3366",
  info: "#4d9fff",
  ghost: "#00f3ff",
};

const MUTED = "#7aa5aa";
const FG = "#d6fbff";

/** Responsive wrapping flex row (unlike @tbe/ui HStack, wraps gracefully on narrow phone screens). */
export function WrapRow({
  gap = 8,
  align = "center",
  justify,
  style,
  children,
}: {
  gap?: number;
  align?: CSSProperties["alignItems"];
  justify?: CSSProperties["justifyContent"];
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: align, justifyContent: justify, gap, minWidth: 0, ...style }}>
      {children}
    </div>
  );
}

/** Card surface with a pixel padding. */
export function Pane({
  padding = 12,
  width,
  style,
  children,
}: {
  padding?: number;
  width?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <NotchCard
      notchSides={["top", "bottom"]}
      notchSize={6}
      notchWidth={36}
      borderWidth={1}
      borderColor="#0b7f86"
      glowIntensity="low"
      hoverEffect="none"
      cardColor="#030c0e"
      innerClassName="p-0!"
      style={{ width, maxWidth: "100%", minWidth: 0, boxSizing: "border-box", ...style }}
    >
      <div style={{ padding, minWidth: 0 }}>{children}</div>
    </NotchCard>
  );
}

/** Section heading. */
export function Heading({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-ui, 'Orbitron', 'Segoe UI', sans-serif)",
        fontSize: 12,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: COLOR.primary,
        textShadow: "0 0 8px rgb(0 243 255 / 0.55)",
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </span>
  );
}

/** Body text. `muted` dims secondary details. */
export function Text({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span style={{ fontSize: 13, color: muted ? MUTED : FG, overflowWrap: "anywhere" }}>{children}</span>;
}

/** Label chip. */
export function Badge({ variant = "default", children }: { variant?: Variant; children?: ReactNode }) {
  return (
    <NeonBadge className="forge-badge" color={COLOR[variant]} variant="outline" shape="corner-cut" size="sm" glow={false}>
      {children}
    </NeonBadge>
  );
}

/** OK / FAIL style status chip. */
export function StatusBadge({ ok, okText = "OK", failText = "FAIL" }: { ok: boolean; okText?: string; failText?: string }) {
  return <Badge variant={ok ? "success" : "danger"}>{ok ? okText : failText}</Badge>;
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> & {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
};

const DISABLED_GRAY = "#5b6168";
const DISABLED_TEXT = "#aab0b6";

/** Corner-cut button. primary = solid, secondary/ghost = outline/ghost. */
export function Button({ variant = "primary", size = "sm", loading = false, disabled, children, ...rest }: ButtonProps) {
  const style: CSSProperties = { opacity: loading ? 0.5 : disabled ? 0.85 : 1, cursor: disabled || loading ? "not-allowed" : "pointer" };
  // Disabled (but not merely loading) buttons turn a medium-dark gray so they read as inactive.
  const grayed = Boolean(disabled) && !loading;
  return (
    <CornerCutButton
      color={grayed ? DISABLED_GRAY : COLOR[variant]}
      textColor={grayed ? DISABLED_TEXT : undefined}
      hoverEffect={grayed ? "none" : "glow"}
      variant={variant === "primary" ? "solid" : variant === "ghost" ? "ghost" : "outline"}
      size={size === "sm" ? "sm" : "md"}
      cornerSize={12}
      disabled={disabled || loading}
      style={style}
      {...rest}
    >
      {loading ? "… " : null}
      {children}
    </CornerCutButton>
  );
}

/** Text input (native input props). */
export function Input({ ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix">) {
  return <NeonInput shape="corner-cut" cornerSize={8} size="sm" {...props} />;
}

/** Quota-style bar. */
export function Progress({
  value,
  max = 100,
  showLabel,
  variant = "default",
}: {
  value: number;
  max?: number;
  showLabel?: boolean;
  variant?: Variant;
  "aria-label"?: string;
}) {
  return <ProgressBar value={value} max={max} showLabel={showLabel} color={COLOR[variant === "default" ? "primary" : variant]} variant="segmented" size="sm" />;
}

/** Labelled single-select. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  width = 200,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (key: T) => void;
  width?: number;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, maxWidth: "100%", minWidth: 0, flex: "0 1 auto" }}>
      <Text muted>{label}</Text>
      <div style={{ width: `min(100%, ${width}px)`, minWidth: 140, maxWidth: "100%", flex: "1 1 160px" }}>
        <NeonSelect
          size="sm"
          variant="corner-cut"
          value={value}
          options={options.map((o) => ({ value: o.key, label: o.label }))}
          onChange={(v) => onChange(v as T)}
          ariaLabel={label}
        />
      </div>
    </div>
  );
}

/* ── Tabs (Neon Blade has no tabs component; same API as before, styled to match) ── */

const TabsCtx = createContext<{ value: string; set: (v: string) => void }>({ value: "", set: () => {} });

export function Tabs({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) {
  return <TabsCtx.Provider value={{ value, set: onValueChange }}>{children}</TabsCtx.Provider>;
}

export function TabsList({ children }: { children: ReactNode }) {
  return (
    <div role="tablist" className="forge-tabs">
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(TabsCtx);
  const active = ctx.value === value;
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) wrapRef.current?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [active]);
  return (
    <div ref={wrapRef} style={{ display: "inline-flex", flexShrink: 0 }}>
      <CornerCutButton
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => ctx.set(value)}
        color={COLOR.primary}
        variant={active ? "solid" : "ghost"}
        size="xs"
        cornerSize={8}
        hoverEffect="glow"
      >
        {children}
      </CornerCutButton>
    </div>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(TabsCtx);
  return ctx.value === value ? <div role="tabpanel" style={{ minWidth: 0 }}>{children}</div> : null;
}

/** Modal showing preformatted text (logs, API.d.ts). */
export function TextDialog({
  open,
  title,
  content,
  onClose,
}: {
  open: boolean;
  title: string;
  content: string;
  onClose: () => void;
}) {
  return (
    <NeonModal open={open} onClose={onClose} size="xl" corner="all" cornerSize={14} header={{ title }} ariaLabel={title}>
      <pre style={{ maxHeight: "60vh", overflow: "auto", margin: 0, color: FG, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}>
        {content}
      </pre>
    </NeonModal>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab / Shift+Tab inside the open dialog (Neon Blade's modal only focuses the panel on open). */
function trapTab(e: KeyboardEvent) {
  if (e.key !== "Tab") return;
  const dlg = (e.target as HTMLElement).closest<HTMLElement>('[role="dialog"]');
  if (!dlg) return;
  const items = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === dlg)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * General modal dialog: title, arbitrary body, footer actions. Focus is trapped while open and returns to the
 * previously focused control on close. `dismissable=false` (e.g. while an action runs) disables Escape/backdrop close.
 * Mount it conditionally if its inner state should reset on every open.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  variant = "primary",
  dismissable = true,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: Variant;
  dismissable?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, [open]);
  return (
    <div style={{ display: "contents" }} onKeyDown={trapTab}>
      <NeonModal
        open={open}
        onClose={() => {
          if (dismissable) onClose();
        }}
        closeOnBackdrop={dismissable}
        closeOnEscape={dismissable}
        showCloseButton={dismissable}
        size="lg"
        corner="all"
        cornerSize={14}
        color={COLOR[variant]}
        scrollableBody
        header={{ title }}
        footer={footer ? { children: footer, align: "right" } : undefined}
        ariaLabel={title}
      >
        <div style={{ color: FG, fontSize: 13, display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
      </NeonModal>
    </div>
  );
}
