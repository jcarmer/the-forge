import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Text } from "../../components";
import { gitPost } from "../../hooks/useGitRepoApi";
import { Checkbox, InlineError, MONO, Row, TextArea, TextField, type ActionCtx } from "./ui";
import { useDraft } from "./useAiSummary";

export function PrDialog({
  repoName,
  branch,
  canDraft = true,
  defaultBase,
  uncommitted,
  ahead,
  ctx,
  onClose,
}: {
  repoName: string;
  branch: string;
  /** AI drafting reads the checked-out branch, so it is off when the PR is for another branch. */
  canDraft?: boolean;
  defaultBase: string;
  uncommitted: number;
  ahead: number;
  ctx: ActionCtx;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [draft, setDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);
  const { state, load } = useDraft(repoName, "pr");
  const drafting = state.status === "loading";

  useEffect(() => {
    if (!canDraft) {
      setTitle((t) => t || branch.replace(/^[^/]+\//, "").replace(/[-_]+/g, " "));
      return;
    }
    void load(false).then((d) => {
      if (d && !touched.current) {
        if (d.prTitle) setTitle(d.prTitle);
        if (d.prBody) setBody(d.prBody);
      }
    });
  }, [load, canDraft, branch]);

  const sameBranch = base.trim() === branch;
  const canSubmit = title.trim() !== "" && base.trim() !== "" && !sameBranch && !drafting;

  const submit = async () => {
    setError(null);
    const r = await ctx.run(
      "create-pr",
      "Create PR",
      () => gitPost(repoName, "create-pr", { title: title.trim(), body, base: base.trim(), head: branch, draft }),
      { inline: true },
    );
    if (!r) return;
    if (r.ok) onClose();
    else setError(r.pushed ? `The branch was pushed, but the pull request could not be created: ${r.detail}` : r.detail);
  };

  return (
    <Dialog
      open
      title="Create pull request"
      onClose={onClose}
      dismissable={ctx.busy === null}
      footer={
        <Row>
          <Button variant="ghost" disabled={ctx.busy !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={ctx.busy === "create-pr"} disabled={ctx.busy !== null || !canSubmit} onClick={() => void submit()}>
            Create PR
          </Button>
        </Row>
      }
    >
      <Text>
        This will <strong>push</strong> <span style={{ fontFamily: MONO }}>{branch}</span> to origin first (never forced), then open a pull request into{" "}
        <span style={{ fontFamily: MONO }}>{base || "..."}</span>.
        {ahead > 0 ? ` ${ahead} local commit${ahead === 1 ? " is" : "s are"} not on the remote yet.` : ""}
      </Text>
      {uncommitted > 0 && (
        <div role="note" style={{ border: "1px solid #ff9900", padding: "8px 10px", fontSize: 13 }}>
          <strong>Warning:</strong> {uncommitted} uncommitted file{uncommitted === 1 ? "" : "s"} will NOT be in this pull request. Use Commit + push first if you want them included.
        </div>
      )}
      <TextField
        label="Title"
        value={title}
        onChange={(e) => {
          touched.current = true;
          setTitle(e.target.value);
        }}
        placeholder={drafting ? "Drafting a title..." : "Pull request title"}
      />
      <TextArea
        label="Description"
        rows={7}
        value={body}
        onChange={(e) => {
          touched.current = true;
          setBody(e.target.value);
        }}
        placeholder={drafting ? "Drafting a description..." : "Optional"}
      />
      <Row gap={12} align="flex-end">
        <div style={{ flex: "1 1 160px" }}>
          <TextField label="Base branch" value={base} onChange={(e) => setBase(e.target.value)} />
        </div>
        <Checkbox checked={draft} onChange={setDraft} label="Open as draft" />
      </Row>
      {sameBranch && <span role="alert" style={{ color: "#ff9db3", fontSize: 13 }}>The base branch must differ from {branch}.</span>}
      {canDraft && <Row>
        <Button
          variant="secondary"
          size="sm"
          loading={drafting}
          disabled={ctx.busy !== null}
          onClick={() =>
            void load(true).then((d) => {
              if (d) {
                touched.current = false;
                if (d.prTitle) setTitle(d.prTitle);
                if (d.prBody) setBody(d.prBody);
              }
            })
          }
        >
          Draft with AI
        </Button>
        {drafting && <Text muted>Asking the local model... you can also write your own.</Text>}
        {state.status === "error" && <Text muted>AI draft unavailable: {state.detail}</Text>}
      </Row>}
      <InlineError text={error} />
    </Dialog>
  );
}
