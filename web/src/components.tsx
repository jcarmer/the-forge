import { createContext, useContext, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
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

/** Card surface with a pixel padding. */
export function Pane({ padding = 12, width, children }: { padding?: number; width?: number; children: ReactNode }) {
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
      style={{ width, boxSizing: "border-box" }}
    >
      <div style={{ padding }}>{children}</div>
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
      }}
    >
      {children}
    </span>
  );
}

/** Body text. `muted` dims secondary details. */
export function Text({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <span style={{ fontSize: 13, color: muted ? MUTED : FG }}>{children}</span>;
}

/** Label chip. */
export function Badge({ variant = "default", children }: { variant?: Variant; children?: ReactNode }) {
  return (
    <NeonBadge color={COLOR[variant]} variant="outline" shape="corner-cut" size="sm" glow={false}>
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

/** Corner-cut button. primary = solid, secondary/ghost = outline/ghost. */
export function Button({ variant = "primary", size = "sm", loading = false, disabled, children, ...rest }: ButtonProps) {
  const style: CSSProperties = { opacity: disabled || loading ? 0.5 : 1, cursor: disabled || loading ? "not-allowed" : "pointer" };
  return (
    <CornerCutButton
      color={COLOR[variant]}
      variant={variant === "primary" ? "solid" : variant === "ghost" ? "ghost" : "outline"}
      size={size === "sm" ? "xs" : "sm"}
      cornerSize={8}
      hoverEffect="glow"
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
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Text muted>{label}</Text>
      <div style={{ width }}>
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
    <div role="tablist" style={{ display: "flex", flexWrap: "wrap", gap: 4, borderBottom: "1px solid rgb(0 243 255 / 0.25)" }}>
      {children}
    </div>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(TabsCtx);
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx.set(value)}
      style={{
        background: active ? "rgb(0 243 255 / 0.08)" : "transparent",
        border: 0,
        borderBottom: `2px solid ${active ? COLOR.primary : "transparent"}`,
        color: active ? COLOR.primary : MUTED,
        textShadow: active ? "0 0 8px rgb(0 243 255 / 0.6)" : undefined,
        cursor: "pointer",
        padding: "10px 16px",
        font: "600 12px var(--font-ui, 'Orbitron', 'Segoe UI', sans-serif)",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, children }: { value: string; children: ReactNode }) {
  const ctx = useContext(TabsCtx);
  return ctx.value === value ? <div role="tabpanel">{children}</div> : null;
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
