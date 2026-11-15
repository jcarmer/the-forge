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
  openPrs,
  error,
  ctx,
  onDelete,
  onCleanMerged,
  onCreatePr,
  onMergePr,
  selected,
  onSelectedChange,
  onRetry,
}: {
  data: GitBranchesResponse | null;
  openPrs?: { number: number; title: string; url: string; headRefName: string; baseRefName: string; isDraft: boolean }[] | null;
  error?: string;
  ctx: ActionCtx;
  onDelete: (names: string[]) => void;
  onCleanMerged?: () => void;
  onCreatePr: (branch: string) => void;
  onMergePr?: (pr: { number: number; url: string; headRefName: string; title: string }) => void;
  selected: ReadonlySet<string>;
  onSelectedChange: (s: Set<string>) => void;
  onRetry: () => void;
}) {
  const groups = data ? groupBranches(data.branches, data) : null;
  const mainName = data?.mainBranch ?? "main";
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
    <Section title="Pull requests & Branches">
      {openPrs && openPrs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 10, borderBottom: "1px solid rgb(11 127 134 / 0.4)" }}>
          <strong style={{ fontSize: 13 }}>Open pull requests ({openPrs.length})</strong>
          <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {openPrs.map((pr) => (
              <li key={pr.number} style={{ listStyle: "none" }}>
                <Row gap={8}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                    <Row gap={6}>
                      <a href={pr.url} target="_blank" rel="noreferrer" style={{ color: "#00f3ff", fontFamily: MONO, fontSize: 13 }}>
                        #{pr.number}
                      </a>
                      <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{pr.title}</span>
                      {pr.isDraft && <Badge variant="default">draft</Badge>}
                    </Row>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: "#7aa5aa" }}>
                      {pr.headRefName} → {pr.baseRefName}
                    </span>
                  </div>
                  {onMergePr && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={ctx.busy !== null || pr.isDraft}
                      loading={ctx.busy === `merge-pr:${pr.number}`}
                      onClick={() => onMergePr(pr)}
                    >
                      {pr.isDraft ? "Draft PR" : "Squash & merge"}
                    </Button>
                  )}
                </Row>
              </li>
            ))}
          </ul>
          <Text muted>Squash &amp; merge runs `gh pr merge --squash --delete-branch` (no repo admin rights needed) and prunes the local branch.</Text>
        </div>
      )}

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
          {groups.base.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>Main and integration branches ({groups.base.length})</strong>
              <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {groups.base.map((b) => (
                  <li key={b.name} style={{ listStyle: "none" }}>
                    <BranchMeta b={b} />
                  </li>
                ))}
              </ul>
              <Text muted>Protected: never deleted here.</Text>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <strong style={{ fontSize: 13 }}>
              Not merged into {mainName} ({groups.unmerged.length})
            </strong>
            {groups.unmerged.length === 0 ? (
              <Text muted>None.</Text>
            ) : (
              <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {groups.unmerged.map((b) => (
                  <li key={b.name} style={{ listStyle: "none" }}>
                    <Row>
                      <BranchMeta b={b} />
                      <Button variant="secondary" size="sm" disabled={ctx.busy !== null} onClick={() => onCreatePr(b.name)}>
                        Create PR...
                      </Button>
                    </Row>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid rgb(11 127 134 / 0.4)", paddingTop: 10 }}>
            <Row>
              <strong style={{ fontSize: 13 }}>
                Merged into {mainName} ({groups.deletable.length + groups.merged.length})
              </strong>
              <Button variant="ghost" size="sm" aria-expanded={showMerged} onClick={() => setShowMerged((v) => !v)}>
                {showMerged ? "Hide" : "Show"}
              </Button>
              {onCleanMerged && groups.deletable.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={ctx.busy === "clean-merged"}
                  disabled={ctx.busy !== null}
                  onClick={onCleanMerged}
                >
                  Clean all merged ({groups.deletable.length})
                </Button>
              )}
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
                      <Text muted>Checked out: cannot be deleted.</Text>
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
                  Delete selected ({selected.size})...
                </Button>
              </Row>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

