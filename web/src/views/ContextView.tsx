import { useCallback, useEffect, useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Choice, Heading, Pane, Text } from "../components";
import UsageView from '../components/UsageView';
import { UsageSnapshot } from "../types";

interface ContextItem {
  kind: "guidance" | "rule" | "skill" | "mcp" | "setting";
  provider: "claude" | "antigravity" | "opencode" | "shared";
  scope: "global" | "ancestor" | "project";
  name: string;
  path: string;
  approxTokens: number;
  detail?: string;
}
interface ContextReport {
  project: string;
  scannedAt: string;
  items: ContextItem[];
  warnings: string[];
}

const KINDS: { key: ContextItem["kind"]; title: string; hint: string }[] = [
  { key: "guidance", title: "Guidance", hint: "CLAUDE.md / AGENTS.md / GEMINI.md and their @imports: loaded into every conversation" },
  { key: "rule", title: "Rules", hint: "Rule files loaded alongside guidance" },
  { key: "skill", title: "Skills", hint: "Only name + description sit in context until a skill is invoked" },
  { key: "mcp", title: "MCP servers", hint: "Secrets are never shown. Servers T3 injects at runtime appear under Sessions" },
  { key: "setting", title: "Settings", hint: "Hooks and permissions" },
];

const scopeVariant = (s: ContextItem["scope"]) => (s === "project" ? "success" : s === "ancestor" ? "warning" : "default");

export function ContextView({ usage }: { usage: UsageSnapshot | null }) {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [report, setReport] = useState<ContextReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/context?project=${encodeURIComponent(p)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport((await res.json()) as ContextReport);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/context/projects");
      const { projects: list } = (await res.json()) as { projects: string[] };
      setProjects(list);
      if (list[0]) setProject(list[0]);
    })();
  }, []);

  useEffect(() => {
    if (project) void load(project);
  }, [project, load]);

  const total = report?.items.reduce((n, i) => n + i.approxTokens, 0) ?? 0;

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">

      <UsageView usage={usage} />

      <Pane padding={12}>
        <UI.HStack spacing={UI.Size.px(12)} align="center">
          <Heading>AI Context</Heading>
          <Choice label="Project" value={project} options={projects.map((p) => ({ key: p, label: p }))} onChange={setProject} width={320} />
          <UI.Spacer />
          <Text muted>{report ? `~${total.toLocaleString()} tokens of static context` : ""}</Text>
          <Button variant="primary" size="sm" loading={busy} disabled={busy || !project} onClick={() => void load(project)}>
            Rescan
          </Button>
        </UI.HStack>
        {error && <Text muted>{error}</Text>}
      </Pane>

      {report && report.warnings.length > 0 && (
        <Pane padding={12}>
          <UI.VStack spacing={UI.Size.px(4)} align="stretch">
            <Heading>Warnings</Heading>
            {report.warnings.map((w) => (
              <Text key={w}>! {w}</Text>
            ))}
          </UI.VStack>
        </Pane>
      )}

      {report &&
        KINDS.map((k) => {
          const items = report.items.filter((i) => i.kind === k.key);
          return (
            <Pane key={k.key} padding={12}>
              <UI.VStack spacing={UI.Size.px(8)} align="stretch">
                <UI.HStack spacing={UI.Size.px(8)} align="center">
                  <Heading>{`${k.title} (${items.length})`}</Heading>
                  <Text muted>{k.hint}</Text>
                </UI.HStack>
                {items.length === 0 && <Text muted>None in effect.</Text>}
                {items.map((i, idx) => (
                  <UI.VStack key={`${i.path}-${i.name}-${idx}`} spacing={UI.Size.px(2)} align="stretch">
                    <UI.HStack spacing={UI.Size.px(8)} align="center">
                      <Badge variant={scopeVariant(i.scope)}>{i.scope}</Badge>
                      <Badge>{i.provider}</Badge>
                      <Text>{i.name}</Text>
                      <UI.Spacer />
                      {i.approxTokens > 0 && <Text muted>~{i.approxTokens.toLocaleString()} tok</Text>}
                    </UI.HStack>
                    {i.detail && <Text muted>{i.detail}</Text>}
                    <Text muted>{i.path}</Text>
                  </UI.VStack>
                ))}
              </UI.VStack>
            </Pane>
          );
        })}
    </UI.VStack>
  );
}
