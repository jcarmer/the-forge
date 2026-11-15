import { useState } from "react";
import { Button, Dialog, Input, Text } from "../../components";
import { gitPost } from "../../hooks/useGitRepoApi";
import type { GitChangedFile } from "../../types";
import { discardPhrase, isConfirmed, planDiscard } from "./confirm";
import { statusWord } from "./selection";
import { Checkbox, InlineError, MONO, Row, type ActionCtx } from "./ui";

/** DESTRUCTIVE: restores files to HEAD (and optionally deletes untracked files). Requires typing the repo name or phrase. */
export function DiscardDialog({
  repoName,
  files,
  scope,
  ctx,
  onClose,
}: {
  repoName: string;
  files: GitChangedFile[];
  /** Human description of what the list is: "all uncommitted changes", "the selected files", "this file". */
  scope: string;
  ctx: ActionCtx;
  onClose: () => void;
}) {
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const phrase = discardPhrase(repoName);
  const plan = planDiscard(files, includeUntracked);
  const confirmed = isConfirmed(typed, repoName, phrase);
  const hasUntracked = files.some((f) => f.status === "?");

  const submit = async () => {
    setError(null);
    const r = await ctx.run("discard", "Discard changes", () => gitPost(repoName, "discard", { confirm: phrase, files: plan.send, includeUntracked }), { inline: true });
    if (!r) return;
    if (r.ok) onClose();
    else setError(r.detail);
  };

  return (
    <Dialog
      open
      title="Discard changes"
      variant="danger"
      onClose={onClose}
      dismissable={ctx.busy === null}
      footer={
        <Row>
          <Button variant="ghost" disabled={ctx.busy !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={ctx.busy === "discard"} disabled={ctx.busy !== null || !confirmed || plan.nothingToDo} onClick={() => void submit()}>
            Discard {plan.tracked.length + plan.deleted.length} file{plan.tracked.length + plan.deleted.length === 1 ? "" : "s"}
          </Button>
        </Row>
      }
    >
      <div role="alert" style={{ border: "1px solid #ff3366", padding: "8px 10px", fontSize: 13 }}>
        <strong>This throws away your uncommitted work in {repoName}.</strong> Modified files go back to the last commit. A recovery snapshot is saved and shown afterwards, but treat this as destructive.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Text>You are discarding {scope}:</Text>
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 180, overflow: "auto", fontFamily: MONO, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {files.map((f) => {
            const kept = plan.kept.includes(f.path);
            const deleted = plan.deleted.includes(f.path);
            const nested = plan.nested.includes(f.path);
            return (
              <li key={f.path} style={{ overflowWrap: "anywhere" }}>
                {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}{" "}
                <span style={{ color: kept ? "#7aa5aa" : "#ff9db3" }}>
                  ({statusWord(f)}
                  {nested ? ": nested git repository, always KEPT" : kept ? ": will be KEPT" : deleted ? ": will be DELETED" : ": will be restored"})
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {hasUntracked && (
        <Checkbox
          checked={includeUntracked}
          onChange={setIncludeUntracked}
          label="Also delete untracked files"
          hint="Untracked files are not in git yet. They stay on disk unless you tick this."
        />
      )}
      {plan.nested.length > 0 && <Text muted>Nested git repositories have their own history and are never deleted here; remove them by hand if you really mean to.</Text>}
      {plan.nothingToDo && (
        <Text muted>{plan.kept.every((p) => plan.nested.includes(p)) ? "Nothing would be discarded." : 'Nothing would be discarded: only untracked files are listed. Tick "Also delete untracked files" to remove them.'}</Text>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Text muted>
          Type <code style={{ fontFamily: MONO, color: "#ff9db3" }}>{phrase}</code> (or just the repo name <code style={{ fontFamily: MONO }}>{repoName}</code>) to enable the button:
        </Text>
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-label={`Type ${phrase} to confirm`} />
      </label>
      <InlineError text={error} />
    </Dialog>
  );
}
