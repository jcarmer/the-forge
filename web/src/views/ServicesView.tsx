import { useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button } from "reend-components";
import { Heading, Pane, Text, TextDialog } from "../components";
import type { ServiceStatus } from "../types";
import { postAction } from "../hooks/useForgeState";

export function ServicesView({ services, hostname }: { services: ServiceStatus[]; hostname: string }) {
  const [logModal, setLogModal] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [pair, setPair] = useState<{ credential: string; expiresAt: string } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairBusy, setPairBusy] = useState(false);

  async function requestPair() {
    setPairBusy(true);
    setPairError(null);
    try {
      setPair(await postAction<{ credential: string; expiresAt: string }>("/api/actions/t3-pair"));
    } catch (e) {
      setPair(null);
      setPairError(e instanceof Error ? e.message : String(e));
    } finally {
      setPairBusy(false);
    }
  }

  const host = typeof window !== "undefined" ? window.location.hostname : hostname;

  async function handleControl(name: string, action: "start" | "stop" | "restart") {
    setBusy(`${name}:${action}`);
    setNotice(null);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/service", { name, action });
      setNotice(res.detail);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openLogs(name: string) {
    try {
      const res = await fetch(`/api/logs/${encodeURIComponent(name)}?tail=200`);
      const data = (await res.json()) as { content: string };
      setLogModal({ name, content: data.content });
    } catch (e) {
      setLogModal({ name, content: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Pane padding={12}>
        <UI.HStack spacing={UI.Size.px(16)} align="center">
          <Heading>VS Code Web Tunnel</Heading>
          <a href={`https://vscode.dev/tunnel/${hostname}/projects`} target="_blank" rel="noreferrer">
            vscode.dev/tunnel/{hostname}/projects
          </a>
          {notice && <Badge variant="info">{notice}</Badge>}
        </UI.HStack>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <UI.HStack spacing={UI.Size.px(16)} align="center">
            <Heading>T3 Pairing</Heading>
            <Button variant="ghost" size="sm" disabled={pairBusy} onClick={() => void requestPair()}>
              {pairBusy ? "..." : pair ? "New pair code" : "Get pair code"}
            </Button>
            {pairError && <Badge variant="danger">{pairError}</Badge>}
          </UI.HStack>
          {pair && (
            <>
              <a href={`http://${host}:3773/pair#token=${pair.credential}`} target="_blank" rel="noreferrer">
                Open T3 and pair this browser
              </a>
              <Text muted>
                Or enter the code: <code style={{ userSelect: "all" }}>{pair.credential}</code> (single use, expires{" "}
                {new Date(pair.expiresAt).toLocaleTimeString()})
              </Text>
            </>
          )}
        </UI.VStack>
      </Pane>

      <UI.Wrap horizontalSpacing={UI.Size.px(12)} verticalSpacing={UI.Size.px(12)}>
        {services.map((s) => (
          <Pane key={s.id} width={320} padding={14}>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              <UI.HStack spacing={UI.Size.px(8)} align="center">
                <Heading>{s.name}</Heading>
                <UI.Spacer />
                {s.kind === "preview" ? (
                  <Badge variant={s.state === "running" ? "success" : "default"}>{s.state}</Badge>
                ) : (
                  <Text muted>:{s.port}</Text>
                )}
              </UI.HStack>

              <UI.HStack spacing={UI.Size.px(8)} align="center">
                <a href={`http://${host}:${s.port}`} target="_blank" rel="noreferrer">
                  http://{host}:{s.port}
                </a>
                {s.branch && <Text muted>({s.branch})</Text>}
              </UI.HStack>

              <UI.HStack spacing={UI.Size.px(6)}>
                <Button variant="ghost" size="sm" onClick={() => void openLogs(s.id)}>
                  Logs
                </Button>
                {s.kind === "preview" && (
                  <>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void handleControl(s.name, "restart")}>
                      {busy === `${s.name}:restart` ? "..." : "Restart"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void handleControl(s.name, s.state === "running" ? "stop" : "start")}
                    >
                      {s.state === "running" ? "Stop" : "Start"}
                    </Button>
                  </>
                )}
              </UI.HStack>
            </UI.VStack>
          </Pane>
        ))}
      </UI.Wrap>

      <TextDialog
        open={logModal !== null}
        title={logModal ? `Logs: ${logModal.name}` : ""}
        content={logModal?.content ?? ""}
        onClose={() => setLogModal(null)}
      />
    </UI.VStack>
  );
}
