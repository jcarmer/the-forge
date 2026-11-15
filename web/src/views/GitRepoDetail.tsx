import { Button, Heading, Pane, Text } from "../components";
import type { GitRepoSummary } from "../types";

// TODO(task D): replaced by the real detail page. Keep the default export and props contract.
export default function GitRepoDetail({ repo, onBack }: { repo: GitRepoSummary; onBack: () => void }) {
  return (
    <Pane padding={16}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        </div>
        <Heading>{repo.name}</Heading>
        <Text muted>Detail page coming soon.</Text>
      </div>
    </Pane>
  );
}
