import { useState } from "react";
import { UI } from "@tbe/ui";
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
        <UI.Button label={busy === "sync" ? "Syncing..." : "Sync Worktrees"} disabled={busy !== null} onClick={() => void syncAll()} />
        {notice && <UI.Label>{notice}</UI.Label>}
      </UI.HStack>

      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(10)} align="stretch">
          <UI.Label>Shared Packages (@tbe/*) — Version-Guarded Live Linking</UI.Label>
          {packages.length === 0 && <UI.Label>No @tbe/* packages found under /projects.</UI.Label>}
          {packages.map((p) => (
            <UI.Panel key={p.name} padding={UI.Size.px(10)}>
              <UI.VStack spacing={UI.Size.px(8)} align="stretch">
                <UI.HStack spacing={UI.Size.px(8)} align="center">
                  <UI.Label>{p.name} v{p.version}</UI.Label>
                  {(p.dirty || p.unpushed) && (
                    <UI.Label>[WARN: {p.dirty ? "dirty uncommitted edits" : "unpushed commits"}]</UI.Label>
                  )}
                  <UI.Spacer />
                  {p.hasApiDts && (
                    <UI.Button preset="ghost" label="View API.d.ts" onClick={() => void viewApiDts(p.name)} />
                  )}
                  <UI.Button
                    preset="ghost"
                    label={busy === `build:${p.name}` ? "Building..." : "Build + Emit .d.ts"}
                    disabled={busy !== null}
                    onClick={() => void rebuildPkg(p.name)}
                  />
                </UI.HStack>

                {p.consumers.map((c) => (
                  <UI.HStack key={c.repo} spacing={UI.Size.px(8)} align="center">
                    <UI.Label>{c.repo}</UI.Label>
                    <UI.Label>(pinned: {c.pinnedVersion})</UI.Label>
                    {c.updateAvailable && <UI.Label>[Update available -&gt; {p.version}]</UI.Label>}
                    <UI.Spacer />
                    <UI.Button
                      preset="ghost"
                      label={c.linked ? "Unlink Local" : "Link Local"}
                      disabled={busy !== null}
                      onClick={() => void toggleLink(p.name, c.repo, !c.linked)}
                    />
                  </UI.HStack>
                ))}
              </UI.VStack>
            </UI.Panel>
          ))}
        </UI.VStack>
      </UI.Panel>

      <UI.Panel padding={UI.Size.px(12)}>
        <UI.VStack spacing={UI.Size.px(6)} align="stretch">
          <UI.Label>Repositories in /projects</UI.Label>
          {repos.map((r) => (
            <UI.HStack key={r.name} spacing={UI.Size.px(10)}>
              <UI.Label>{r.name}</UI.Label>
              <UI.Label>({r.branch})</UI.Label>
              <UI.Spacer />
              <UI.Label>
                {r.dirty ? "dirty" : "clean"}
                {r.ahead > 0 ? ` · +${r.ahead} unpushed` : ""}
                {r.behind > 0 ? ` · -${r.behind} behind` : ""}
              </UI.Label>
              <UI.Button
                preset="ghost"
                label={busy === `push:${r.name}` ? "Pushing..." : "Push"}
                disabled={busy !== null}
                onClick={() => void pushRepoBranch(r.name)}
              />
            </UI.HStack>
          ))}
        </UI.VStack>
      </UI.Panel>

      <UI.Modal
        open={apiModal !== null}
        title={apiModal ? `${apiModal.name} — API.d.ts` : ""}
        onClose={() => setApiModal(null)}
        width={UI.Size.px(820)}
        height={UI.Size.px(560)}
      >
        <UI.Scroll height={UI.Size.px(460)}>
          <UI.Padded padding={UI.Size.px(8)}>
            <pre>{apiModal?.content ?? ""}</pre>
          </UI.Padded>
        </UI.Scroll>
      </UI.Modal>
    </UI.VStack>
  );
}
