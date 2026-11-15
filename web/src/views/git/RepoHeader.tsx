import { Badge, Button, Heading, Text } from "../../components";
import type { GitLinks, GitRepoSummary } from "../../types";
import { tileChips } from "../gitTileChips";
import { ExternalLink, Row } from "./ui";

export function RepoHeader({
  repo,
  links,
  linksError,
  refreshing,
  onBack,
  onRefresh,
}: {
  repo: GitRepoSummary;
  links: GitLinks | null;
  linksError?: string;
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const chips = tileChips(repo);
  return (
    <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <Row gap={10}>
        <Button variant="ghost" onClick={onBack} aria-label="Back to all repositories">
          ← Back
        </Button>
        <h2 style={{ margin: 0, fontWeight: 400 }}>
          <Heading>{repo.name}</Heading>
        </h2>
        <Text muted>branch: {repo.branch || "(detached)"}</Text>
        <div style={{ flex: 1 }} />
        <Button variant="secondary" loading={refreshing} onClick={onRefresh}>
          Refresh
        </Button>
      </Row>
      <Row gap={6}>
        {chips.map((c) => (
          <Badge key={c.key} variant={c.variant}>
            {c.label}
          </Badge>
        ))}
      </Row>
      <Row gap={14}>
        {links?.repoUrl && <ExternalLink href={links.repoUrl}>Open on GitHub</ExternalLink>}
        {links?.prUrls.map((u) => (
          <ExternalLink key={u} href={u}>
            Open PR #{u.split("/").pop()}
          </ExternalLink>
        ))}
        {links?.compareUrl && <ExternalLink href={links.compareUrl}>Compare</ExternalLink>}
        {!links && !linksError && <Text muted>Loading links...</Text>}
        {linksError && <Text muted>Links unavailable: {linksError}</Text>}
        {links && !links.ghAvailable && links.repoUrl && <Text muted>(open PRs unknown: GitHub CLI unavailable)</Text>}
        {links && !links.repoUrl && <Text muted>No GitHub remote.</Text>}
      </Row>
    </header>
  );
}
