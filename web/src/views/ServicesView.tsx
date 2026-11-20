import { useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Heading, Pane, Text, WrapRow } from "../components";
import type { ServiceStatus } from "../types";
import { postAction } from "../hooks/useForgeState";
import { showError, showToast } from "../components/Toast";

export function ServicesView({ services, hostname }: { services: ServiceStatus[]; hostname: string }) {
  const [busy, setBusy] = useState<string | null>(null);

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
    try {
      const res = await postAction<{ detail: string }>("/api/actions/service", { name, action });
      showToast("success", res.detail);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  function openLogs(name: string) {
    window.open(`/logs/${encodeURIComponent(name)}`, `forge-logs-${name}`, "popup,width=1000,height=700");
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Pane padding={12}>
        <WrapRow gap={10}>
          <Heading>VS Code Web Tunnel</Heading>
          <a href={`https://vscode.dev/tunnel/${hostname}/projects`} target="_blank" rel="noreferrer" style={{ overflowWrap: "anywhere" }}>
            vscode.dev/tunnel/{hostname}/projects
          </a>
        </WrapRow>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <WrapRow gap={10}>
            <Heading>T3 Pairing</Heading>
            <Button variant="ghost" size="sm" disabled={pairBusy} onClick={() => void requestPair()}>
              {pairBusy ? "..." : pair ? "New pair code" : "Get pair code"}
            </Button>
            {pairError && <Badge variant="danger">{pairError}</Badge>}
          </WrapRow>
          {pair && (
            <>
              <a href={`http://${host}:3773/pair#token=${pair.credential}`} target="_blank" rel="noreferrer">
                Open T3 and pair this browser
              </a>
              <Text muted>
                Or enter the code: <code style={{ userSelect: "all", wordBreak: "break-all" }}>{pair.credential}</code> (single use, expires{" "}
                {new Date(pair.expiresAt).toLocaleTimeString()})
              </Text>
            </>
          )}
        </UI.VStack>
      </Pane>

      <div className="forge-grid-services">
        {services.map((s) => (
          <Pane key={s.id} padding={14}>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              <WrapRow gap={8} justify="space-between">
                <Heading>{s.name}</Heading>
                {s.kind === "preview" ? (
                  <Badge variant={s.state === "running" ? "success" : "default"}>{s.state}</Badge>
                ) : (
                  <Text muted>:{s.port}</Text>
                )}
              </WrapRow>

              <WrapRow gap={8}>
                <a href={`http://${host}:${s.port}`} target="_blank" rel="noreferrer" style={{ overflowWrap: "anywhere" }}>
                  http://{host}:{s.port}
                </a>
                {s.branch && <Text muted>({s.branch})</Text>}
              </WrapRow>

              <WrapRow gap={6}>
                <Button variant="ghost" size="sm" onClick={() => openLogs(s.id)}>
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
              </WrapRow>
            </UI.VStack>
          </Pane>
        ))}
      </div>
    </UI.VStack>
  );
}
