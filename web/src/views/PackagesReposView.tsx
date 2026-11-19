import { useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button, Heading, Pane, Text, TextDialog, WrapRow } from "../components";
import type { PackageStatus, RepoStatus } from "../types";
import { postAction } from "../hooks/useForgeState";
import { showError, showToast } from "../components/Toast";

export function PackagesReposView({
  packages,
  repos,
}: {
  packages: PackageStatus[];
  repos: RepoStatus[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [apiModal, setApiModal] = useState<{ name: string; content: string } | null>(null);

  async function toggleLink(pkg: string, consumer: string, enable: boolean) {
    setBusy(`${pkg}:${consumer}`);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/package-link", { pkg, consumer, enable });
      showToast("success", res.detail);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function rebuildPkg(pkg: string) {
    setBusy(`build:${pkg}`);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/package-build", { pkg });
      showToast("success", res.detail);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function pushRepoBranch(repo: string) {
    setBusy(`push:${repo}`);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/repo-push", { repo });
      showToast("success", res.detail);
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function syncAll() {
    setBusy("sync");
    try {
      const res = await postAction<{ updated: string[] }>("/api/actions/sync");
      showToast("success", res.updated.length ? `Updated: ${res.updated.join(", ")}` : "All worktrees up to date.");
    } catch (e) {
      showError(e);
    } finally {
      setBusy(null);
    }
  }

  async function viewApiDts(pkgName: string) {
    const res = await fetch(`/api/packages/api?name=${encodeURIComponent(pkgName)}`);
    const data = (await res.json()) as { content?: string; error?: string };
    setApiModal({ name: pkgName, content: data.content ?? data.error ?? "Not found" });
  }

  return (
    <UI.VStack spacing={UI.Size.px(12)} align="stretch">
      <WrapRow gap={8}>
        <Button variant="primary" size="sm" loading={busy === "sync"} disabled={busy !== null} onClick={() => void syncAll()}>
          {busy === "sync" ? "Syncing..." : "Sync Worktrees"}
        </Button>
      </WrapRow>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <Heading>Shared Packages (@tbe/*) — Version-Guarded Live Linking</Heading>
          {packages.length === 0 && <Text muted>No @tbe/* packages found under /projects.</Text>}
          {packages.map((p) => (
            <Pane key={p.name} padding={10}>
              <UI.VStack spacing={UI.Size.px(8)} align="stretch">
                <WrapRow gap={8}>
                  <Text>
                    {p.name} v{p.version}
                  </Text>
                  {(p.dirty || p.unpushed) && (
                    <Badge variant="warning">{p.dirty ? "dirty uncommitted edits" : "unpushed commits"}</Badge>
                  )}
                  <div style={{ flex: "1 1 0%" }} />
                  {p.hasApiDts && (
                    <Button variant="ghost" size="sm" onClick={() => void viewApiDts(p.name)}>
                      View API.d.ts
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void rebuildPkg(p.name)}>
                    {busy === `build:${p.name}` ? "Building..." : "Build + Emit .d.ts"}
                  </Button>
                </WrapRow>

                {p.consumers.map((c) => (
                  <WrapRow key={c.repo} gap={8}>
                    <Text>{c.repo}</Text>
                    <Text muted>(pinned: {c.pinnedVersion})</Text>
                    {c.updateAvailable && <Badge variant="primary">Update available -&gt; {p.version}</Badge>}
                    <div style={{ flex: "1 1 0%" }} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void toggleLink(p.name, c.repo, !c.linked)}
                    >
                      {c.linked ? "Unlink Local" : "Link Local"}
                    </Button>
                  </WrapRow>
                ))}
              </UI.VStack>
            </Pane>
          ))}
        </UI.VStack>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(8)} align="stretch">
          <Heading>Repositories in /projects</Heading>
          {repos.map((r) => (
            <WrapRow key={r.name} gap={8}>
              <Text>{r.name}</Text>
              <Text muted>({r.branch})</Text>
              <div style={{ flex: "1 1 0%" }} />
              <Badge variant={r.dirty || r.unpushed || r.stashes > 0 ? "warning" : "success"}>
                {r.dirty || r.unpushed || r.stashes > 0 ? "pending" : "clean"}
              </Badge>
              {r.dirty && <Badge variant="warning">uncommitted changes</Badge>}
              {r.noUpstream && <Badge variant="info">{`branch not on remote${r.ahead > 0 ? ` (+${r.ahead} commits)` : ""}`}</Badge>}
              {r.ahead > 0 && !r.noUpstream && <Badge variant="info">+{r.ahead} unpushed</Badge>}
              {r.localOnlyCommits > r.ahead && <Badge variant="info">{r.localOnlyCommits - r.ahead} unpushed on other branches</Badge>}
              {r.stashes > 0 && <Badge variant="info">{r.stashes} stash{r.stashes > 1 ? "es" : ""}</Badge>}
              {r.behind > 0 && <Badge variant="warning">-{r.behind} behind</Badge>}
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void pushRepoBranch(r.name)}>
                {busy === `push:${r.name}` ? "Pushing..." : "Push"}
              </Button>
            </WrapRow>
          ))}
        </UI.VStack>
      </Pane>

      <TextDialog
        open={apiModal !== null}
        title={apiModal ? `${apiModal.name} — API.d.ts` : ""}
        content={apiModal?.content ?? ""}
        onClose={() => setApiModal(null)}
      />
    </UI.VStack>
  );
}
