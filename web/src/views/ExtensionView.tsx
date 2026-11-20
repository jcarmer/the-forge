import { useCallback, useEffect, useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Choice, Pane, Text, TextDialog, WrapRow } from "../components";
import { forgeApi } from "../hooks/forgeApi";
import { showError, showToast } from "../components/Toast";
import { Section, TextArea, TextField, copyText } from "./git/ui";

interface Action {
  id: string; label: string; enabled: boolean; matchUrl: string; contains?: string;
  request: { path: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string };
  storeAs: string; minIntervalMinutes: number;
}
interface Meta { name: string; actionId: string; url: string; status: number; contentType: string; bytes: number; receivedAt: string }

const blank = (): Action => ({ id: `a${Date.now().toString(36)}`, label: "", enabled: true, matchUrl: "https://", request: { path: "/", method: "GET", headers: {} }, storeAs: "", minIntervalMinutes: 60 });
const headersToText = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
const textToHeaders = (t: string) =>
  Object.fromEntries(t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

export function ExtensionView() {
  const [actions, setActions] = useState<Action[]>([]);
  const [collected, setCollected] = useState<Meta[]>([]);
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<{ title: string; content: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await forgeApi<{ actions: Action[]; hasToken: boolean; collected: Meta[] }>("GET", "/api/ext/actions");
      setCollected(d.collected);
      setHasToken(d.hasToken);
      setActions((cur) => (dirty ? cur : d.actions));
    } catch (e) { showError(e); }
  }, [dirty]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, [load]);

  const edit = (i: number, patch: Partial<Action>) => { setActions(actions.map((a, j) => (j === i ? { ...a, ...patch } : a))); setDirty(true); };
  const editReq = (i: number, patch: Partial<Action["request"]>) => edit(i, { request: { ...(actions[i] as Action).request, ...patch } });

  async function save() {
    try {
      const cleaned = actions.map((a) => ({ ...a, contains: a.contains || undefined, request: { ...a.request, body: a.request.body || undefined } }));
      await forgeApi("PUT", "/api/ext/actions", { actions: cleaned });
      setDirty(false);
      showToast("success", "Actions saved. The extension picks them up within a few minutes (or press Sync in its options).");
    } catch (e) { showError(e); }
  }

  async function show(m: Meta) {
    const res = await fetch(`/api/ext/collected/${encodeURIComponent(m.name)}`);
    setView({ title: `${m.name} (${m.bytes} bytes, HTTP ${m.status})`, content: (await res.text()).slice(0, 200_000) });
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Section title="Browser extension">
        <Text muted>
          Install the extension from the repo's extension/ folder (see its README). Then give it this Forge's address and a token. Actions are plain settings, never code: when a page matching the URL loads, the extension fetches one path on that same site with your login and sends the raw reply here.
        </Text>
        <WrapRow gap={8}>
          <Button onClick={() => void forgeApi<{ token: string }>("POST", "/api/ext/token").then((r) => { setToken(r.token); setHasToken(true); }).catch(showError)}>
            {hasToken ? "Rotate token" : "Create token"}
          </Button>
          <Badge variant={hasToken ? "success" : "warning"}>{hasToken ? "token set" : "no token"}</Badge>
          <Text muted>Forge URL for the extension: {window.location.origin}</Text>
        </WrapRow>
        {token && (
          <WrapRow gap={8}>
            <code style={{ overflowWrap: "anywhere" }}>{token}</code>
            <Button size="sm" variant="ghost" onClick={() => void copyText(token)}>Copy</Button>
            <Text muted>Shown once. Rotating invalidates the old one.</Text>
          </WrapRow>
        )}
      </Section>

      <Section
        title="Actions"
        right={
          <WrapRow gap={8}>
            <Button variant="ghost" onClick={() => { setActions([...actions, blank()]); setDirty(true); }}>Add action</Button>
            <Button variant="primary" disabled={!dirty} onClick={() => void save()}>Save{dirty ? " *" : ""}</Button>
          </WrapRow>
        }
      >
        {actions.length === 0 && <Text muted>No actions yet.</Text>}
        {actions.map((a, i) => (
          <Pane key={a.id} padding={10}>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              <TextField label="Label" value={a.label} onChange={(e) => edit(i, { label: e.target.value })} />
              <TextField label="When the page URL matches (https://example.com/account/*)" value={a.matchUrl} onChange={(e) => edit(i, { matchUrl: e.target.value })} />
              <TextField label="...and the page text matches this regex (optional)" value={a.contains ?? ""} onChange={(e) => edit(i, { contains: e.target.value })} />
              <WrapRow gap={8} align="flex-end">
                <Choice label="Method" width={110} value={a.request.method} options={[{ key: "GET", label: "GET" }, { key: "POST", label: "POST" }]} onChange={(m) => editReq(i, { method: m })} />
                <div style={{ flex: "1 1 240px" }}><TextField label="Fetch this path on the same site" value={a.request.path} onChange={(e) => editReq(i, { path: e.target.value })} /></div>
              </WrapRow>
              <TextArea label="Headers (Name: value, one per line)" rows={2} value={headersToText(a.request.headers)} onChange={(e) => editReq(i, { headers: textToHeaders(e.target.value) })} />
              {a.request.method === "POST" && <TextArea label="Body" rows={3} value={a.request.body ?? ""} onChange={(e) => editReq(i, { body: e.target.value })} />}
              <WrapRow gap={8} align="flex-end">
                <TextField label="Store raw result as" value={a.storeAs} onChange={(e) => edit(i, { storeAs: e.target.value.toLowerCase() })} />
                <TextField label="At most once per (minutes)" value={String(a.minIntervalMinutes)} onChange={(e) => edit(i, { minIntervalMinutes: Number(e.target.value) || 1 })} />
              </WrapRow>
              <WrapRow gap={8}>
                <Button size="sm" variant="ghost" onClick={() => edit(i, { enabled: !a.enabled })}>{a.enabled ? "Disable" : "Enable"}</Button>
                {!a.enabled && <Badge variant="default">DISABLED</Badge>}
                <Button size="sm" variant="danger" onClick={() => { setActions(actions.filter((_, j) => j !== i)); setDirty(true); }}>Remove</Button>
              </WrapRow>
            </UI.VStack>
          </Pane>
        ))}
      </Section>

      <Section title="Collected data">
        {collected.length === 0 && <Text muted>Nothing received yet.</Text>}
        {collected.map((m) => (
          <WrapRow key={m.name} gap={8}>
            <Text>{m.name}</Text>
            <Text muted>{new Date(m.receivedAt).toLocaleString()} - {m.bytes} bytes - HTTP {m.status} - {m.url}</Text>
            <Button size="sm" variant="ghost" onClick={() => void show(m)}>View raw</Button>
          </WrapRow>
        ))}
      </Section>
      <TextDialog open={!!view} title={view?.title ?? ""} content={view?.content ?? ""} onClose={() => setView(null)} />
    </UI.VStack>
  );
}
