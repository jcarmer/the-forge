import { Fragment, useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Badge, Button, Heading, Pane, Text } from "../components";
import { gitPost } from "../hooks/useGitRepoApi";
import type { GitActionResult, GitRepoPr, GitRepoSummary } from "../types";
import type { GitReposState } from "../hooks/useGitRepos";
import GitRepoDetail from "./GitRepoDetail";
import { attentionCount, branchNames, filterRepos, isClean, tileChips, tileQuickActions, type RepoFilter } from "./gitTileChips";
import { PrDialog } from "./git/PrDialog";
import { noticeFrom, type NoticeData } from "./git/notice";
import { DETACHED_BRANCH, isDetached } from "./git/selection";
import { MONO, Notice, Row, type ActionCtx } from "./git/ui";

function stop(e: MouseEvent) {
  e.stopPropagation();
}

function RepoTile({
  repo,
  busyKey,
  notice,
  onDismissNotice,
  onSelect,
  onRunAction,
  onOpenPrDialog,
}: {
  repo: GitRepoSummary;
  busyKey: string | null;
  notice?: NoticeData;
  onDismissNotice: () => void;
  onSelect: () => void;
  onRunAction: (key: string, title: string, fn: () => Promise<GitActionResult>) => void;
  onOpenPrDialog: () => void;
}) {
  const chips = tileChips(repo);
  const actions = tileQuickActions(repo);
  const mainBranch = repo.mainBranch ?? "main";
  const integrationBranch = repo.integrationBranch ?? "ai-work";
  const detached = isDetached(repo.branch);
  const disabled = busyKey !== null;

  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  const hasQuickActions =
    repo.dirty ||
    repo.changedFiles > 0 ||
    actions.canPull ||
    actions.canPush ||
    actions.canSyncMain ||
    actions.canCreatePr ||
    actions.canCleanMerged;

  const branchVariant =
    repo.branch === mainBranch ? "primary" : repo.branch === integrationBranch ? "info" : detached ? "warning" : "secondary";

  const summary = isClean(repo) && (repo.mergedBranches?.length ?? 0) === 0 ? "clean" : chips.map((c) => c.label).join(", ");

  return (
    <div
      role="button"
      tabIndex={0}
      className="git-tile"
      aria-label={`${repo.name}, branch ${repo.branch}: ${summary}. Open details`}
      onClick={onSelect}
      onKeyDown={onKey}
    >
      <Pane padding={12}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Row gap={8}>
            <Heading>{repo.name}</Heading>
            <Badge variant={branchVariant}>{detached ? `${DETACHED_BRANCH} HEAD` : repo.branch}</Badge>
            <div style={{ flex: 1 }} />
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                stop(e);
                onSelect();
              }}
            >
              Details →
            </Button>
          </Row>

          {repo.lastCommit && (
            <div
              style={{
                fontSize: 11,
                color: "#7aa5aa",
                fontFamily: MONO,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={`${repo.lastCommit.sha} · ${repo.lastCommit.subject}`}
            >
              <span style={{ color: "#a5d6db" }}>{repo.lastCommit.sha}</span> {repo.lastCommit.subject}
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {chips.map((c) => (
              <Badge key={c.key} variant={c.variant}>
                {c.label}
              </Badge>
            ))}
          </div>

          {repo.openPrs && repo.openPrs.length > 0 && (
            <div
              onClick={stop}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "6px 8px",
                borderRadius: 4,
                background: "rgb(11 127 134 / 0.12)",
                border: "1px solid rgb(11 127 134 / 0.35)",
              }}
            >
              {repo.openPrs.slice(0, 3).map((p: GitRepoPr) => (
                <div key={p.number} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "#00f3ff", fontFamily: MONO, fontSize: 12, textDecoration: "none" }}
                  >
                    #{p.number}
                  </a>
                  <span
                    style={{
                      fontSize: 12,
                      flex: "1 1 120px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={`${p.title} (${p.headRefName} -> ${p.baseRefName})`}
                  >
                    {p.title}
                  </span>
                  {p.isDraft ? (
                    <Badge variant="default">draft</Badge>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={disabled}
                      loading={busyKey === `merge-pr:${p.number}`}
                      onClick={() =>
                        onRunAction(`merge-pr:${p.number}`, `Squash & merge PR #${p.number}`, () =>
                          gitPost(repo.name, "merge-pr", { number: p.number, url: p.url, headBranch: p.headRefName }),
                        )
                      }
                    >
                      Squash &amp; merge
                    </Button>
                  )}
                </div>
              ))}
              {repo.openPrs.length > 3 && (
                <span style={{ fontSize: 11, color: "#7aa5aa" }}>+{repo.openPrs.length - 3} more open PRs in details</span>
              )}
            </div>
          )}

          {repo.openBranches.length > 0 && (
            <div style={{ fontSize: 11, color: "#7aa5aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              unmerged: {branchNames(repo.openBranches)}
            </div>
          )}

          {hasQuickActions && (
            <div
              onClick={stop}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                paddingTop: 6,
                borderTop: "1px solid rgb(11 127 134 / 0.3)",
              }}
            >
              {(repo.dirty || repo.changedFiles > 0) && (
                <Button variant="primary" size="sm" onClick={onSelect}>
                  Review / Commit ({repo.changedFiles})
                </Button>
              )}
              {actions.canPull && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  loading={busyKey === "pull"}
                  onClick={() => onRunAction("pull", `Pull ${repo.name}`, () => gitPost(repo.name, "pull"))}
                >
                  Pull (↓{repo.behind})
                </Button>
              )}
              {actions.canPush && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  loading={busyKey === "push"}
                  onClick={() => onRunAction("push", `Push ${repo.name}`, () => gitPost(repo.name, "push"))}
                >
                  {repo.ahead > 0 ? `Push (↑${repo.ahead})` : "Push branch"}
                </Button>
              )}
              {actions.canCreatePr && !(repo.dirty && repo.branch === mainBranch) && (
                <Button variant="secondary" size="sm" disabled={disabled} onClick={onOpenPrDialog}>
                  Create PR...
                </Button>
              )}
              {actions.canSyncMain && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  loading={busyKey === "sync-main"}
                  onClick={() => onRunAction("sync-main", `Sync ${repo.name} from ${mainBranch}`, () => gitPost(repo.name, "sync-main"))}
                >
                  Sync {mainBranch}
                </Button>
              )}
              {actions.canCleanMerged && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  loading={busyKey === "clean-merged"}
                  onClick={() =>
                    onRunAction("clean-merged", `Clean merged branches in ${repo.name}`, () => gitPost(repo.name, "clean-merged"))
                  }
                >
                  Clean {repo.mergedBranches?.length} merged
                </Button>
              )}
            </div>
          )}

          {notice && (
            <div onClick={stop}>
              <Notice notice={notice} onDismiss={onDismissNotice} />
            </div>
          )}
        </div>
      </Pane>
    </div>
  );
}

