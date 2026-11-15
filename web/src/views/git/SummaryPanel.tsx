import { Badge, Button, Text } from "../../components";
import type { SummaryState } from "./useAiSummary";
import { Row, Section } from "./ui";

export function SummaryPanel({
  state,
  hasChanges,
  changesLoaded,
  onRegenerate,
}: {
  state: SummaryState;
  hasChanges: boolean;
  changesLoaded: boolean;
  onRegenerate: () => void;
}) {
  const loading = state.status === "loading";
  return (
    <Section
      title="AI summary"
      right={
        hasChanges ? (
          <Button variant="secondary" size="sm" loading={loading} onClick={onRegenerate}>
            Regenerate
          </Button>
        ) : undefined
      }
    >
      {!changesLoaded ? (
        <Text muted>Waiting for the change list...</Text>
      ) : !hasChanges ? (
        <Text muted>No uncommitted changes to summarise.</Text>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-busy={loading}>
          {loading && (
            <div role="status" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span aria-hidden="true" className="git-spin" style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #00f3ff", borderTopColor: "transparent", borderRadius: "50%" }} />
              <Text muted>Asking {state.model || "the local model"}... this can take up to two minutes. You can keep using the page.</Text>
            </div>
          )}
          {state.summary && (
            <>
              <div style={{ fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere", opacity: loading ? 0.6 : 1 }}>{state.summary}</div>
              <Row gap={6}>
                {state.model && <Badge variant="secondary">{state.model}</Badge>}
                {state.cached && <Badge variant="default">cached</Badge>}
              </Row>
            </>
          )}
          {state.status === "error" && (
            <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Text>AI summary unavailable: {state.detail}</Text>
              <Text muted>Everything else on this page still works.</Text>
              <div>
                <Button variant="secondary" size="sm" onClick={onRegenerate}>
                  Retry
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
