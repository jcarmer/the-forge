import { useState } from "react";
import { UI } from "@tbe/ui";
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

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <UI.Label>Dispatch Autonomous Worktree Task (executeTask)</UI.Label>
          <UI.HStack spacing={UI.Size.px(8)} align="center">
            <UI.Dropdown
              label="Repo"
              selected={repoDir}
              options={repos.length ? repos.map((r) => ({ key: r.path, label: r.name })) : [{ key: "/projects/tbe", label: "tbe" }]}
              onSelect={(k) => setRepoDir(k)}
            />
            <UI.Dropdown
              label="Complexity"
              selected={complexity}
              options={[
                { key: "trivial", label: "trivial" },
                { key: "normal", label: "normal" },
                { key: "hard", label: "hard" },
              ]}
              onSelect={(k) => setComplexity(k)}
            />
          </UI.HStack>
          <UI.HStack spacing={UI.Size.px(8)} align="center">
            <UI.TextBox
              value={prompt}
              placeholder="Describe the task to execute in an isolated worktree..."
              onChange={(v) => setPrompt(v)}
              width={UI.Size.px(520)}
            />
            <UI.Button label={busy ? "Dispatching..." : "Dispatch"} disabled={busy || !prompt.trim()} onClick={() => void handleDispatch()} />
          </UI.HStack>
          {notice && <UI.Label>{notice}</UI.Label>}
        </UI.VStack>
      </UI.Panel>

      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <UI.Label>Recent Worktree Runs (CLI + Web + T3)</UI.Label>
          {tasks.length === 0 && <UI.Label>No tasks recorded yet.</UI.Label>}
          {tasks.map((t) => (
            <UI.Panel key={t.id} padding={UI.Size.px(10)}>
              <UI.VStack spacing={UI.Size.px(4)} align="stretch">
                <UI.HStack spacing={UI.Size.px(8)}>
                  <UI.Label>[{t.status.toUpperCase()}]</UI.Label>
                  <UI.Label>{t.complexity}</UI.Label>
                  <UI.Label>{t.repoDir}</UI.Label>
                  <UI.Spacer />
                  <UI.Label>{new Date(t.startedAt).toLocaleString()}</UI.Label>
                </UI.HStack>
                <UI.Label>{t.prompt}</UI.Label>
                {t.attempts.length > 0 && (
                  <UI.Label>
                    Attempts: {t.attempts.map((a) => `${a.provider} (${a.note})`).join(" -> ")}
                    {t.merged ? " [merged]" : ""}
                  </UI.Label>
                )}
              </UI.VStack>
            </UI.Panel>
          ))}
        </UI.VStack>
      </UI.Panel>
    </UI.VStack>
  );
}
