import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { darkTheme, ThemeProvider, UI } from "@tbe/ui";
import { Badge, Button, Heading, Pane, Tabs, TabsContent, TabsList, TabsTrigger, Text } from "./components";
import { useForgeState } from "./hooks/useForgeState";
import { ServicesView } from "./views/ServicesView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { UsageRouterView } from "./views/UsageRouterView";
import { PackagesReposView } from "./views/PackagesReposView";
import { TasksView } from "./views/TasksView";
import { ContextView } from "./views/ContextView";
import { SessionsView } from "./views/SessionsView";
import { DashboardView } from "./views/DashboardView";
import { ConsoleView } from "./views/ConsoleView";
import { GitView } from "./views/GitView";
import { ToastHost } from "./components/Toast";
import { useGitRepos } from "./hooks/useGitRepos";
import { attentionCount } from "./views/gitTileChips";
import mjolnir from './../../mjolnir.webp';


const TAB_KEYS = ["dashboard", "services", "diagnostics", "usage", "packages", "tasks", "context", "sessions", "git", "console"] as const;
type TabKey = (typeof TAB_KEYS)[number];

function tabFromPath(path: string): TabKey {
  const seg = path.split("/")[1] ?? "";
  return (TAB_KEYS as readonly string[]).includes(seg) ? (seg as TabKey) : "dashboard";
}

export function App() {
  const { state, connected, error, reload } = useForgeState();
  const [location, navigate] = useLocation();
  const tab = tabFromPath(location);
  const setTab = (k: TabKey) => navigate(`/${k}`);

  const failCount =
    (state?.diagnostics.checks.filter((c) => !c.ok).length ?? 0) +
    (state?.auth.items.filter((a) => !a.ok).length ?? 0);
  const dirtyPkgs = state?.packages.filter((p) => p.dirty || p.unpushed).length ?? 0;
  const runningTasks = state?.tasks.filter((t) => t.status === "running").length ?? 0;

  const git = useGitRepos({ active: tab === "git" });
  const gitAttention = git.repos ? attentionCount(git.repos) : 0;

  const tabs: { key: TabKey; title: string; content: ReactNode }[] = state
    ? [
        { key: "dashboard", title: "Dashboard", content: <DashboardView /> },
        { key: "console", title: "Console", content: <ConsoleView /> },
        { key: "git", title: gitAttention > 0 ? `Git (${gitAttention})` : "Git", content: <GitView git={git} /> },
        {
          key: "services",
          title: `Services (${state.services.length})`,
          content: <ServicesView services={state.services} hostname={state.hostname} />,
        },
        {
          key: "diagnostics",
          title: failCount > 0 ? `Diagnostics (${failCount} fail)` : "Diagnostics (OK)",
          content: (
            <DiagnosticsView checks={state.diagnostics.checks} auth={state.auth.items} checkedAt={state.diagnostics.checkedAt} />
          ),
        },
        { key: "context", title: "AI Context", content: <ContextView usage={state.usage} /> },
        { key: "sessions", title: "Sessions", content: <SessionsView /> }
      ]
    : [];

  return (
    <ThemeProvider theme={darkTheme}>
      <UI.Padded padding={UI.Size.px(16)} width={UI.Size.vw(1)} height={UI.Size.vh(1)}>
        <UI.VStack width={UI.Size.fill(1)} height={UI.Size.fill(1)} spacing={UI.Size.px(12)} align="stretch">
          <Pane padding={12}>
            <UI.HStack spacing={UI.Size.px(12)} align="center">
              <img src={mjolnir} width={64} />
              <Heading>The Forge ({state?.hostname ?? "ai-sandbox"})</Heading>
              <Text muted>· branch: {state?.integrationBranch ?? "ai-work"}</Text>
              <UI.Spacer />
              <Badge variant={connected ? "success" : "warning"}>{connected ? "SSE Live" : "Reconnecting..."}</Badge>
              {error && <Badge variant="danger">Error: {error}</Badge>}
              <Button variant="ghost" size="sm" onClick={() => void reload()}>
                Refresh
              </Button>
            </UI.HStack>
          </Pane>

          {!state ? (
            <Pane padding={16}>
              <Text>Connecting to Forge state stream...</Text>
            </Pane>
          ) : (
            <Tabs value={tab} onValueChange={(k) => setTab(k as TabKey)}>
              {/* Tab bar stays outside the scroll area so it is always visible. */}
              <TabsList>
                {tabs.map((t) => (
                  <TabsTrigger key={t.key} value={t.key}>
                    {t.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <UI.Scroll height={UI.Size.fill(1)}>
                {tabs.map((t) => (
                  <TabsContent key={t.key} value={t.key}>
                    <div style={{ paddingTop: 12 }}>{t.content}</div>
                  </TabsContent>
                ))}
              </UI.Scroll>
            </Tabs>
          )}
        </UI.VStack>
      </UI.Padded>
      <ToastHost />
    </ThemeProvider>
  );
}
