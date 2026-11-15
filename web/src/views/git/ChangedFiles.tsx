import { useEffect, useState } from "react";
import { Badge, Button, Text, type Variant } from "../../components";
import { gitGet, gitPost } from "../../hooks/useGitRepoApi";
import type { GitChangedFile, GitDiffResponse } from "../../types";
import { DiffView } from "./DiffView";
import { fileSignature, stageWord, statusWord } from "./selection";
import { Checkbox, MONO, Row, Section, SR_ONLY, type ActionCtx } from "./ui";

const STATUS_VARIANT: Record<GitChangedFile["status"], Variant> = { M: "warning", A: "success", D: "danger", R: "info", "?": "default" };

function FileDiff({ repoName, file }: { repoName: string; file: GitChangedFile }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; data?: GitDiffResponse }>({ loading: true });
  const sig = fileSignature(file);
  useEffect(() => {
    if (file.binary) return;
    const c = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined }));
    gitGet<GitDiffResponse>(repoName, "diff", { path: file.path }, c.signal)
      .then((data) => {
        if (!c.signal.aborted) setState({ loading: false, data });
      })
      .catch((e) => {
        if (!c.signal.aborted) setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => c.abort();
    // Reload when the file's change signature moves (staging does not change the diff vs HEAD, but counts might).
  }, [repoName, file.path, file.binary, sig]);

  if (file.binary) return <Text muted>Binary file: no text diff available.</Text>;
  if (state.error) return <div role="alert" style={{ color: "#ff9db3", fontSize: 13 }}>Could not load diff: {state.error}</div>;
  if (!state.data) return <Text muted>Loading diff...</Text>;
  return <DiffView diff={state.data.diff} truncated={state.data.truncated} />;
}

function FileRow({
  repoName,
  file,
  selected,
  onToggle,
  ctx,
  onDiscard,
}: {
  repoName: string;
  file: GitChangedFile;
  selected: boolean;
  onToggle: () => void;
  ctx: ActionCtx;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(false);
  const stage = stageWord(file);
  const label = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const post = (action: "stage" | "unstage") => () =>
    ctx.run(`${action}:${file.path}`, action === "stage" ? "Stage" : "Unstage", () => gitPost(repoName, action, { files: [file.path] }));
  const disabled = ctx.busy !== null;
  return (
    <li style={{ borderBottom: "1px solid rgb(11 127 134 / 0.4)", padding: "8px 0", display: "flex", flexDirection: "column", gap: 8, listStyle: "none" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ paddingTop: 1 }}>
          <Checkbox checked={selected} onChange={onToggle} label={<span style={SR_ONLY}>Include {file.path}</span>} />
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span aria-hidden="true" title={statusWord(file)} style={{ fontFamily: MONO, fontWeight: 700, minWidth: 14 }}>
              {file.status}
            </span>
            <span style={{ fontFamily: MONO, fontSize: 13, overflowWrap: "anywhere" }}>
              <span style={SR_ONLY}>{statusWord(file)}: </span>
              {label}
            </span>
          </div>
          <Row gap={6}>
            <Badge variant={STATUS_VARIANT[file.status]}>{statusWord(file)}</Badge>
            <Badge variant={stage === "staged" ? "success" : stage === "partly staged" ? "info" : "default"}>{stage}</Badge>
            {file.conflicted && <Badge variant="danger">conflict</Badge>}
            {file.binary ? (
              <Text muted>binary</Text>
            ) : (
              <span style={{ fontFamily: MONO, fontSize: 12 }}>
                <span style={{ color: "#39ff14" }} aria-label={`${file.additions} lines added`}>+{file.additions}</span>{" "}
                <span style={{ color: "#ff3366" }} aria-label={`${file.deletions} lines removed`}>-{file.deletions}</span>
              </span>
            )}
          </Row>
        </div>
        <Row gap={6}>
          <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide diff" : "Show diff"}
          </Button>
          {file.unstaged && (
            <Button variant="secondary" size="sm" disabled={disabled} loading={ctx.busy === `stage:${file.path}`} onClick={post("stage")}>
              Stage
            </Button>
          )}
          {file.staged && (
            <Button variant="secondary" size="sm" disabled={disabled} loading={ctx.busy === `unstage:${file.path}`} onClick={post("unstage")}>
              Unstage
            </Button>
          )}
          <Button variant="danger" size="sm" disabled={disabled} onClick={onDiscard} aria-label={`Discard changes to ${file.path}`}>
            Discard
          </Button>
        </Row>
      </div>
      {open && <FileDiff repoName={repoName} file={file} />}
    </li>
  );
}

export function ChangedFiles({
  repoName,
  files,
  error,
  deselected,
  onToggle,
  onSelectAll,
  onSelectNone,
  ctx,
  onDiscardFile,
  onRetry,
}: {
  repoName: string;
  files: GitChangedFile[] | null;
  error?: string;
  deselected: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  ctx: ActionCtx;
  onDiscardFile: (f: GitChangedFile) => void;
  onRetry: () => void;
}) {
  const count = files ? files.length - files.filter((f) => deselected.has(f.path)).length : 0;
  return (
    <Section
      title="Changed files"
      right={
        files && files.length > 0 ? (
          <Row gap={6}>
            <Text muted>
              {count} of {files.length} selected
            </Text>
            <Button variant="ghost" size="sm" onClick={onSelectAll} disabled={count === files.length}>
              Select all
            </Button>
            <Button variant="ghost" size="sm" onClick={onSelectNone} disabled={count === 0}>
              Select none
            </Button>
          </Row>
        ) : undefined
      }
    >
      {error && !files ? (
        <Row>
          <span role="alert" style={{ color: "#ff9db3", fontSize: 13 }}>
            Could not load changes: {error}
          </span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </Row>
      ) : !files ? (
        <Text muted>Loading changes...</Text>
      ) : files.length === 0 ? (
        <Text muted>Working tree clean: no uncommitted changes.</Text>
      ) : (
        <>
          {error && (
            <span role="alert" style={{ color: "#ff9db3", fontSize: 12 }}>
              Refresh failed ({error}); showing the last loaded list.
            </span>
          )}
          <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
            {files.map((f) => (
              <FileRow
                key={f.path}
                repoName={repoName}
                file={f}
                selected={!deselected.has(f.path)}
                onToggle={() => onToggle(f.path)}
                ctx={ctx}
                onDiscard={() => onDiscardFile(f)}
              />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
