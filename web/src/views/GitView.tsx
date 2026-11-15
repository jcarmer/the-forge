import { Fragment, useState, type KeyboardEvent } from "react";
import { Badge, Button, Heading, Pane, Text } from "../components";
import type { GitRepoSummary } from "../types";
import type { GitReposState } from "../hooks/useGitRepos";
import GitRepoDetail from "./GitRepoDetail";
import { branchNames, isClean, tileChips } from "./gitTileChips";
import { DETACHED_BRANCH, isDetached } from "./git/selection";

function RepoTile({ repo, onSelect }: { repo: GitRepoSummary; onSelect: () => void }) {
  const chips = tileChips(repo);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  const summary = isClean(repo) ? "clean" : chips.map((c) => c.label).join(", ");
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
          <Heading>{repo.name}</Heading>
          <Text muted>branch: {isDetached(repo.branch) ? `${DETACHED_BRANCH} HEAD` : repo.branch}</Text>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {chips.map((c) => (
              <Badge key={c.key} variant={c.variant}>
                {c.label}
              </Badge>
            ))}
          </div>
          {repo.openPrs && repo.openPrs.length > 0 && (
            <div style={{ fontSize: 11, color: "#7aa5aa", display: "flex", flexDirection: "column", gap: 2 }}>
              {repo.openPrs.slice(0, 3).map((p) => (
                <span key={p.number} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  #{p.number} {p.title}
                </span>
              ))}
              {repo.openPrs.length > 3 && <span>+{repo.openPrs.length - 3} more</span>}
            </div>
          )}
          {repo.openBranches.length > 0 && (
            <div style={{ fontSize: 11, color: "#7aa5aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {branchNames(repo.openBranches)}
            </div>
          )}
        </div>
      </Pane>
    </div>
  );
}

export function GitView({ git }: { git: GitReposState }) {
  const { repos, error, loading, reload, reloadRepo, generatedAt } = git;
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

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

  const firstCleanIdx = repos ? repos.findIndex(isClean) : -1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <style>{`
        .git-tile { cursor: pointer; border-radius: 4px; outline: none; min-width: 0; }
        .git-tile:hover { filter: brightness(1.15); }
        .git-tile:focus-visible { outline: 2px solid #00f3ff; outline-offset: 2px; }
        .git-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
        .git-divider { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
        .git-divider::after { content: ""; flex: 1; height: 1px; background: #0b7f86; opacity: 0.6; }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Heading>Git repositories</Heading>
        {generatedAt && <Text muted>updated {new Date(generatedAt).toLocaleTimeString()}</Text>}
        <div style={{ flex: 1 }} />
        {error && <Badge variant="danger">Error: {error}</Badge>}
        <Button variant="ghost" size="sm" loading={loading} onClick={() => void reload({ refresh: true })}>
          Refresh
        </Button>
      </div>
      {!repos ? (
        <Pane padding={16}>
          <Text>{error ? "Could not load repositories." : "Loading repositories..."}</Text>
        </Pane>
      ) : repos.length === 0 ? (
        <Pane padding={16}>
          <Text muted>No repositories found.</Text>
        </Pane>
      ) : (
        <div className="git-grid">
          {repos.map((r, i) => (
            <Fragment key={r.name}>
              {i === firstCleanIdx && i > 0 && (
                <div className="git-divider" role="separator" aria-label="Clean repositories">
                  <Text muted>Clean</Text>
                </div>
              )}
              <RepoTile repo={r} onSelect={() => setSelectedRepo(r.name)} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
