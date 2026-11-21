import { useState, type ReactNode } from "react";
import { Badge, Button, Text } from "../../components";
import { gitPost } from "../../hooks/useGitRepoApi";
import type { GitActionResult, GitRepoSummary, GitStashEntry } from "../../types";
import { pullBlockedReason, syncBlockedReason } from "./selection";
import { Checkbox, MONO, Row, Section, TextField, type ActionCtx } from "./ui";

function Tool({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid rgb(11 127 134 / 0.4)", paddingTop: 10 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      {children}
    </div>
  );
}

/** Secondary tools: pull, sync from main, stash + stash list, regenerate the AI summary. */
export function MorePanel({
  repo,
  mainBranch,
  changeCount,
  stashes,
  stashError,
  ctx,
  onRegenerateSummary,
  summaryLoading,
}: {
  repo: GitRepoSummary;
  mainBranch: string;
  changeCount: number;
  stashes: GitStashEntry[] | null;
  stashError?: string;
  ctx: ActionCtx;
  onRegenerateSummary: () => void;
  summaryLoading: boolean;
}) {
  const [stashMsg, setStashMsg] = useState("");
  const [stashUntracked, setStashUntracked] = useState(false);
  /** Latest conflict check / conflicted sync for this repo, kept on screen (a toast would hide the steps). */
  const [conflictInfo, setConflictInfo] = useState<{ title: string; kind: "ok" | "conflict" | "error"; text: string; steps: string[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const [allowBusy, setAllowBusy] = useState(false);
  const disabled = ctx.busy !== null;
  const name = repo.name;
  const pullBlock = pullBlockedReason(repo);
  const syncBlock = syncBlockedReason({ branch: repo.branch, mainBranch, dirty: changeCount > 0 });
  const busyTasks = repo.agentBusy ?? [];
  const isIntegration = repo.integrationBranch !== undefined && repo.branch === repo.integrationBranch;
  const busyBlocksSync = isIntegration && busyTasks.length > 0 && !allowBusy;

  const showResult = (title: string, r: GitActionResult | null) => {
    if (!r) return;
    const conflict = Boolean(r.conflict) || r.status === "conflicts";
    setCopied(false);
    setConflictInfo({
      title,
      kind: !r.ok ? "error" : conflict ? "conflict" : "ok",
      text: r.detail,
      steps: Array.isArray(r.resolveSteps) ? r.resolveSteps : [],
    });
  };
  const copySteps = async (steps: string[]) => {
    try {
      await navigator.clipboard.writeText(steps.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false); // clipboard blocked: the steps are still selectable on screen
    }
  };

  return (
    <Section title="More actions">
      <Tool title="Pull">
        <Text muted>{pullBlock ?? `Fast-forwards ${repo.branch} by ${repo.behind} commit${repo.behind === 1 ? "" : "s"} from its upstream. Never rebases or forces.`}</Text>
        <div>
          <Button variant="secondary" disabled={disabled || pullBlock !== null} loading={ctx.busy === "pull"} onClick={() => void ctx.run("pull", "Pull", () => gitPost(name, "pull"))}>
            Pull
          </Button>
        </div>
      </Tool>

      <Tool title={`Check for conflicts with ${mainBranch}`}>
        <Text muted>
          {repo.branch === mainBranch
            ? `You are on ${mainBranch}; there is nothing to compare.`
            : `Read-only dry run: fetches, then predicts whether merging origin/${mainBranch} into ${repo.branch} would conflict, and in which files. Nothing is changed, so it is safe to run any time${(repo.behindMain ?? 0) > 0 ? ` (origin/${mainBranch} is ${repo.behindMain} commit${repo.behindMain === 1 ? "" : "s"} ahead of this branch)` : ""}.`}
        </Text>
        <div>
          <Button
            variant="secondary"
            disabled={disabled || repo.branch === mainBranch || repo.branch === "(detached)"}
            loading={ctx.busy === "sync-preview"}
            onClick={async () => showResult("Conflict check", await ctx.run("sync-preview", "Conflict check", () => gitPost(name, "sync-preview"), { inline: true }))}
          >
            Check for conflicts
          </Button>
        </div>
        {conflictInfo && (
          <div
            role={conflictInfo.kind === "ok" ? "status" : "alert"}
            style={{ border: `1px solid ${conflictInfo.kind === "ok" ? "#39ff14" : conflictInfo.kind === "conflict" ? "#ff9900" : "#ff3366"}`, padding: "8px 10px", fontSize: 13, display: "flex", flexDirection: "column", gap: 8 }}
          >
            <strong>{conflictInfo.title}</strong>
            <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: conflictInfo.steps.length ? MONO : undefined }}>{conflictInfo.text}</div>
            {conflictInfo.steps.length > 0 && (
              <div>
                <Button variant="ghost" size="sm" onClick={() => void copySteps(conflictInfo.steps)}>
                  {copied ? "Copied" : "Copy resolve steps"}
                </Button>
              </div>
            )}
          </div>
        )}
      </Tool>

      <Tool title={`Sync from ${mainBranch}`}>
        <Text muted>
          {syncBlock ?? `Merges origin/${mainBranch} into ${repo.branch} (a merge commit, no force-push). If it conflicts, the merge is aborted and nothing changes; you will see the conflicting files and the steps to resolve them in your own clone.`}
        </Text>
        {isIntegration && busyTasks.length > 0 && (
          <Checkbox
            checked={allowBusy}
            onChange={setAllowBusy}
            label={`An agent task is running here (${busyTasks.join(", ")}); sync anyway`}
            hint="Agent tasks merge into this branch themselves. Wait for them to finish unless you know the task is stuck."
          />
        )}
        <div>
          <Button
            variant="secondary"
            disabled={disabled || syncBlock !== null || busyBlocksSync}
            loading={ctx.busy === "sync-main"}
            onClick={async () => showResult(`Sync from ${mainBranch}`, await ctx.run("sync-main", `Sync from ${mainBranch}`, () => gitPost(name, "sync-main", allowBusy ? { allowWhileBusy: true } : {}), { inline: false }))}
          >
            Sync from {mainBranch}
          </Button>
        </div>
      </Tool>

      <Tool title="Stash">
        <Text muted>Sets your uncommitted work aside so the tree is clean. Restore it later from the list below.</Text>
        <TextField label="Stash message (optional)" value={stashMsg} onChange={(e) => setStashMsg(e.target.value)} maxLength={500} />
        <Checkbox checked={stashUntracked} onChange={setStashUntracked} label="Include untracked files" hint="New files are left in place unless ticked." />
        <div>
          <Button
            variant="secondary"
            disabled={disabled || changeCount === 0}
            loading={ctx.busy === "stash"}
            onClick={async () => {
              const r = await ctx.run("stash", "Stash", () => gitPost(name, "stash", { ...(stashMsg.trim() ? { message: stashMsg.trim() } : {}), includeUntracked: stashUntracked }));
              if (r?.ok) setStashMsg("");
            }}
          >
            Stash changes
          </Button>
          {changeCount === 0 && <span style={{ marginLeft: 8 }}><Text muted>No changes to stash.</Text></span>}
        </div>
      </Tool>

      <Tool title={`Stashes${stashes ? ` (${stashes.length})` : ""}`}>
        {stashError && !stashes ? (
          <Text muted>Could not load stashes: {stashError}</Text>
        ) : !stashes ? (
          <Text muted>Loading stashes...</Text>
        ) : stashes.length === 0 ? (
          <Text muted>No stashes.</Text>
        ) : (
          <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {stashes.map((s) => (
              <li key={s.sha} style={{ listStyle: "none", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <Badge variant="default">{s.ref}</Badge>
                <span style={{ flex: "1 1 180px", minWidth: 0, fontSize: 12, fontFamily: MONO, overflowWrap: "anywhere" }}>
                  {s.message}
                  <span style={{ color: "#7aa5aa" }}> · {new Date(s.date).toLocaleString()}</span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled}
                  loading={ctx.busy === `stash-pop:${s.ref}`}
                  aria-label={`Pop ${s.ref}: ${s.message}`}
                  onClick={() => void ctx.run(`stash-pop:${s.ref}`, `Pop ${s.ref}`, () => gitPost(name, "stash-pop", { ref: s.ref }))}
                >
                  Pop
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Text muted>Pop re-applies the stash and drops it. If it conflicts, git keeps the stash and the files hold conflict markers.</Text>
      </Tool>

      <Tool title="AI summary">
        <Row>
          <Button variant="secondary" size="sm" loading={summaryLoading} disabled={changeCount === 0} onClick={onRegenerateSummary}>
            Regenerate AI summary
          </Button>
          {changeCount === 0 && <Text muted>No changes to summarise.</Text>}
        </Row>
      </Tool>
    </Section>
  );
}
