import { Button, Text } from "../../components";
import { Row, Section, type ActionCtx } from "./ui";

/** Primary actions, visually separated from the file list and the "more" tools. */
export function ActionsBar({
  ctx,
  selectedCount,
  totalCount,
  hasBranch,
  onMain = false,
  onCommit,
  onPr,
  onDiscard,
}: {
  ctx: ActionCtx;
  selectedCount: number;
  totalCount: number;
  hasBranch: boolean;
  /** Checked-out branch is the main branch: Create PR then commits the selection to a new branch. */
  onMain?: boolean;
  onCommit: () => void;
  onPr: () => void;
  onDiscard: () => void;
}) {
  const disabled = ctx.busy !== null;
  const noneSelected = selectedCount === 0;
  return (
    <div style={{ borderTop: "2px solid #00f3ff", paddingTop: 12 }}>
      <Section title="Main actions">
        <Row gap={10}>
          <Button variant="primary" size="md" disabled={disabled || noneSelected || !hasBranch} onClick={onCommit}>
            Commit + push
          </Button>
          <Button variant="secondary" size="md" disabled={disabled || !hasBranch} onClick={onPr}>
            Create PR
          </Button>
          <div style={{ flex: 1, minWidth: 16 }} />
          <Button variant="danger" size="md" disabled={disabled || noneSelected} onClick={onDiscard}>
            Discard changes...
          </Button>
        </Row>
        <Text muted>
          {!hasBranch
            ? "Detached HEAD: check out a branch to commit or open a PR."
            : totalCount === 0
              ? "Nothing to commit or discard. Create PR still works for commits that are already on the branch."
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
