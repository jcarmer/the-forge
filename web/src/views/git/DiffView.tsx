import { useState } from "react";
import { Button, Text } from "../../components";
import { KIND_LABEL, MAX_RENDER_LINES, parseDiff, type DiffLineKind } from "./diffLines";
import { MONO, SR_ONLY } from "./ui";

const BG: Record<DiffLineKind, string> = {
  add: "rgb(57 255 20 / 0.12)",
  del: "rgb(255 51 102 / 0.14)",
  hunk: "rgb(77 159 255 / 0.14)",
  meta: "transparent",
  context: "transparent",
  note: "transparent",
};
const FG: Record<DiffLineKind, string> = {
  add: "#b9ffa8",
  del: "#ffb3c4",
  hunk: "#9cc9ff",
  meta: "#7aa5aa",
  context: "#d6fbff",
  note: "#7aa5aa",
};

/** Unified diff with per-line colouring. The +/- characters stay in the text, so colour is never the only signal. */
export function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const lines = parseDiff(diff);
  if (lines.length === 0) return <Text muted>No textual changes to show.</Text>;
  const shown = showAll ? lines : lines.slice(0, MAX_RENDER_LINES);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        role="region"
        aria-label="File diff"
        tabIndex={0}
        style={{ maxHeight: 420, maxWidth: "100%", overflow: "auto", WebkitOverflowScrolling: "touch", border: "1px solid #0b7f86", background: "#02080a", fontFamily: MONO, fontSize: 12, lineHeight: 1.45 }}
      >
        <div style={{ minWidth: "max-content" }}>
          {shown.map((l, i) => (
            <div key={i} style={{ background: BG[l.kind], color: FG[l.kind], whiteSpace: "pre", padding: "0 8px", fontWeight: l.kind === "hunk" ? 600 : undefined }}>
              <span style={SR_ONLY}>{KIND_LABEL[l.kind]}: </span>
              {l.text || " "}
            </div>
          ))}
        </div>
      </div>
      {lines.length > shown.length && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text muted>
            Showing {shown.length} of {lines.length} lines.
          </Text>
          <Button variant="secondary" size="sm" onClick={() => setShowAll(true)}>
            Show all lines
          </Button>
        </div>
      )}
      {truncated && (
        <div role="note" style={{ color: "#ff9900", fontSize: 12 }}>
          Diff truncated: this file is too large to show in full. The end of the diff is not displayed.
        </div>
      )}
    </div>
  );
}
