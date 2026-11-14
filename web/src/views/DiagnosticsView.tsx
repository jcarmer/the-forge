import { useState } from "react";
import { UI } from "@tbe/ui";
import { Button, Heading, Pane, StatusBadge, Text } from "../components";
import type { CheckResult } from "../types";
import { postAction } from "../hooks/useForgeState";

export function DiagnosticsView({
  checks,
  auth,
  checkedAt,
}: {
  checks: CheckResult[];
  auth: CheckResult[];
  checkedAt: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);

  async function runDoctor() {
    setBusy("doctor");
    setOutput(null);
    try {
      await postAction("/api/actions/doctor");
      setOutput("Diagnostics refreshed.");
    } catch (e) {
      setOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runProvision() {
    setBusy("provision");
    setOutput(null);
    try {
      const res = await postAction<{ ok: boolean; outcomes: { name: string; status: string; detail?: string }[] }>("/api/actions/provision");
      setOutput(res.outcomes.map((o) => `${o.name}: ${o.status}${o.detail ? ` (${o.detail})` : ""}`).join("\n"));
    } catch (e) {
      setOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <UI.HStack spacing={UI.Size.px(8)} align="center">
        <Button variant="primary" size="sm" loading={busy === "doctor"} disabled={busy !== null} onClick={() => void runDoctor()}>
          {busy === "doctor" ? "Running..." : "Run Doctor"}
        </Button>
        <Button variant="ghost" size="sm" loading={busy === "provision"} disabled={busy !== null} onClick={() => void runProvision()}>
          {busy === "provision" ? "Provisioning..." : "Run Provision"}
        </Button>
        <UI.Spacer />
        <Text muted>Checked: {checkedAt ? new Date(checkedAt).toLocaleTimeString() : "never"}</Text>
      </UI.HStack>

      {output && (
        <Pane padding={10}>
          <pre>{output}</pre>
        </Pane>
      )}

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <Heading>Container Doctor Checks</Heading>
          {checks.map((c) => (
            <UI.VStack key={c.name} spacing={UI.Size.px(2)} align="stretch">
              <UI.HStack spacing={UI.Size.px(10)} align="center">
                <StatusBadge ok={c.ok}  />
                <Text>{c.name}</Text>
                <UI.Spacer />
                <Text muted>{c.detail}</Text>
              </UI.HStack>
              {!c.ok && c.fix && <Text muted>Fix: {c.fix}</Text>}
            </UI.VStack>
          ))}
        </UI.VStack>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <Heading>Auth Status (Claude / Codex / GH / Tailscale)</Heading>
          {auth.map((c) => (
            <UI.VStack key={c.name} spacing={UI.Size.px(2)} align="stretch">
              <UI.HStack spacing={UI.Size.px(10)} align="center">
                <StatusBadge ok={c.ok} okText="OK" failText="MISSING" />
                <Text>{c.name}</Text>
                <UI.Spacer />
                <Text muted>{c.detail}</Text>
              </UI.HStack>
              {!c.ok && c.fix && <Text muted>Fix: {c.fix}</Text>}
            </UI.VStack>
          ))}
        </UI.VStack>
      </Pane>
    </UI.VStack>
  );
}
