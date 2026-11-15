import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pane, Text } from "../components";
import { useGitRepoData } from "../hooks/useGitRepoData";
import type { GitActionResult, GitChangedFile, GitRepoSummary } from "../types";
import { ActionsBar } from "./git/ActionsBar";
import { BranchesPanel } from "./git/BranchesPanel";
import { ChangedFiles } from "./git/ChangedFiles";
import { CommitDialog } from "./git/CommitDialog";
import { DeleteBranchesDialog } from "./git/DeleteBranchesDialog";
import { DiscardDialog } from "./git/DiscardDialog";
import { MorePanel } from "./git/MorePanel";
import { PrDialog } from "./git/PrDialog";
import { RepoHeader } from "./git/RepoHeader";
import { SummaryPanel } from "./git/SummaryPanel";
import { noticeFrom, type NoticeData } from "./git/notice";
import { guessBaseBranch, isSubset, pruneDeselected, selectAll, selectNone, selectedFiles, summarySignature, toggleSelected } from "./git/selection";
import { Notice, type ActionCtx } from "./git/ui";
import { useAiSummary } from "./git/useAiSummary";

type DialogState = { kind: "commit" } | { kind: "pr" } | { kind: "discard"; files: GitChangedFile[]; scope: string } | { kind: "delete-branches"; names: string[] } | null;

const NO_FILES: GitChangedFile[] = [];

/**
 * Repo detail page: changed files (with diffs), AI summary, commit/PR/discard actions and extra tools.
 * `onChanged` lets the parent refresh its repo summary after any action or refresh.
 */
export default function GitRepoDetail({ repo, onBack, onChanged }: { repo: GitRepoSummary; onBack: () => void; onChanged?: () => void }) {
  const name = repo.name;
  const data = useGitRepoData(name);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [notice, setNotice] = useState<NoticeData | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(selectAll);
  const [branchSel, setBranchSel] = useState<ReadonlySet<string>>(new Set());
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const refreshRef = useRef(data.refresh);
  refreshRef.current = data.refresh;

  const files = data.changes?.files ?? null;
  const allFiles = files ?? NO_FILES;
  const signature = useMemo(() => summarySignature(allFiles), [allFiles]);
  const summary = useAiSummary(name, files !== null && files.length > 0, signature);

  // A different repo (or its removal) resets page-local state.
  useEffect(() => {
    setNotice(null);
    setDialog(null);
    setDeselected(selectAll());
    setBranchSel(new Set());
  }, [name]);

  useEffect(() => {
    if (files) setDeselected((d) => pruneDeselected(d, files));
  }, [files]);

  const run = useCallback<ActionCtx["run"]>(async (key, title, fn, opts) => {
    if (busyRef.current) return null;
    busyRef.current = key;
    setBusy(key);
    setNotice(null);
    let result: GitActionResult;
    try {
      result = await fn();
    } catch (e) {
      result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    if (!(opts?.inline && !result.ok)) setNotice(noticeFrom(title, result));
    // Even a failed action can have changed the repo (e.g. committed but not pushed): always refresh.
    try {
      await refreshRef.current();
    } finally {
      busyRef.current = null;
      setBusy(null);
      onChangedRef.current?.();
    }
    return result;
  }, []);

  const ctx = useMemo<ActionCtx>(() => ({ busy, run, notify: setNotice }), [busy, run]);

  const selected = selectedFiles(allFiles, deselected);
  const currentBranchInfo = data.branches?.branches.find((b) => b.isCurrent);
  const branch = repo.branch;
  const mainBranch = guessBaseBranch(data.links, data.branches?.branches ?? null);
  const closeDialog = () => setDialog(null);

  const refreshAll = () => {
    setNotice(null);
    void data.refresh();
    onChanged?.();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`
        @keyframes git-spin { to { transform: rotate(360deg); } }
        .git-spin { animation: git-spin 0.9s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .git-spin { animation: none; } }
        .git-detail textarea:focus-visible, .git-detail input:focus-visible, .git-detail a:focus-visible, .git-detail [tabindex]:focus-visible { outline: 2px solid #00f3ff; outline-offset: 2px; }
      `}</style>
      <div className="git-detail" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Pane padding={12}>
          <RepoHeader repo={repo} links={data.links} linksError={data.errors.links} refreshing={data.loading} onBack={onBack} onRefresh={refreshAll} />
        </Pane>

        {notice && (
          <div style={{ position: "sticky", top: 0, zIndex: 5 }}>
            <Notice notice={notice} onDismiss={() => setNotice(null)} />
          </div>
        )}

        <SummaryPanel state={summary.state} hasChanges={allFiles.length > 0} changesLoaded={files !== null} onRegenerate={() => void summary.regenerate()} />

        <ChangedFiles
          repoName={name}
          files={files}
          error={data.errors.changes}
          deselected={deselected}
          onToggle={(p) => setDeselected((d) => toggleSelected(d, p))}
          onSelectAll={() => setDeselected(selectAll())}
          onSelectNone={() => setDeselected(selectNone(allFiles))}
          ctx={ctx}
          onDiscardFile={(f) => setDialog({ kind: "discard", files: [f], scope: "this file" })}
          onRetry={() => void data.refresh()}
        />

        <ActionsBar
          ctx={ctx}
          selectedCount={selected.length}
          totalCount={allFiles.length}
          hasBranch={Boolean(branch)}
          onCommit={() => setDialog({ kind: "commit" })}
          onPr={() => setDialog({ kind: "pr" })}
          onDiscard={() =>
            setDialog({
              kind: "discard",
              files: selected,
              scope: selected.length === allFiles.length ? "ALL uncommitted changes" : `the ${selected.length} selected file${selected.length === 1 ? "" : "s"}`,
            })
          }
        />

        <MorePanel
          repo={repo}
          mainBranch={mainBranch}
          changeCount={allFiles.length}
          stashes={data.stashes}
          stashError={data.errors.stashes}
          ctx={ctx}
          onRegenerateSummary={() => void summary.regenerate()}
          summaryLoading={summary.state.status === "loading"}
        />

        <BranchesPanel
          data={data.branches}
          error={data.errors.branches}
          ctx={ctx}
          selected={branchSel}
          onSelectedChange={setBranchSel}
          onDelete={(names) => setDialog({ kind: "delete-branches", names })}
          onRetry={() => void data.refresh()}
        />

        <Text muted>Changes and branches are loaded when you open this page and after every action; use Refresh to reload.</Text>
      </div>

      {dialog?.kind === "commit" && (
        <CommitDialog repoName={name} branch={branch} upstream={currentBranchInfo?.upstream} selected={selected} subset={isSubset(allFiles, selected)} ctx={ctx} onClose={closeDialog} />
      )}
      {dialog?.kind === "pr" && (
        <PrDialog repoName={name} branch={branch} defaultBase={mainBranch} uncommitted={allFiles.length} ahead={repo.ahead} ctx={ctx} onClose={closeDialog} />
      )}
      {dialog?.kind === "discard" && <DiscardDialog repoName={name} files={dialog.files} scope={dialog.scope} ctx={ctx} onClose={closeDialog} />}
      {dialog?.kind === "delete-branches" && <DeleteBranchesDialog repoName={name} branches={dialog.names} ctx={ctx} onClose={closeDialog} />}
    </div>
  );
}
