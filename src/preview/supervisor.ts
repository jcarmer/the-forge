import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Manifest } from "../schema.js";
import { loadProjectConfig } from "../gate/standards.js";

const execFileAsync = promisify(execFile);
async function runAsync(cmd: string, args: string[], timeout = 30_000) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, encoding: "utf8" });
    return { code: 0, out: stdout + stderr };
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

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

/** Fast-forwards each preview worktree to `origin/<integrationBranch>` without blocking the event loop. */
export async function syncPreviewWorktrees(projectsRoot: string, integrationBranch: string): Promise<string[]> {
  const updated: string[] = [];
  if (!existsSync(projectsRoot)) return updated;
  for (const e of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = join(projectsRoot, e.name);
    if (!existsSync(join(dir, ".git"))) continue;
    const r = await runAsync("git", ["-C", dir, "pull", "--ff-only", "origin", integrationBranch], 15_000);
    if (r.code === 0 && !r.out.includes("Already up to date")) updated.push(e.name);
  }
  return updated;
}

/** Rebuilds and reinstalls TBE's VS Code extension into the tunnel server whenever its source changes. */
export async function syncTbeVscodeExtension(projectsRoot: string): Promise<boolean> {
  const tbeDir = join(projectsRoot, "tbe");
  const extDir = join(tbeDir, "tools", "vscode");
  if (!existsSync(extDir)) return false;

  const rev = (await runAsync("git", ["-C", tbeDir, "rev-parse", "HEAD:tools/vscode", "HEAD:tools/modeling/viewer"])).out.trim();
  const stamp = "/tmp/tbe-vscode.rev";
  if (rev && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === rev) return false;

  const cmd = [
    "cd /projects/tbe/tools/modeling/viewer && pnpm build",
    "cd /projects/tbe/tools/vscode && pnpm build && pnpm package",
    "for srv in /root/.vscode/cli/servers/*/server/bin/code-server; do [ -x \"$srv\" ] && \"$srv\" --install-extension /projects/tbe/tools/vscode/tbe-vscode.vsix --force; done",
  ].join(" && ");
  const r = await runAsync("bash", ["-lc", cmd], 120_000);
  if (r.code === 0 && rev) {
    writeFileSync(stamp, rev, "utf8");
    return true;
  }
  return false;
}

function superviseTarget(t: PreviewTarget, manifest?: Manifest, backoffMs = 5000) {
  t.state = "starting";
  const startedAt = Date.now();
  const log = createWriteStream(`/var/log/preview-${t.name}.log`, { flags: "a" });
  const boot = `[ ! -d node_modules ] && pnpm install; exec ${t.command}`;
  const child = spawn("bash", ["-lc", boot], {
    cwd: t.dir,
    detached: true,
    env: {
      ...process.env,
      PORT: String(t.port),
      HOST: "0.0.0.0",
      CHOKIDAR_USEPOLLING: "1",
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: manifest?.network.tailscaleHostname ?? "ai-sandbox",
    },
  });
  t.state = "running";
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("exit", (code) => {
    t.state = "stopped";
    // Kill the whole process group (Vite/tsc children) so restarts never leak PIDs
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    const nextBackoff = Date.now() - startedAt > 30_000 ? 5000 : Math.min(backoffMs * 2, 60_000);
    log.write(`[preview] ${t.name} exited (${code}); restarting in ${nextBackoff / 1000}s\n`);
    setTimeout(() => superviseTarget(t, manifest, nextBackoff), nextBackoff);
  });
}

/** Spawns supervised dev servers for all preview targets and serves the landing page on port 5173. */
export function startPreviewLandingServer(manifest: Manifest, projectsRoot = "/projects", port = 5173) {
  const targets = discoverPreviews(projectsRoot, manifest);
  for (const t of targets) superviseTarget(t, manifest);

  const server = createServer((req, res) => {
    const reqHost = (req.headers.host ?? manifest.network.tailscaleHostname).replace(/:\d+$/, "");
    const tunnelUrl = `https://vscode.dev/tunnel/${manifest.network.tailscaleHostname}/projects`;
    const items = targets
      .map((p) => `<li><a href="http://${reqHost}:${p.port}">${p.name}</a> (<code>${p.branch}</code> on :${p.port} — ${p.state ?? "starting"})</li>`)
      .join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>The Forge — Previews</title>
<style>body{font:16px/1.5 system-ui;max-width:680px;margin:3rem auto;padding:0 1rem}</style>
<h1>The Forge (${reqHost})</h1>
<ul>
  <li><a href="${tunnelUrl}">VS Code Web (tunnel: ${manifest.network.tailscaleHostname})</a></li>
  <li><a href="http://${reqHost}:3773">T3 Code Orchestrator (:3773)</a></li>
  <li><a href="http://${reqHost}:8188">ComfyUI (:8188)</a></li>
</ul>
<h2>Project Previews (${manifest.git.integrationBranch})</h2>
<ul>${items || "<li>No previewable web projects detected yet.</li>"}</ul>`);
  });
  server.listen(port, "0.0.0.0");
  return server;
}
