import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Text } from "../../components";
import { gitPost } from "../../hooks/useGitRepoApi";
import type { GitChangedFile } from "../../types";
import { branchFromTitle } from "./branchName";
import { noticeFrom } from "./notice";
import { statusWord } from "./selection";
import { Checkbox, InlineError, MONO, Row, TextArea, TextField, type ActionCtx } from "./ui";
import { useDraft } from "./useAiSummary";

/**
 * Create a PR from work that is uncommitted on the main branch: pick a new branch name, commit the selected files
 * to it, push, and open the PR. The main branch itself is never committed to.
 */
export function NewBranchPrDialog({
  repoName,
  base,
  selected,
  subset,
  ctx,
  onClose,
}: {
  repoName: string;
  base: string;
  selected: GitChangedFile[];
  subset: boolean;
  ctx: ActionCtx;
  onClose: () => void;
}) {
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef({ branch: false, title: false, message: false });
  const { state, load } = useDraft(repoName);
  const drafting = state.status === "loading";

  const apply = (d: { commitMessage?: string } | null) => {
    if (!d?.commitMessage) return;
    const first = (d.commitMessage.split("\n")[0] ?? "").trim();
    if (!touched.current.message) setMessage(d.commitMessage);
    if (!touched.current.title) setTitle(first);
    if (!touched.current.branch) setBranch(branchFromTitle(first));
    if (!touched.current.message) setBody(d.commitMessage.split("\n").slice(1).join("\n").trim());
  };

  useEffect(() => {
    void load(false).then(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const canSubmit = branch.trim() !== "" && branch.trim() !== base && title.trim() !== "" && message.trim() !== "" && selected.length > 0 && !drafting;

  const submit = async () => {
    setError(null);
    const r = await ctx.run(
      "commit-pr",
      "Commit + create PR",
      () =>
        gitPost(repoName, "commit-pr", {
          branch: branch.trim(),
          message,
          title: title.trim(),
          body,
          base,
          draft,
          ...(subset ? { files: selected.map((f) => f.path) } : {}),
        }),
      { inline: true },
    );
    if (!r) return;
    if (r.ok) onClose();
    else if (r.committed) {
      // Work is committed on the new branch but a later step failed: the page state changed, so show it as a banner.
      ctx.notify(noticeFrom("Commit + create PR", r));
      onClose();
    } else setError(r.detail);
  };

  return (
    <Dialog
      open
      title="Create PR from uncommitted changes"
      onClose={onClose}
      dismissable={ctx.busy === null}
      footer={
        <Row>
          <Button variant="ghost" disabled={ctx.busy !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={ctx.busy === "commit-pr"} disabled={ctx.busy !== null || !canSubmit} onClick={() => void submit()}>
            Commit + create PR
          </Button>
        </Row>
      }
    >
      <Text>
        You are on <span style={{ fontFamily: MONO }}>{base}</span>. This creates a <strong>new branch</strong>, commits the files below to it, pushes it (never forced) and opens a pull request into{" "}
        <span style={{ fontFamily: MONO }}>{base}</span>. Nothing is committed to <span style={{ fontFamily: MONO }}>{base}</span>.
      </Text>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Text muted>{subset ? `Only these ${selected.length} selected files are committed:` : `All ${selected.length} changed files are committed:`}</Text>
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 130, overflow: "auto", fontFamily: MONO, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {selected.map((f) => (
            <li key={f.path} style={{ overflowWrap: "anywhere" }}>
              {f.path} <span style={{ color: "#7aa5aa" }}>({statusWord(f)})</span>
            </li>
          ))}
        </ul>
        {subset && <Text muted>Unselected files stay uncommitted here.</Text>}
      </div>
      <TextField
        label="New branch name"
        value={branch}
        onChange={(e) => {
          touched.current.branch = true;
          setBranch(e.target.value);
        }}
        placeholder={drafting ? "Generating a name..." : "feature/my-change"}
      />
      <TextField
        label="PR title"
        value={title}
        onChange={(e) => {
          touched.current.title = true;
          setTitle(e.target.value);
        }}
        placeholder={drafting ? "Drafting a title..." : "Pull request title"}
      />
      <TextArea
        label="Commit message"
        rows={5}
        value={message}
        onChange={(e) => {
          touched.current.message = true;
          setMessage(e.target.value);
        }}
        placeholder={drafting ? "Drafting a message..." : "Describe the change"}
      />
      <TextArea label="PR description" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Optional" />
      <Row gap={12}>
        <Checkbox checked={draft} onChange={setDraft} label="Open as draft" />
        <Button
          variant="secondary"
          size="sm"
          loading={drafting}
          disabled={ctx.busy !== null}
          onClick={() => {
            touched.current = { branch: false, title: false, message: false };
            void load(true).then(apply);
          }}
        >
          Generate name + message with AI
        </Button>
      </Row>
      {drafting && <Text muted>Asking the local model... you can also fill these in yourself.</Text>}
      {state.status === "error" && <Text muted>AI draft unavailable: {state.detail}</Text>}
      <InlineError text={error} />
    </Dialog>
  );
}
