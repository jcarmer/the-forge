import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Manifest } from "../schema.js";
import { loadProjectConfig } from "../gate/standards.js";
import { createForgeRequestHandler, ForgeStateHub } from "../web-api/server.js";

const execFileAsync = promisify(execFile);
async function runAsync(cmd: string, args: string[], timeout = 30_000) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      killSignal: "SIGKILL",
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
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
  child?: ChildProcess;
  manualStop?: boolean;
  restartTimer?: ReturnType<typeof setTimeout>;
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

function killTargetGroup(t: PreviewTarget) {
  if (t.restartTimer) {
    clearTimeout(t.restartTimer);
    t.restartTimer = undefined;
  }
  if (t.child?.pid) {
    try { process.kill(-t.child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  t.child = undefined;
  t.state = "stopped";
}

function superviseTarget(t: PreviewTarget, manifest?: Manifest, backoffMs = 5000) {
  t.manualStop = false;
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
  t.child = child;
  t.state = "running";
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.on("exit", (code) => {
    t.state = "stopped";
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    if (t.manualStop) {
      log.write(`[preview] ${t.name} stopped by user\n`);
      return;
    }
    const nextBackoff = Date.now() - startedAt > 30_000 ? 5000 : Math.min(backoffMs * 2, 60_000);
    log.write(`[preview] ${t.name} exited (${code}); restarting in ${nextBackoff / 1000}s\n`);
    t.restartTimer = setTimeout(() => superviseTarget(t, manifest, nextBackoff), nextBackoff);
  });
}

/** Spawns supervised dev servers for all preview targets and serves the Forge web app + API on port 5173. */
export function startPreviewLandingServer(manifest: Manifest, projectsRoot = "/projects", port = 5173) {
  const targets = discoverPreviews(projectsRoot, manifest);
  for (const t of targets) superviseTarget(t, manifest);

  // Kill supervised dev-server process groups on shutdown so a `tsx watch` reload doesn't orphan them.
  const shutdown = () => {
    for (const t of targets) {
      t.manualStop = true;
      killTargetGroup(t);
    }
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  const here = dirname(fileURLToPath(import.meta.url));
  const candidateA = resolve(here, "..", "..", "web", "dist");
  const candidateB = resolve(here, "..", "..", "..", "web", "dist");
  const webDistDir = existsSync(candidateA) ? candidateA : candidateB;
  const stateDir = "/var/lib/the-forge";

  const services = {
    listTargets: () => targets,
    controlTarget: async (name: string, action: "start" | "stop" | "restart") => {
      const t = targets.find((x) => x.name === name);
      if (!t) return { ok: false, detail: `Unknown preview target: ${name}` };
      if (action === "stop") {
        t.manualStop = true;
        killTargetGroup(t);
        return { ok: true, detail: `Stopped ${name}` };
      }
      if (action === "restart") {
        t.manualStop = true;
        killTargetGroup(t);
        superviseTarget(t, manifest);
        return { ok: true, detail: `Restarted ${name}` };
      }
      if (t.state !== "running") superviseTarget(t, manifest);
      return { ok: true, detail: `Started ${name}` };
    },
    syncWorktrees: () => syncPreviewWorktrees(projectsRoot, manifest.git.integrationBranch),
  };

  const apiCtx = { manifest, projectsRoot, stateDir, webDistDir, services };
  const hub = new ForgeStateHub(apiCtx);

  void hub.refreshFast();
  hub.refreshDiagnostics();
  setInterval(() => { void hub.refreshFast(); }, 15_000);

  const handler = createForgeRequestHandler(apiCtx, hub);

  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(port, "0.0.0.0");
  return server;
}