const FILTERS: { key: RepoFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention" },
  { key: "dirty", label: "Uncommitted" },
  { key: "prs", label: "Open PRs" },
  { key: "clean", label: "Clean" },
];

export function GitView({ git }: { git: GitReposState }) {
  const { repos, error, loading, reload, reloadRepo, generatedAt } = git;
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [busyByRepo, setBusyByRepo] = useState<Record<string, string | null>>({});
  const busyRef = useRef<Record<string, string | null>>({});
  const [notices, setNotices] = useState<Record<string, NoticeData | undefined>>({});
  const [prModalRepo, setPrModalRepo] = useState<string | null>(null);

  const runForRepo = useCallback(
    async (
      repoName: string,
      key: string,
      title: string,
      fn: () => Promise<GitActionResult>,
      opts?: { inline?: boolean },
    ): Promise<GitActionResult | null> => {
      if (busyRef.current[repoName]) return null;
      busyRef.current[repoName] = key;
      setBusyByRepo((prev) => ({ ...prev, [repoName]: key }));
      setNotices((prev) => ({ ...prev, [repoName]: undefined }));
      let result: GitActionResult;
      try {
        result = await fn();
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : String(e) };
      }
      if (!(opts?.inline && !result.ok)) {
        setNotices((prev) => ({ ...prev, [repoName]: noticeFrom(title, result) }));
      }
      try {
        await reloadRepo(repoName);
      } finally {
        busyRef.current[repoName] = null;
        setBusyByRepo((prev) => ({ ...prev, [repoName]: null }));
      }
      return result;
    },
    [reloadRepo],
  );

  const prTarget = prModalRepo && repos ? repos.find((r) => r.name === prModalRepo) : undefined;
  const prCtx: ActionCtx | null = useMemo(() => {
    if (!prTarget) return null;
    return {
      busy: busyByRepo[prTarget.name] ?? null,
      run: (k, title, fn, o) => runForRepo(prTarget.name, k, title, fn, o),
      notify: (n) => setNotices((prev) => ({ ...prev, [prTarget.name]: n ?? undefined })),
    };
  }, [prTarget, busyByRepo, runForRepo]);

  const selected = selectedRepo && repos ? repos.find((r) => r.name === selectedRepo) : undefined;
  if (selected) {
    return (
      <GitRepoDetail
        key={selected.name}
        repo={selected}
        onChanged={(opts) => void reloadRepo(selected.name, opts)}
        onBack={() => setSelectedRepo(null)}
      />
    );
  }

  const visibleRepos = repos ? filterRepos(repos, filter) : null;
  const firstCleanIdx =
    filter === "all" && visibleRepos ? visibleRepos.findIndex((r) => isClean(r) && (r.mergedBranches?.length ?? 0) === 0) : -1;
  const needAttention = repos ? attentionCount(repos) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`
        .git-tile { cursor: pointer; border-radius: 4px; outline: none; min-width: 0; }
        .git-tile:hover { filter: brightness(1.08); }
        .git-tile:focus-visible { outline: 2px solid #00f3ff; outline-offset: 2px; }
        .git-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); }
        .git-divider { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
        .git-divider::after { content: ""; flex: 1; height: 1px; background: #0b7f86; opacity: 0.6; }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Heading>Git repositories</Heading>
        {repos && (
          <Badge variant={needAttention > 0 ? "warning" : "success"}>
            {needAttention > 0 ? `${needAttention} of ${repos.length} need attention` : `All ${repos.length} clean`}
          </Badge>
        )}
        {generatedAt && <Text muted>updated {new Date(generatedAt).toLocaleTimeString()}</Text>}
        <div style={{ flex: 1 }} />
        {repos && repos.length > 0 && (
          <Row gap={4}>
            {FILTERS.map((f) => (
              <Button
                key={f.key}
                variant={filter === f.key ? "primary" : "ghost"}
                size="sm"
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </Button>
            ))}
          </Row>
        )}
        {error && <Badge variant="danger">Error: {error}</Badge>}
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void reload({ refresh: true })}>
          Refresh all
        </Button>
      </div>
      {!visibleRepos ? (
        <Pane padding={16}>
          <Text>{error ? "Could not load repositories." : "Loading repositories..."}</Text>
        </Pane>
      ) : visibleRepos.length === 0 ? (
        <Pane padding={16}>
          <Text muted>{repos && repos.length > 0 ? "No repositories match this filter." : "No repositories found."}</Text>
        </Pane>
      ) : (
        <div className="git-grid">
          {visibleRepos.map((r, i) => (
            <Fragment key={r.name}>
              {i === firstCleanIdx && i > 0 && (
                <div className="git-divider" role="separator" aria-label="Clean repositories">
                  <Text muted>Clean</Text>
                </div>
              )}
              <RepoTile
                repo={r}
                busyKey={busyByRepo[r.name] ?? null}
                notice={notices[r.name]}
                onDismissNotice={() => setNotices((prev) => ({ ...prev, [r.name]: undefined }))}
                onSelect={() => setSelectedRepo(r.name)}
                onRunAction={(key, title, fn) => void runForRepo(r.name, key, title, fn)}
                onOpenPrDialog={() => setPrModalRepo(r.name)}
              />
            </Fragment>
          ))}
        </div>
      )}

      {prTarget && prCtx && (
        <PrDialog
          repoName={prTarget.name}
          branch={prTarget.branch}
          canDraft
          defaultBase={prTarget.mainBranch ?? "main"}
          uncommitted={prTarget.changedFiles}
          ahead={prTarget.ahead}
          ctx={prCtx}
          onClose={() => setPrModalRepo(null)}
        />
      )}
    </div>
  );
}

