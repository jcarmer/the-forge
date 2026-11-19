import { Button, Text } from "../../components";
import { Row, Section, type ActionCtx } from "./ui";

/** Primary actions, visually separated from the file list and the "more" tools. */
export function ActionsBar({
  ctx,
  selectedCount,
  totalCount,
  hasBranch,
  onMain = false,
  mainBranch = "main",
  ahead = 0,
  behind = 0,
  noUpstream = false,
  onCommit,
  onPr,
  onDiscard,
  onPush,
  onPull,
  onSyncMain,
}: {
  ctx: ActionCtx;
  selectedCount: number;
  totalCount: number;
  hasBranch: boolean;
  /** Checked-out branch is the main branch: Create PR then commits the selection to a new branch. */
  onMain?: boolean;
  mainBranch?: string;
  ahead?: number;
  behind?: number;
  noUpstream?: boolean;
  onCommit: () => void;
  onPr: () => void;
  onDiscard: () => void;
  onPush?: () => void;
  onPull?: () => void;
  onSyncMain?: () => void;
}) {
  const disabled = ctx.busy !== null;
  const noneSelected = selectedCount === 0;
  const canPull = hasBranch && !noUpstream && behind > 0 && Boolean(onPull);
  const canPush = hasBranch && (ahead > 0 || noUpstream) && Boolean(onPush);
  const canSync = hasBranch && !onMain && totalCount === 0 && Boolean(onSyncMain);

  return (
    <div style={{ borderTop: "2px solid #00f3ff", paddingTop: 12 }}>
      <Section title="Main actions">
        <Row gap={10}>
          <Button variant="primary" size="md" disabled={disabled || noneSelected || !hasBranch} onClick={onCommit}>
            Commit + push
          </Button>
          {canPush && (
            <Button variant="secondary" size="md" loading={ctx.busy === "push"} disabled={disabled} onClick={onPush}>
              {ahead > 0 ? `Push (↑${ahead})` : "Push branch"}
            </Button>
          )}
          {canPull && (
            <Button variant="secondary" size="md" loading={ctx.busy === "pull"} disabled={disabled} onClick={onPull}>
              Pull (↓{behind})
            </Button>
          )}
          <Button variant="secondary" size="md" disabled={disabled || !hasBranch} onClick={onPr}>
            Create PR
          </Button>
          {canSync && (
            <Button variant="ghost" size="md" loading={ctx.busy === "sync-main"} disabled={disabled} onClick={onSyncMain}>
              Sync from {mainBranch}
            </Button>
          )}
          <div style={{ flex: 1 }} />
          <Button variant="danger" size="md" disabled={disabled || noneSelected} onClick={onDiscard}>
            Discard changes...
          </Button>
        </Row>
        <Text muted>
          {!hasBranch
            ? "Detached HEAD: check out a branch to commit, push, pull or open a PR."
            : totalCount === 0
              ? "Working tree is clean. You can still push unpushed commits, pull upstream changes, sync from main, or open a PR."
              : noneSelected
                ? "Select at least one file above to commit or discard."
                : onMain
                  ? `Create PR will make a new branch, commit the ${selectedCount} selected of ${totalCount} file${totalCount === 1 ? "" : "s"} to it and open a PR, leaving the main branch untouched. Commit + push commits straight to this branch. Discard acts on the same selection, asks you to type a confirmation and keeps a recovery snapshot.`
                  : `Commit + push uses the ${selectedCount} selected of ${totalCount} file${totalCount === 1 ? "" : "s"}. Discard acts on the same selection, asks you to type a confirmation and keeps a recovery snapshot.`}
        </Text>
      </Section>
    </div>
  );
}

