import { useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Input } from "reend-components";
import { Choice, Heading, Pane, Text } from "../components";
import type { RepoStatus, TaskComplexity, TaskRecord } from "../types";
import { postAction } from "../hooks/useForgeState";

export function TasksView({ tasks, repos }: { tasks: TaskRecord[]; repos: RepoStatus[] }) {
  const [repoDir, setRepoDir] = useState(repos[0]?.path ?? "/projects/tbe");
  const [complexity, setComplexity] = useState<TaskComplexity>("normal");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleDispatch() {
    if (!prompt.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await postAction("/api/actions/dispatch", {
        repoDir: repoDir || repos[0]?.path || "/projects/tbe",
        complexity,
        prompt: prompt.trim(),
      });
      setPrompt("");
      setNotice("Task dispatched to isolated worktree.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const repoOptions = repos.length ? repos.map((r) => ({ key: r.path, label: r.name })) : [{ key: "/projects/tbe", label: "tbe" }];
  const statusVariant = (s: TaskRecord["status"]) => (s === "running" ? "info" : s === "passed" ? "success" : "danger");

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <Heading>Dispatch Autonomous Worktree Task (executeTask)</Heading>
          <UI.HStack spacing={UI.Size.px(8)} align="center">
            <Choice label="Repo" value={repoDir} options={repoOptions} onChange={setRepoDir} width={220} />
            <Choice
              label="Complexity"
              value={complexity}
              options={[
                { key: "trivial", label: "trivial" },
                { key: "normal", label: "normal" },
                { key: "hard", label: "hard" },
              ]}
              onChange={setComplexity}
              width={140}
            />
          </UI.HStack>
          <UI.HStack spacing={UI.Size.px(8)} align="center">
            <div style={{ width: 520, maxWidth: "100%" }}>
              <Input
                value={prompt}
                placeholder="Describe the task to execute in an isolated worktree..."
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
            <Button variant="primary" size="sm" loading={busy} disabled={busy || !prompt.trim()} onClick={() => void handleDispatch()}>
              {busy ? "Dispatching..." : "Dispatch"}
            </Button>
          </UI.HStack>
          {notice && <Badge variant="info">{notice}</Badge>}
        </UI.VStack>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <Heading>Recent Worktree Runs (CLI + Web + T3)</Heading>
          {tasks.length === 0 && <Text muted>No tasks recorded yet.</Text>}
          {tasks.map((t) => (
            <Pane key={t.id} padding={10}>
              <UI.VStack spacing={UI.Size.px(4)} align="stretch">
                <UI.HStack spacing={UI.Size.px(8)} align="center">
                  <Badge variant={statusVariant(t.status)}>{t.status.toUpperCase()}</Badge>
                  <Text>{t.complexity}</Text>
                  <Text muted>{t.repoDir}</Text>
                  <UI.Spacer />
                  <Text muted>{new Date(t.startedAt).toLocaleString()}</Text>
                </UI.HStack>
                <Text>{t.prompt}</Text>
                {t.attempts.length > 0 && (
                  <Text muted>
                    Attempts: {t.attempts.map((a) => `${a.provider} (${a.note})`).join(" -> ")}
                    {t.merged ? " [merged]" : ""}
                  </Text>
                )}
                {t.prUrl && (
                  <Text>
                    Pull request:{" "}
                    <a href={t.prUrl} target="_blank" rel="noreferrer">
                      {t.prUrl.replace("https://github.com/", "")}
                    </a>
                  </Text>
                )}
                {t.error && <Text muted>{t.error}</Text>}
              </UI.VStack>
            </Pane>
          ))}
        </UI.VStack>
      </Pane>
    </UI.VStack>
  );
}
