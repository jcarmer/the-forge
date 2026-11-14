import { createServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../schema.js";
import { run } from "../ops.js";
import { loadProjectConfig } from "../gate/standards.js";

export interface PreviewTarget {
  name: string;
  branch: string;
  port: number;
  command: string;
}

/** Discovers previewable projects in `/projects` that declare a `preview` command or Vite `dev` script. */
export function discoverPreviews(projectsRoot: string, basePort = 5200): PreviewTarget[] {
  if (!existsSync(projectsRoot)) return [];
  const targets: PreviewTarget[] = [];
  let port = basePort;
  for (const e of readdirSync(projectsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const cfg = loadProjectConfig(join(projectsRoot, e.name));
    if (cfg.preview) targets.push({ name: e.name, branch: "ai-work", port: port++, command: cfg.preview });
  }
  return targets;
}

/** Fast-forwards each preview worktree to `origin/<integrationBranch>`. */
export function syncPreviewWorktrees(projectsRoot: string, integrationBranch: string): string[] {
  const updated: string[] = [];
  if (!existsSync(projectsRoot)) return updated;
  for (const e of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = join(projectsRoot, e.name);
    if (!existsSync(join(dir, ".git"))) continue;
    const r = run("git", ["-C", dir, "pull", "--ff-only", "origin", integrationBranch]);
    if (r.code === 0 && !r.out.includes("Already up to date")) updated.push(e.name);
  }
  return updated;
}

/** Serves the landing page on port 5173 listing all project previews, T3, and ComfyUI. */
export function startPreviewLandingServer(manifest: Manifest, projectsRoot = "/projects", port = 5173) {
  const server = createServer((_req, res) => {
    const previews = discoverPreviews(projectsRoot);
    const host = manifest.network.tailscaleHostname;
    const items = previews
      .map((p) => `<li><a href="http://${host}:${p.port}">${p.name}</a> (<code>${p.branch}</code> on :${p.port})</li>`)
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>The Forge — Previews</title>
<style>body{font:16px/1.5 system-ui;max-width:680px;margin:3rem auto;padding:0 1rem}</style>
<h1>The Forge (${host})</h1>
<ul>
  <li><a href="http://${host}:3773">T3 Code Orchestrator (:3773)</a></li>
  <li><a href="http://${host}:8188">ComfyUI (:8188)</a></li>
</ul>
<h2>Project Previews (ai-work)</h2>
<ul>${items || "<li>No previewable web projects detected yet.</li>"}</ul>`);
  });
  server.listen(port, "0.0.0.0");
  return server;
}
