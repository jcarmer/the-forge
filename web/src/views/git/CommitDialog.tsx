import { useEffect, useRef, useState } from "react";
import { Badge, Button, Dialog, Text } from "../../components";
import { gitPost } from "../../hooks/useGitRepoApi";
import type { GitChangedFile } from "../../types";
import { noticeFrom } from "./notice";
import { statusWord } from "./selection";
import { InlineError, MONO, Row, TextArea, type ActionCtx } from "./ui";
import { useDraft } from "./useAiSummary";

export function CommitDialog({
  repoName,
  branch,
  upstream,
  selected,
  subset,
  ctx,
  onClose,
}: {
  repoName: string;
  branch: string;
  /** Upstream of the current branch (e.g. origin/feature), if any. */
  upstream?: string;
  selected: GitChangedFile[];
  /** True when only some of the changed files are selected (sends an explicit list). */
  subset: boolean;
  ctx: ActionCtx;
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);
  const { state, load } = useDraft(repoName);
  const drafting = state.status === "loading";

  useEffect(() => {
    void load(false).then((d) => {
      if (d && !touched.current && d.commitMessage) setMessage(d.commitMessage);
    });
  }, [load]);

  const submit = async () => {
    setError(null);
    const r = await ctx.run(
      "commit",
      "Commit + push",
      () => gitPost(repoName, "commit-push", { message, ...(subset ? { files: selected.map((f) => f.path) } : {}) }),
      { inline: true },
    );
    if (!r) return;
    if (r.ok) onClose();
    else if (r.committed) {
      // The commit landed locally but the push failed: the page must reflect that, so move the message to the banner.
      ctx.notify(noticeFrom("Commit + push", r));
      onClose();
    } else setError(r.detail);
  };

  const target = upstream
    ? `${branch} → ${upstream}`
    : `${branch} → origin/${branch} (no upstream yet: it will be created and tracked)`;

  return (
    <Dialog
      open
      title="Commit + push"
      onClose={onClose}
      dismissable={ctx.busy === null}
      footer={
        <Row>
          <Button variant="ghost" disabled={ctx.busy !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={ctx.busy === "commit"} disabled={ctx.busy !== null || !message.trim() || selected.length === 0} onClick={() => void submit()}>
            Commit + push
          </Button>
        </Row>
      }
    >
      <Row>
        <Text muted>Target:</Text>
        <span style={{ fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere" }}>{target}</span>
      </Row>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Row>
          <Text muted>{subset ? `Only these ${selected.length} selected files are committed:` : `All ${selected.length} changed files are committed:`}</Text>
        </Row>
        <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 130, overflow: "auto", fontFamily: MONO, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {selected.map((f) => (
            <li key={f.path} style={{ overflowWrap: "anywhere" }}>
              {f.path} <span style={{ color: "#7aa5aa" }}>({statusWord(f)})</span>
            </li>
          ))}
        </ul>
      </div>
      <TextArea
        label="Commit message"
        rows={6}
        value={message}
        onChange={(e) => {
          touched.current = true;
          setMessage(e.target.value);
        }}
        placeholder={drafting ? "Drafting a message..." : "Describe the change"}
      />
      <Row>
        <Button
          variant="secondary"
          size="sm"
          loading={drafting}
          disabled={ctx.busy !== null}
          onClick={() =>
            void load(true).then((d) => {
              if (d?.commitMessage) {
                touched.current = false;
                setMessage(d.commitMessage);
              }
            })
          }
        >
          Draft with AI
        </Button>
        {drafting && <Text muted>Asking the local model... you can also type your own message.</Text>}
        {state.status === "ok" && state.draft?.cached && <Badge variant="default">cached draft</Badge>}
        {state.status === "error" && <Text muted>AI draft unavailable: {state.detail}</Text>}
      </Row>
      <Text muted>
        The ticked files in the list decide what is committed, not their staged/unstaged state: Stage and Unstage only change git&apos;s index and do not limit this commit.
      </Text>
      {subset && <Text muted>The AI draft describes all changes, not only the selected files; edit it if needed.</Text>}
      <Text muted>This never force-pushes. If the push fails, the commit is kept locally.</Text>
      <InlineError text={error} />
    </Dialog>
  );
}
