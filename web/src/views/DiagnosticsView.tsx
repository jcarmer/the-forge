import { useState } from "react";
import { UI } from "@tbe/ui";
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
        <UI.Button label={busy === "doctor" ? "Running..." : "Run Doctor"} disabled={busy !== null} onClick={() => void runDoctor()} />
        <UI.Button preset="ghost" label={busy === "provision" ? "Provisioning..." : "Run Provision"} disabled={busy !== null} onClick={() => void runProvision()} />
        <UI.Spacer />
        <UI.Label>Checked: {checkedAt ? new Date(checkedAt).toLocaleTimeString() : "never"}</UI.Label>
      </UI.HStack>

      {output && (
        <UI.Panel padding={UI.Size.px(10)}>
          <pre>{output}</pre>
        </UI.Panel>
      )}

      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <UI.Label>Container Doctor Checks</UI.Label>
          {checks.map((c) => (
            <UI.VStack key={c.name} spacing={UI.Size.px(2)} align="stretch">
              <UI.HStack spacing={UI.Size.px(10)}>
                <UI.Label>{c.ok ? "[OK]" : "[FAIL]"}</UI.Label>
                <UI.Label>{c.name}</UI.Label>
                <UI.Spacer />
                <UI.Label>{c.detail}</UI.Label>
              </UI.HStack>
              {!c.ok && c.fix && <UI.Label>Fix: {c.fix}</UI.Label>}
            </UI.VStack>
          ))}
        </UI.VStack>
      </UI.Panel>

      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <UI.Label>Auth Status (Claude / Codex / GH / Tailscale)</UI.Label>
          {auth.map((a) => (
            <UI.VStack key={a.name} spacing={UI.Size.px(2)} align="stretch">
              <UI.HStack spacing={UI.Size.px(10)}>
                <UI.Label>{a.ok ? "[OK]" : "[MISSING]"}</UI.Label>
                <UI.Label>{a.name}</UI.Label>
                <UI.Spacer />
                <UI.Label>{a.detail}</UI.Label>
              </UI.HStack>
              {!a.ok && a.fix && <UI.Label>Fix: {a.fix}</UI.Label>}
            </UI.VStack>
          ))}
        </UI.VStack>
      </UI.Panel>
    </UI.VStack>
  );
}
