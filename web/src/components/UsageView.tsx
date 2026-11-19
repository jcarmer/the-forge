import { useState } from "react";
import { UI } from "@tbe/ui";
import { Button, Heading, Pane, Progress, Text, WrapRow } from "../components";
import type { UsageSnapshot } from "../types";
import { postAction } from "../hooks/useForgeState";

function daysUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "unknown";
  if (ms <= 0) return "now";
  const days = Math.ceil(ms / 86_400_000);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

export default function UsageView({ usage }: { usage: UsageSnapshot | null }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const entries = (usage?.entries ?? []).filter((e) => expanded || e.scope !== "5h");

  async function refreshUsage() {
    setBusy(true);
    try {
      await postAction("/api/actions/usage-refresh");
    } catch (error) {
      console.error("Error refreshing usage:", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <WrapRow gap={8}>
            <Heading>AI Provider Quotas</Heading>
            <div style={{ flex: "1 1 0%" }} />
            <Text muted>
              {usage ? `Collected ${new Date(usage.collectedAt).toLocaleTimeString()}` : "No usage snapshot yet"}
            </Text>
            <Button variant="default" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Hide details" : "Show details"}
            </Button>
            <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => void refreshUsage()}>
              {busy ? "Refreshing..." : "Refresh Usage"}
            </Button>
          </WrapRow>

          {entries.length ? (
            <UI.VStack spacing={UI.Size.px(8)} align="stretch">
              {entries.map((e, i) => (
                <UI.VStack key={`${e.provider}-${e.scope}-${e.model ?? i}`} spacing={UI.Size.px(4)} align="stretch">
                  <WrapRow gap={8}>
                    <Text>{e.provider}</Text>
                    <Text muted>
                      ({e.scope}
                      {e.model ? ` / ${e.model}` : ""})
                    </Text>
                    <div style={{ flex: "1 1 0%" }} />
                    <Text muted>
                      {expanded ? `Resets ${new Date(e.resetsAt).toLocaleString()}` : `Resets ${daysUntil(e.resetsAt)}`}
                    </Text>
                  </WrapRow>
                  <Progress
                    value={e.remainingPct}
                    max={100}
                    showLabel
                    variant={e.remainingPct > 25 ? "success" : e.remainingPct > 10 ? "default" : "danger"}
                    aria-label={`${e.provider} ${e.scope} quota remaining`}
                  />
                </UI.VStack>
              ))}
            </UI.VStack>
          ) : (
            <Text muted>Click "Refresh Usage" to collect live 5h/weekly quota windows.</Text>
          )}
        </UI.VStack>
      </Pane>
    </UI.VStack>
  );
}
