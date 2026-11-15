import { useState } from "react";
import { Button, Dialog, Input, Text } from "../../components";
import { gitPost } from "../../hooks/useGitRepoApi";
import { deleteBranchesPhrase, isConfirmed } from "./confirm";
import { MONO, Row, type ActionCtx } from "./ui";

/** Deletes local branches already merged into main (git branch -d; the backend re-checks "merged" itself). */
export function DeleteBranchesDialog({ repoName, branches, ctx, onClose }: { repoName: string; branches: string[]; ctx: ActionCtx; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const phrase = deleteBranchesPhrase(repoName);
  const confirmed = isConfirmed(typed, repoName, phrase);
  const submit = async () => {
    await ctx.run("delete-branches", "Delete merged branches", () => gitPost(repoName, "delete-branches", { branches, confirm: phrase }));
    onClose();
  };
  return (
    <Dialog
      open
      title="Delete merged branches"
      variant="danger"
      onClose={onClose}
      dismissable={ctx.busy === null}
      footer={
        <Row>
          <Button variant="ghost" disabled={ctx.busy !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={ctx.busy === "delete-branches"} disabled={ctx.busy !== null || !confirmed || branches.length === 0} onClick={() => void submit()}>
            Delete {branches.length} branch{branches.length === 1 ? "" : "es"}
          </Button>
        </Row>
      }
    >
      <div role="alert" style={{ border: "1px solid #ff3366", padding: "8px 10px", fontSize: 13 }}>
        <strong>Deletes these local branches.</strong> Only branches fully merged into main are removed (git branch -d); the backend refuses anything else. Remote branches are not touched.
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 200, overflow: "auto", fontFamily: MONO, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
        {branches.map((b) => (
          <li key={b} style={{ overflowWrap: "anywhere" }}>
            {b}
          </li>
        ))}
      </ul>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Text muted>
          Type <code style={{ fontFamily: MONO, color: "#ff9db3" }}>{phrase}</code> (or just the repo name <code style={{ fontFamily: MONO }}>{repoName}</code>) to enable the button:
        </Text>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label={`Type ${phrase} to confirm`} />
      </label>
    </Dialog>
  );
}
