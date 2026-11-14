import type { CSSProperties, ReactNode } from "react";
import {
  Card,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "reend-components";

/**
 * Thin adapters over `reend-components`. Layout stays with `@tbe/ui` (VStack/HStack/Spacer/Wrap/Scroll/Padded);
 * everything with a visual identity (surfaces, text, badges, inputs, dialogs) comes from reend.
 */

/** Card surface with a pixel padding (reend's prebuilt CSS ships no spacing utilities). */
export function Pane({
  padding = 12,
  width,
  children,
}: {
  padding?: number;
  width?: number;
  children: ReactNode;
}) {
  const style: CSSProperties = { padding, width, boxSizing: "border-box" };
  return <Card style={style}>{children}</Card>;
}

/** Section heading in the reend display font. */
export function Heading({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-ui)",
        fontSize: 12,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "hsl(var(--primary))",
      }}
    >
      {children}
    </span>
  );
}

/** Body text. `muted` dims secondary details. */
export function Text({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-body)",
        fontSize: 13,
        color: muted ? "hsl(var(--muted-foreground))" : "hsl(var(--foreground))",
      }}
    >
      {children}
    </span>
  );
}

/** OK / FAIL style status chip. */
export function StatusBadge({ ok, okText = "OK", failText = "FAIL" }: { ok: boolean; okText?: string; failText?: string }) {
  return <Badge variant={ok ? "success" : "danger"}>{ok ? okText : failText}</Badge>;
}

/** Labelled single-select built on reend's Select. */
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
        <Select value={value} onValueChange={(v) => onChange(v as T)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
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
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <pre style={{ maxHeight: "60vh", overflow: "auto", fontFamily: "var(--font-mono)" }}>{content}</pre>
      </DialogContent>
    </Dialog>
  );
}
