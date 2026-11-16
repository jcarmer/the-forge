import { useCallback, useEffect, useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Heading, Input, Pane, Text, TextDialog } from "../components";
import { postAction } from "../hooks/useForgeState";

interface Tile {
  id: string;
  label: string;
  kind: "workspace" | "service" | "custom";
  description?: string;
  path?: string;
  port?: number;
  url?: string;
  command?: string;
  hidden: boolean;
}

const KIND_LABEL: Record<Tile["kind"], string> = { workspace: "VS Code", service: "Service", custom: "Custom" };

async function saveTiles(tiles: Tile[]) {
  const body = {
    order: tiles.map((t) => t.id),
    hidden: tiles.filter((t) => t.hidden).map((t) => t.id),
    custom: tiles.filter((t) => t.kind === "custom").map(({ hidden: _h, ...rest }) => rest),
  };
  const res = await fetch("/api/dashboard", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `Save failed (${res.status})`);
}

export function DashboardView() {
  const [tiles, setTiles] = useState<Tile[] | null>(null);
  const [tunnelHost, setTunnelHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<{ title: string; content: string } | null>(null);
  const [draft, setDraft] = useState({ label: "", url: "", command: "" });

  const browserHost = typeof window !== "undefined" ? window.location.hostname : "";

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { hostname: string; tiles: Tile[] };
      setTiles(data.tiles);
      setTunnelHost(data.hostname);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function update(next: Tile[]) {
    setTiles(next);
    try {
      await saveTiles(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function move(i: number, d: -1 | 1) {
    if (!tiles || i + d < 0 || i + d >= tiles.length) return;
    const next = [...tiles];
    const [moved] = next.splice(i, 1);
    next.splice(i + d, 0, moved as Tile);
    void update(next);
  }

  function addCustom() {
    if (!tiles || !draft.label.trim() || (!draft.url.trim() && !draft.command.trim())) return;
    const tile: Tile = {
      id: `custom:${Date.now().toString(36)}`,
      label: draft.label.trim(),
      kind: "custom",
      ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
      ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
      hidden: false,
    };
    setDraft({ label: "", url: "", command: "" });
    void update([...tiles, tile]);
  }

  async function runCommand(t: Tile) {
    setBusy(t.id);
    try {
      const r = await postAction<{ output: string }>("/api/actions/dashboard-run", { id: t.id });
      setOutput({ title: t.label, content: r.output });
    } catch (e) {
      setOutput({ title: t.label, content: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const web = (t: Tile) => (t.kind === "workspace" ? `https://vscode.dev/tunnel/${tunnelHost}${t.path}` : t.kind === "service" ? `http://${browserHost}:${t.port}` : t.url);
  // Opens the same folder in desktop VS Code on this PC through the tunnel (needs the Remote - Tunnels extension).
  const desktop = (t: Tile) => (t.kind === "workspace" ? `vscode://vscode-remote/tunnel+${tunnelHost}${t.path}` : undefined);

  const visible = tiles?.filter((t) => !t.hidden) ?? [];

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      {error && <Badge variant="danger">{error}</Badge>}
      {!tiles && !error && <Text muted>Loading dashboard...</Text>}

      {configuring && tiles && (
        <Pane padding={12}>
          <UI.VStack spacing={UI.Size.px(8)} align="stretch">
            <Heading>Configure launch pad</Heading>
            <Text muted>Reorder, hide or add tiles. Changes save immediately. VS Code workspaces are discovered from /projects.</Text>
            {tiles.map((t, i) => (
              <UI.HStack key={t.id} spacing={UI.Size.px(8)} align="center">
                <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>▲</Button>
                <Button variant="ghost" size="sm" disabled={i === tiles.length - 1} onClick={() => move(i, 1)}>▼</Button>
                <span style={{ opacity: t.hidden ? 0.45 : 1, minWidth: 220 }}>{t.label}</span>
                <Badge>{KIND_LABEL[t.kind]}</Badge>
                <UI.Spacer />
                <Button variant="ghost" size="sm" onClick={() => void update(tiles.map((x) => (x.id === t.id ? { ...x, hidden: !x.hidden } : x)))}>
                  {t.hidden ? "Show" : "Hide"}
                </Button>
                {t.kind === "custom" && (
                  <Button variant="danger" size="sm" onClick={() => void update(tiles.filter((x) => x.id !== t.id))}>Remove</Button>
                )}
              </UI.HStack>
            ))}
            <Heading>Add custom tile</Heading>
            <UI.HStack spacing={UI.Size.px(8)} align="center">
              <Input placeholder="Label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              <Input placeholder="Link (https://...)" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
              <Input placeholder="Command to run in the container" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
              <Button size="sm" onClick={addCustom} disabled={!draft.label.trim() || (!draft.url.trim() && !draft.command.trim())}>Add</Button>
            </UI.HStack>
          </UI.VStack>
        </Pane>
      )}

      <UI.Wrap horizontalSpacing={UI.Size.px(12)} verticalSpacing={UI.Size.px(12)}>
        {visible.map((t) => (
          <Pane key={t.id} width={280} padding={14}>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              <UI.HStack spacing={UI.Size.px(8)} align="center">
                <Heading>{t.label}</Heading>
                <UI.Spacer />
                <Badge>{KIND_LABEL[t.kind]}</Badge>
              </UI.HStack>
              <Text muted>{t.description ?? t.path ?? (t.port ? `:${t.port}` : t.command ?? t.url ?? "")}</Text>
              <UI.HStack spacing={UI.Size.px(6)}>
                {web(t) && (
                  <Button variant="primary" size="sm" onClick={() => window.open(web(t), "_blank", "noopener")}>
                    {t.kind === "workspace" ? "Open (web)" : "Open"}
                  </Button>
                )}
                {desktop(t) && (
                  <Button variant="ghost" size="sm" onClick={() => (window.location.href = desktop(t)!)}>Desktop</Button>
                )}
                {t.command && (
                  <Button variant="secondary" size="sm" loading={busy === t.id} disabled={busy !== null} onClick={() => void runCommand(t)}>Run</Button>
                )}
              </UI.HStack>
            </UI.VStack>
          </Pane>
        ))}
      </UI.Wrap>
      {tiles && visible.length === 0 && <Text muted>Nothing visible. Use Configure to show or add tiles.</Text>}

      {/* Footer: sticks to the bottom of the view's scroll area. */}
      <div style={{ position: "sticky", bottom: 0, zIndex: 5, paddingTop: 8, background: "var(--background)" }}>
        <Pane padding={10}>
          <UI.HStack spacing={UI.Size.px(12)} align="center">
            <Text muted>{visible.length} shown{tiles && tiles.length > visible.length ? ` · ${tiles.length - visible.length} hidden` : ""}</Text>
            <UI.Spacer />
            <Button variant={configuring ? "primary" : "secondary"} size="sm" onClick={() => setConfiguring((c) => !c)}>
              {configuring ? "Done" : "Configure"}
            </Button>
          </UI.HStack>
        </Pane>
      </div>

      <TextDialog open={output !== null} title={output ? `Output: ${output.title}` : ""} content={output?.content ?? ""} onClose={() => setOutput(null)} />
    </UI.VStack>
  );
}
