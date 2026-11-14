import { useState } from "react";
import { UI } from "@tbe/ui";
import type { RouteDecision, TaskComplexity, UsageSnapshot } from "../types";
import { postAction } from "../hooks/useForgeState";

export function UsageRouterView({ usage }: { usage: UsageSnapshot | null }) {
  const [complexity, setComplexity] = useState<TaskComplexity>("normal");
  const [modelHint, setModelHint] = useState("");
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [busy, setBusy] = useState(false);

  async function refreshUsage() {
    setBusy(true);
    try {
      await postAction("/api/actions/usage-refresh");
    } finally {
      setBusy(false);
    }
  }

  async function simulateRoute() {
    setBusy(true);
    try {
      const res = await postAction<RouteDecision>("/api/actions/route-sim", {
        complexity,
        modelHint: modelHint.trim() || undefined,
      });
      setDecision(res);
    } finally {
      setBusy(false);
    }
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <UI.HStack spacing={UI.Size.px(8)} align="center">
            <UI.Label>AI Provider Quotas</UI.Label>
            <UI.Spacer />
            <UI.Label>
              {usage ? `Collected ${new Date(usage.collectedAt).toLocaleTimeString()}` : "No usage snapshot yet"}
            </UI.Label>
            <UI.Button label={busy ? "Refreshing..." : "Refresh Usage"} disabled={busy} onClick={() => void refreshUsage()} />
          </UI.HStack>

          {usage?.entries.length ? (
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              {usage.entries.map((e, i) => (
                <UI.VStack key={`${e.provider}-${e.scope}-${e.model ?? i}`} spacing={UI.Size.px(4)} align="stretch">
                  <UI.HStack spacing={UI.Size.px(8)}>
                    <UI.Label>{e.provider}</UI.Label>
                    <UI.Label>({e.scope}{e.model ? ` / ${e.model}` : ""})</UI.Label>
                    <UI.Spacer />
                    <UI.Label>Resets {new Date(e.resetsAt).toLocaleString()}</UI.Label>
                  </UI.HStack>
                  <UI.ProgressBar
                    value={e.remainingPct}
                    max={100}
                    height={UI.Size.px(18)}
                    label="{percent}% remaining"
                    fillColor={e.remainingPct > 25 ? "#2ea043" : e.remainingPct > 10 ? "#d29922" : "#f85149"}
                  />
                </UI.VStack>
              ))}
            </UI.VStack>
          ) : (
            <UI.Label>Click "Refresh Usage" to collect live 5h/weekly quota windows.</UI.Label>
          )}
        </UI.VStack>
      </UI.Panel>

      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <UI.Label>Route Simulator (pickProvider dry-run)</UI.Label>
          <UI.HStack spacing={UI.Size.px(10)} align="center">
            <UI.Dropdown
              label="Complexity"
              selected={complexity}
              options={[
                { key: "trivial", label: "trivial (Ollama first)" },
                { key: "normal", label: "normal (Ollama first)" },
                { key: "hard", label: "hard (Cloud burn-rate)" },
              ]}
              onSelect={(k) => setComplexity(k)}
            />
            <UI.TextBox
              value={modelHint}
              placeholder="Optional model hint (e.g. Claude)"
              onChange={(v) => setModelHint(v)}
              width={UI.Size.px(240)}
            />
            <UI.Button label="Simulate Route" disabled={busy} onClick={() => void simulateRoute()} />
          </UI.HStack>

          {decision && (
            <UI.Panel padding={UI.Size.px(10)}>
              <UI.VStack spacing={UI.Size.px(4)} align="stretch">
                <UI.Label>Chosen Provider: {decision.provider ?? "NONE"}</UI.Label>
                <UI.Label>Reason: {decision.reason}</UI.Label>
                <pre>{JSON.stringify({ scores: decision.scores, blocked: decision.blocked }, null, 2)}</pre>
              </UI.VStack>
            </UI.Panel>
          )}
        </UI.VStack>
      </UI.Panel>
    </UI.VStack>
  );
}
