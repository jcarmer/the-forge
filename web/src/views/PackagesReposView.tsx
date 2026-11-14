import { useState } from "react";
import { UI } from "@tbe/ui";
import { Badge, Button } from "reend-components";
import { Heading, Pane, Text, TextDialog } from "../components";
import type { PackageStatus, RepoStatus } from "../types";
import { postAction } from "../hooks/useForgeState";

export function PackagesReposView({
  packages,
  repos,
}: {
  packages: PackageStatus[];
  repos: RepoStatus[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiModal, setApiModal] = useState<{ name: string; content: string } | null>(null);

  async function toggleLink(pkg: string, consumer: string, enable: boolean) {
    setBusy(`${pkg}:${consumer}`);
    setNotice(null);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/package-link", { pkg, consumer, enable });
      setNotice(res.detail);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function rebuildPkg(pkg: string) {
    setBusy(`build:${pkg}`);
    setNotice(null);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/package-build", { pkg });
      setNotice(res.detail);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pushRepoBranch(repo: string) {
    setBusy(`push:${repo}`);
    setNotice(null);
    try {
      const res = await postAction<{ detail: string }>("/api/actions/repo-push", { repo });
      setNotice(res.detail);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function syncAll() {
    setBusy("sync");
    setNotice(null);
    try {
      const res = await postAction<{ updated: string[] }>("/api/actions/sync");
      setNotice(res.updated.length ? `Updated: ${res.updated.join(", ")}` : "All worktrees up to date.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
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
      <UI.HStack spacing={UI.Size.px(8)} align="center">
        <Button variant="primary" size="sm" loading={busy === "sync"} disabled={busy !== null} onClick={() => void syncAll()}>
          {busy === "sync" ? "Syncing..." : "Sync Worktrees"}
        </Button>
        {notice && <Badge variant="info">{notice}</Badge>}
      </UI.HStack>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <Heading>Shared Packages (@tbe/*) — Version-Guarded Live Linking</Heading>
          {packages.length === 0 && <Text muted>No @tbe/* packages found under /projects.</Text>}
          {packages.map((p) => (
            <Pane key={p.name} padding={10}>
              <UI.VStack spacing={UI.Size.px(8)} align="stretch">
                <UI.HStack spacing={UI.Size.px(8)} align="center">
                  <Text>
                    {p.name} v{p.version}
                  </Text>
                  {(p.dirty || p.unpushed) && (
                    <Badge variant="warning">{p.dirty ? "dirty uncommitted edits" : "unpushed commits"}</Badge>
                  )}
                  <UI.Spacer />
                  {p.hasApiDts && (
                    <Button variant="ghost" size="sm" onClick={() => void viewApiDts(p.name)}>
                      View API.d.ts
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void rebuildPkg(p.name)}>
                    {busy === `build:${p.name}` ? "Building..." : "Build + Emit .d.ts"}
                  </Button>
                </UI.HStack>

                {p.consumers.map((c) => (
                  <UI.HStack key={c.repo} spacing={UI.Size.px(8)} align="center">
                    <Text>{c.repo}</Text>
                    <Text muted>(pinned: {c.pinnedVersion})</Text>
                    {c.updateAvailable && <Badge variant="primary">Update available -&gt; {p.version}</Badge>}
                    <UI.Spacer />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void toggleLink(p.name, c.repo, !c.linked)}
                    >
                      {c.linked ? "Unlink Local" : "Link Local"}
                    </Button>
                  </UI.HStack>
                ))}
              </UI.VStack>
            </Pane>
          ))}
        </UI.VStack>
      </Pane>

      <Pane padding={12}>
        <UI.VStack spacing={UI.Size.px(6)} align="stretch">
          <Heading>Repositories in /projects</Heading>
          {repos.map((r) => (
            <UI.HStack key={r.name} spacing={UI.Size.px(10)} align="center">
              <Text>{r.name}</Text>
              <Text muted>({r.branch})</Text>
              <UI.Spacer />
              <Badge variant={r.dirty ? "warning" : "success"}>{r.dirty ? "dirty" : "clean"}</Badge>
              {r.ahead > 0 && <Badge variant="info">+{r.ahead} unpushed</Badge>}
              {r.behind > 0 && <Badge variant="warning">-{r.behind} behind</Badge>}
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void pushRepoBranch(r.name)}>
                {busy === `push:${r.name}` ? "Pushing..." : "Push"}
              </Button>
            </UI.HStack>
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
