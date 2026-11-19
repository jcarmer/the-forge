import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { darkTheme, ThemeProvider } from "@tbe/ui";
import { Badge, Button, Heading, Pane, Tabs, TabsContent, TabsList, TabsTrigger, Text } from "./components";
import { useForgeState } from "./hooks/useForgeState";
import { ServicesView } from "./views/ServicesView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { ContextView } from "./views/ContextView";
import { SessionsView } from "./views/SessionsView";
import { DashboardView } from "./views/DashboardView";
import { ConsoleView } from "./views/ConsoleView";
import { GitView } from "./views/GitView";
import { ToastHost } from "./components/Toast";
import { useGitRepos } from "./hooks/useGitRepos";
import { attentionCount } from "./views/gitTileChips";
import mjolnir from "./../../mjolnir.webp";

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
  const [consoleFullscreen, setConsoleFullscreen] = useState(false);

  useEffect(() => {
    if (tab !== "console" && consoleFullscreen) setConsoleFullscreen(false);
  }, [tab, consoleFullscreen]);

  const failCount =
    (state?.diagnostics.checks.filter((c) => !c.ok).length ?? 0) +
    (state?.auth.items.filter((a) => !a.ok).length ?? 0);

  const git = useGitRepos({ active: tab === "git" });
  const gitAttention = git.repos ? attentionCount(git.repos) : 0;

  const isConsole = tab === "console";
  const hideChrome = isConsole && consoleFullscreen;

  const tabs: { key: TabKey; title: string; content?: ReactNode }[] = state
    ? [
        { key: "dashboard", title: "Dashboard", content: <DashboardView /> },
        { key: "console", title: "Console" },
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
        { key: "sessions", title: "Sessions", content: <SessionsView /> },
      ]
    : [];

  return (
    <ThemeProvider theme={darkTheme}>
      <div className="forge-shell">
        {!hideChrome && (
          <Pane padding={10} style={{ flexShrink: 0 }}>
            <div className="forge-header">
              <div className="forge-header-brand">
                <img src={mjolnir} alt="" className="forge-header-logo" />
                <div className="forge-header-title">
                  <Heading>The Forge ({state?.hostname ?? "ai-sandbox"})</Heading>
                  <Text muted>· branch: {state?.integrationBranch ?? "ai-work"}</Text>
                </div>
              </div>
              <div className="forge-header-actions">
                <Badge variant={connected ? "success" : "warning"}>{connected ? "SSE Live" : "Reconnecting..."}</Badge>
                {error && <Badge variant="danger">Error: {error}</Badge>}
                <Button variant="ghost" size="sm" onClick={() => void reload()}>
                  Refresh
                </Button>
              </div>
            </div>
          </Pane>
        )}

        {!state ? (
          <Pane padding={16}>
            <Text>Connecting to Forge state stream...</Text>
          </Pane>
        ) : (
          <Tabs value={tab} onValueChange={(k) => setTab(k as TabKey)}>
            {!hideChrome && (
              <TabsList>
                {tabs.map((t) => (
                  <TabsTrigger key={t.key} value={t.key}>
                    {t.title}
                  </TabsTrigger>
                ))}
              </TabsList>
            )}
            {isConsole ? (
              <div className="forge-tab-fill">
                <ConsoleView
                  fullscreen={consoleFullscreen}
                  onToggleFullscreen={() => setConsoleFullscreen((f) => !f)}
                />
              </div>
            ) : (
              <div className="forge-tab-scroll">
                {tabs.map((t) => (
                  <TabsContent key={t.key} value={t.key}>
                    {t.content}
                  </TabsContent>
                ))}
              </div>
            )}
          </Tabs>
        )}
      </div>
      <ToastHost />
    </ThemeProvider>
  );
}
