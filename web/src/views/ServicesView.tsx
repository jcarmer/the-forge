import { useState } from "react";
import { UI } from "@tbe/ui";
import type { ServiceStatus } from "../types";
import { postAction } from "../hooks/useForgeState";

export function ServicesView({ services, hostname }: { services: ServiceStatus[]; hostname: string }) {
  const [logModal, setLogModal] = useState<{ name: string; content: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      <UI.Panel padding={UI.Size.px(12)}>
        <UI.HStack spacing={UI.Size.px(16)} align="center">
          <UI.Label>VS Code Web Tunnel:</UI.Label>
          <a href={`https://vscode.dev/tunnel/${hostname}/projects`} target="_blank" rel="noreferrer">
            vscode.dev/tunnel/{hostname}/projects
          </a>
          {notice && <UI.Label>{notice}</UI.Label>}
        </UI.HStack>
      </UI.Panel>

      <UI.Wrap horizontalSpacing={UI.Size.px(12)} verticalSpacing={UI.Size.px(12)}>
        {services.map((s) => (
          <UI.Panel key={s.id} width={UI.Size.px(320)} padding={UI.Size.px(14)}>
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              <UI.HStack spacing={UI.Size.px(8)} align="center">
                <UI.Label>{s.name}</UI.Label>
                <UI.Spacer />
                <UI.Label>{s.kind === "preview" ? s.state : `:${s.port}`}</UI.Label>
              </UI.HStack>

              <UI.HStack spacing={UI.Size.px(8)} align="center">
                <a href={`http://${host}:${s.port}`} target="_blank" rel="noreferrer">
                  http://{host}:{s.port}
                </a>
                {s.branch && <UI.Label>({s.branch})</UI.Label>}
              </UI.HStack>

              <UI.HStack spacing={UI.Size.px(6)}>
                <UI.Button preset="ghost" label="Logs" onClick={() => void openLogs(s.id)} />
                {s.kind === "preview" && (
                  <>
                    <UI.Button
                      preset="ghost"
                      label={busy === `${s.name}:restart` ? "..." : "Restart"}
                      disabled={busy !== null}
                      onClick={() => void handleControl(s.name, "restart")}
                    />
                    <UI.Button
                      preset="ghost"
                      label={s.state === "running" ? "Stop" : "Start"}
                      disabled={busy !== null}
                      onClick={() => void handleControl(s.name, s.state === "running" ? "stop" : "start")}
                    />
                  </>
                )}
              </UI.HStack>
            </UI.VStack>
          </UI.Panel>
        ))}
      </UI.Wrap>

      <UI.Modal
        open={logModal !== null}
        title={logModal ? `Logs: ${logModal.name}` : ""}
        onClose={() => setLogModal(null)}
        width={UI.Size.px(760)}
        height={UI.Size.px(520)}
      >
        <UI.Scroll height={UI.Size.px(420)}>
          <UI.Padded padding={UI.Size.px(8)}>
            <pre>{logModal?.content ?? ""}</pre>
          </UI.Padded>
        </UI.Scroll>
      </UI.Modal>
    </UI.VStack>
  );
}
