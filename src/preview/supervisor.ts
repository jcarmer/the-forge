import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Manifest } from "../schema.js";
import { run } from "../ops.js";
import { loadProjectConfig } from "../gate/standards.js";

export interface PreviewTarget {
  name: string;
  dir: string;
  branch: string;
  port: number;
  command: string;
  state?: "starting" | "running" | "stopped";
}

/** Discovers previewable projects from manifest `previews` plus `.agents/project.yml` / `dev:host`. */
export function discoverPreviews(projectsRoot: string, manifest?: Manifest, basePort = 5200): PreviewTarget[] {
  if (!existsSync(projectsRoot)) return [];
  const targets: PreviewTarget[] = [];
  const seen = new Set<string>();

  for (const p of manifest?.previews ?? []) {
    const dir = join(projectsRoot, p.name);
    if (existsSync(dir)) {
      targets.push({ name: p.name, dir, branch: manifest?.git.integrationBranch ?? "ai-work", port: p.port, command: p.command });
      seen.add(p.name);
    }
  }

  let nextPort = Math.max(basePort, ...targets.map((t) => t.port + 1));
  for (const e of readdirSync(projectsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".") || seen.has(e.name)) continue;
    const dir = join(projectsRoot, e.name);
    const cfg = loadProjectConfig(dir);
    if (cfg.preview) {
      targets.push({ name: e.name, dir, branch: manifest?.git.integrationBranch ?? "ai-work", port: nextPort++, command: cfg.preview });
    }
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

function superviseTarget(t: PreviewTarget) {
  t.state = "starting";
  const log = createWriteStream(`/var/log/preview-${t.name}.log`, { flags: "a" });
  const boot = `[ ! -d node_modules ] && pnpm install; exec ${t.command}`;
  const child = spawn("bash", ["-lc", boot], {
    cwd: t.dir,
    env: { ...process.env, PORT: String(t.port), HOST: "0.0.0.0", CHOKIDAR_USEPOLLING: "1" },
  });
  t.state = "running";
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("exit", (code) => {
    t.state = "stopped";
    log.write(`[preview] ${t.name} exited (${code}); restarting in 5s\n`);
    setTimeout(() => superviseTarget(t), 5000);
  });
}

/** Spawns supervised dev servers for all preview targets and serves the landing page on port 5173. */
export function startPreviewLandingServer(manifest: Manifest, projectsRoot = "/projects", port = 5173) {
  const targets = discoverPreviews(projectsRoot, manifest);
  for (const t of targets) superviseTarget(t);

  const server = createServer((req, res) => {
    const reqHost = (req.headers.host ?? manifest.network.tailscaleHostname).replace(/:\d+$/, "");
    const items = targets
      .map((p) => `<li><a href="http://${reqHost}:${p.port}">${p.name}</a> (<code>${p.branch}</code> on :${p.port} — ${p.state ?? "starting"})</li>`)
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>The Forge — Previews</title>
<style>body{font:16px/1.5 system-ui;max-width:680px;margin:3rem auto;padding:0 1rem}</style>
<h1>The Forge (${reqHost})</h1>
<ul>
  <li><a href="http://${reqHost}:3773">T3 Code Orchestrator (:3773)</a></li>
  <li><a href="http://${reqHost}:8188">ComfyUI (:8188)</a></li>
</ul>
<h2>Project Previews (${manifest.git.integrationBranch})</h2>
<ul>${items || "<li>No previewable web projects detected yet.</li>"}</ul>`);
  });
  server.listen(port, "0.0.0.0");
  return server;
}
