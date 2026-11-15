import { useEffect, useState } from "react";
import { Badge, Button, Text } from "../../components";
import type { GitBranchInfo, GitBranchesResponse } from "../../types";
import { groupBranches, pruneBranchSelection } from "./selection";
import { Checkbox, MONO, Row, Section, type ActionCtx } from "./ui";

function BranchMeta({ b }: { b: GitBranchInfo }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <Row gap={6}>
        <span style={{ fontFamily: MONO, fontSize: 13, overflowWrap: "anywhere" }}>{b.name}</span>
        {b.isCurrent && <Badge variant="primary">current</Badge>}
        {b.compareTo && (b.ahead > 0 || b.behind > 0) && (
          <Badge variant={b.behind > 0 ? "warning" : "info"}>
            ahead {b.ahead} / behind {b.behind} vs {b.compareTo}
          </Badge>
        )}
        {!b.hasRemote && <Badge variant="default">local only</Badge>}
      </Row>
      <span style={{ fontSize: 12, color: "#7aa5aa", overflowWrap: "anywhere" }}>
        {b.lastCommit.subject} · {b.lastCommit.sha} · {new Date(b.lastCommit.date).toLocaleDateString()}
      </span>
    </div>
  );
}

export function BranchesPanel({
  data,
  error,
  ctx,
  onDelete,
  selected,
  onSelectedChange,
  onRetry,
}: {
  data: GitBranchesResponse | null;
  error?: string;
  ctx: ActionCtx;
  onDelete: (names: string[]) => void;
  selected: ReadonlySet<string>;
  onSelectedChange: (s: Set<string>) => void;
  onRetry: () => void;
}) {
  const groups = data ? groupBranches(data.branches) : null;
  const [showMerged, setShowMerged] = useState(true);
  // Drop selections for branches that vanished or stopped being deletable after a refresh.
  useEffect(() => {
    if (!groups) return;
    const pruned = pruneBranchSelection(selected, groups.deletable);
    if (pruned.size !== selected.size) onSelectedChange(pruned);
  }, [groups, selected, onSelectedChange]);

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (!next.delete(name)) next.add(name);
    onSelectedChange(next);
  };

  return (
    <Section title="Branches">
      {error && !data ? (
        <Row>
          <Text muted>Could not load branches: {error}</Text>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </Row>
      ) : !groups ? (
        <Text muted>Loading branches...</Text>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <strong style={{ fontSize: 13 }}>Not merged into main ({groups.unmerged.length})</strong>
            {groups.unmerged.length === 0 ? (
              <Text muted>None.</Text>
            ) : (
              <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {groups.unmerged.map((b) => (
                  <li key={b.name} style={{ listStyle: "none" }}>
                    <BranchMeta b={b} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid rgb(11 127 134 / 0.4)", paddingTop: 10 }}>
            <Row>
              <strong style={{ fontSize: 13 }}>Merged into main ({groups.deletable.length + groups.merged.length})</strong>
              <Button variant="ghost" size="sm" aria-expanded={showMerged} onClick={() => setShowMerged((v) => !v)}>
                {showMerged ? "Hide" : "Show"}
              </Button>
            </Row>
            {showMerged && (
              <>
                {groups.deletable.length === 0 && groups.merged.length === 0 && <Text muted>No merged branches to clean up.</Text>}
                <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {groups.deletable.map((b) => (
                    <li key={b.name} style={{ listStyle: "none" }}>
                      <Checkbox checked={selected.has(b.name)} onChange={() => toggle(b.name)} disabled={ctx.busy !== null} label={<BranchMeta b={b} />} />
                    </li>
                  ))}
                  {groups.merged.map((b) => (
                    <li key={b.name} style={{ listStyle: "none", opacity: 0.8 }}>
                      <BranchMeta b={b} />
                      <Text muted>{b.isCurrent ? "Checked out: cannot be deleted." : "Protected branch: cannot be deleted here."}</Text>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {groups.deletable.length > 0 && (
              <Row>
                <Button variant="ghost" size="sm" onClick={() => onSelectedChange(new Set(groups.deletable.map((b) => b.name)))} disabled={selected.size === groups.deletable.length}>
                  Select all merged
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onSelectedChange(new Set())} disabled={selected.size === 0}>
                  Select none
                </Button>
                <Button variant="danger" size="sm" disabled={ctx.busy !== null || selected.size === 0} onClick={() => onDelete([...selected])}>
                  Delete merged branches ({selected.size})...
                </Button>
              </Row>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
