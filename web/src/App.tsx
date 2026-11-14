import { useState } from "react";
import { darkTheme, ThemeProvider, UI } from "@tbe/ui";
import { useForgeState } from "./hooks/useForgeState";
import { ServicesView } from "./views/ServicesView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { UsageRouterView } from "./views/UsageRouterView";
import { PackagesReposView } from "./views/PackagesReposView";
import { TasksView } from "./views/TasksView";

type TabKey = "services" | "diagnostics" | "usage" | "packages" | "tasks";

export function App() {
  const { state, connected, error, reload } = useForgeState();
  const [tab, setTab] = useState<TabKey>("services");

  const failCount =
    (state?.diagnostics.checks.filter((c) => !c.ok).length ?? 0) +
    (state?.auth.items.filter((a) => !a.ok).length ?? 0);
  const dirtyPkgs = state?.packages.filter((p) => p.dirty || p.unpushed).length ?? 0;
  const runningTasks = state?.tasks.filter((t) => t.status === "running").length ?? 0;

  return (
    <ThemeProvider theme={darkTheme}>
      <UI.Padded padding={UI.Size.px(16)} width={UI.Size.vw(1)} height={UI.Size.vh(1)}>
        <UI.VStack width={UI.Size.fill(1)} height={UI.Size.fill(1)} spacing={UI.Size.px(12)} align="stretch">
          <UI.Panel padding={UI.Size.px(12)}>
            <UI.HStack spacing={UI.Size.px(12)} align="center">
              <UI.Label>The Forge ({state?.hostname ?? "ai-sandbox"})</UI.Label>
              <UI.Label>· branch: {state?.integrationBranch ?? "ai-work"}</UI.Label>
              <UI.Spacer />
              <UI.Label>{connected ? "SSE Live" : "Reconnecting..."}</UI.Label>
              {error && <UI.Label>Error: {error}</UI.Label>}
              <UI.Button preset="ghost" label="Refresh" onClick={() => void reload()} />
            </UI.HStack>
          </UI.Panel>

          {!state ? (
            <UI.Panel padding={UI.Size.px(16)}>
              <UI.Label>Connecting to Forge state stream...</UI.Label>
            </UI.Panel>
          ) : (
            <UI.Scroll height={UI.Size.fill(1)}>
              <UI.Tabs<TabKey>
                active={tab}
                onChange={(k) => setTab(k)}
                tabs={[
                  {
                    key: "services",
                    title: `Services (${state.services.length})`,
                    content: <ServicesView services={state.services} hostname={state.hostname} />,
                  },
                  {
                    key: "diagnostics",
                    title: failCount > 0 ? `Diagnostics (${failCount} fail)` : "Diagnostics (OK)",
                    content: (
                      <DiagnosticsView
                        checks={state.diagnostics.checks}
                        auth={state.auth.items}
                        checkedAt={state.diagnostics.checkedAt}
                      />
                    ),
                  },
                  {
                    key: "usage",
                    title: "Quota & Router",
                    content: <UsageRouterView usage={state.usage} />,
                  },
                  {
                    key: "packages",
                    title: dirtyPkgs > 0 ? `Packages & Repos (${dirtyPkgs} dirty)` : "Packages & Repos",
                    content: <PackagesReposView packages={state.packages} repos={state.repos} />,
                  },
                  {
                    key: "tasks",
                    title: runningTasks > 0 ? `Worktrees & Tasks (${runningTasks} active)` : "Worktrees & Tasks",
                    content: <TasksView tasks={state.tasks} repos={state.repos} />,
                  },
                ]}
              />
            </UI.Scroll>
          )}
        </UI.VStack>
      </UI.Padded>
    </ThemeProvider>
  );
}
