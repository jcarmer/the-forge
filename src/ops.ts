import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./schema.js";
import { renderAll } from "./generators/index.js";
import { FACTS_START, FACTS_END, factsHash } from "./generators/setupMd.js";

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false, ...opts });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), missing: r.error?.message.includes("ENOENT") ?? false };
}

/** Plain-English prerequisite checks. Each failure carries a concrete fix. */
export function preflight(m: Manifest, dir: string): Check[] {
  const checks: Check[] = [];
  const docker = run("docker", ["--version"]);
  checks.push({
    name: "Docker installed",
    ok: docker.code === 0,
    detail: docker.code === 0 ? docker.out.trim() : "Docker was not found.",
    fix: "Install Docker Desktop with the WSL 2 backend, start it, then re-run.",
  });
  if (docker.code === 0) {
    const info = run("docker", ["info"]);
    checks.push({
      name: "Docker daemon running",
      ok: info.code === 0,
      detail: info.code === 0 ? "running" : "Docker is installed but not running.",
      fix: "Start Docker Desktop and wait for the whale icon to say 'running'.",
    });
  }
  const envPath = join(dir, ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const hasKey = (k: string) => new RegExp(`^${k}=\\S+`, "m").test(env);
  checks.push({
    name: ".env file",
    ok: existsSync(envPath),
    detail: existsSync(envPath) ? "found" : "missing",
    fix: "Copy .env.example to .env and fill in the values.",
  });
  checks.push({
    name: `Tailscale key (${m.network.authKeyEnv})`,
    ok: hasKey(m.network.authKeyEnv),
    detail: hasKey(m.network.authKeyEnv) ? "set" : "not set",
    fix: `Create a reusable auth key tagged ${m.network.tailscaleTag} in the Tailscale admin console and put it in .env.`,
  });
  checks.push({
    name: "GitHub token (GH_TOKEN)",
    ok: hasKey("GH_TOKEN"),
    detail: hasKey("GH_TOKEN") ? "set" : "not set (agents cannot push)",
    fix: "Create a fine-grained PAT (Contents read/write, selected repos only) and put it in .env.",
  });
  for (const [label, path] of [["buddy.env", m.paths.buddyEnvFile], ["meta repo", m.paths.metaDir]] as const) {
    checks.push({ name: label, ok: existsSync(path), detail: existsSync(path) ? path : `missing: ${path}`, fix: `Restore ${path} (see SETUP.md).` });
  }
  return checks;
}

/** Live checks against the running container. */
export function doctor(m: Manifest): Check[] {
  const c = m.containerName;
  const exec = (cmd: string) => run("docker", ["exec", c, "bash", "-lc", cmd]);
  const checks: Check[] = [];
  const running = run("docker", ["inspect", "-f", "{{.State.Running}}", c]);
  const up = running.out.trim() === "true";
  checks.push({ name: "Container running", ok: up, detail: up ? "yes" : "no", fix: "Run: sandboxctl up" });
  if (!up) return checks;

  const ts = exec("tailscale status 2>&1 | head -n 1");
  checks.push({
    name: "On tailnet",
    ok: run("docker", ["exec", `${c}_tailscale`, "tailscale", "status"]).code === 0,
    detail: "tailscale sidecar status",
    fix: "Tailscale key may be expired or the tag not allowed. Make a new key, update .env, run: sandboxctl up",
  });
  void ts;
  const gpu = exec("nvidia-smi -L");
  checks.push({ name: "GPU visible", ok: gpu.code === 0, detail: gpu.out.trim().split("\n")[0], fix: "Update NVIDIA driver and restart Docker Desktop." });
  const models = exec("ollama list");
  for (const model of [m.ollama.primaryModel, ...m.ollama.extraModels]) {
    checks.push({ name: `Model ${model}`, ok: models.out.includes(model), detail: models.out.includes(model) ? "present" : "missing", fix: "It downloads on start; check disk space and: sandboxctl logs ollama" });
  }
  for (const s of m.services) {
    const ok = exec(`curl -s -o /dev/null --max-time 3 http://127.0.0.1:${s.port}/`).code === 0;
    checks.push({ name: `Service ${s.name} :${s.port}`, ok, detail: ok ? "responding" : "not responding", fix: `sandboxctl logs ${s.name}` });
  }
  const gh = exec('[ -n "$GH_TOKEN" ]');
  checks.push({ name: "GH_TOKEN in container", ok: gh.code === 0, detail: gh.code === 0 ? "set" : "empty", fix: "Add GH_TOKEN to .env and run: sandboxctl up" });
  return checks;
}

export type Drift = { kind: "config" | "facts" | "live"; message: string };

/** Reports what would be lost or leaked when moving from the old bind-mounted workspace to the volume. */
export function migrateCheck(m: Manifest): { dir: string; status: "ok" | "warn"; note: string }[] {
  const root = m.paths.legacySandboxDir;
  if (!root || !existsSync(root)) return [{ dir: root ?? "(unset)", status: "warn", note: "legacy workspace not found" }];
  const known = new Set(m.repos.map((r) => r.name));
  const ignored = new Set(m.paths.ignoredLegacyDirs);
  const rows: { dir: string; status: "ok" | "warn"; note: string }[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || ignored.has(e.name)) continue;
    const p = join(root, e.name);
    if (!existsSync(join(p, ".git"))) {
      rows.push({ dir: e.name, status: "warn", note: "not a git repo: copy it into the volume manually (or back it up); `clone` will not bring it over" });
      continue;
    }
    const git = (...a: string[]) => run("git", ["-C", p, ...a]).out.trim();
    const dirty = git("status", "--short").split("\n").filter((l) => l && !l.startsWith("warning")).length;
    const unpushed = git("log", "--branches", "--not", "--remotes", "--oneline").split("\n").filter(Boolean).length;
    const remote = git("remote", "get-url", "origin");
    const notes: string[] = [];
    if (!remote) notes.push("no remote: it can only be copied, not cloned");
    if (/\/\/[^/@]+:[^@]+@/.test(remote)) notes.push("remote URL contains an embedded credential: rotate that token and clean the URL");
    if (dirty) notes.push(`${dirty} uncommitted change(s): commit/push before migrating`);
    if (unpushed) notes.push(`${unpushed} unpushed commit(s)`);
    if (remote && !known.has(e.name)) notes.push("not listed in manifest `repos`");
    rows.push({ dir: e.name, status: notes.length ? "warn" : "ok", note: notes.join("; ") || "clean and pushed" });
  }
  return rows;
}

/** Clones every manifest repo missing from /projects inside the running container. */
export function cloneRepos(m: Manifest): { name: string; ok: boolean; detail: string }[] {
  return m.repos.map((r) => {
    const cmd = `[ -d /projects/${r.name}/.git ] && echo exists || git clone ${r.url} /projects/${r.name} 2>&1 | tail -n 2`;
    const res = run("docker", ["exec", m.containerName, "bash", "-lc", cmd]);
    const ok = res.code === 0 && !/fatal|error/i.test(res.out);
    return { name: r.name, ok, detail: res.out.trim().split("\n").pop() ?? "" };
  });
}

/** Detects hand-edited generated files, stale SETUP.md facts, and live-vs-manifest mismatches. */
export function drift(m: Manifest, dir: string): Drift[] {
  const out: Drift[] = [];
  for (const [name, content] of Object.entries(renderAll(m))) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      out.push({ kind: "config", message: `${name} has not been generated. Run: sandboxctl generate` });
    } else if (readFileSync(p, "utf8").replace(/\r\n/g, "\n") !== content) {
      out.push({ kind: "config", message: `${name} differs from the manifest (hand-edited or manifest changed). Run: sandboxctl generate, or move your change into sandbox.config.ts.` });
    }
  }
  const setup = join(dir, "SETUP.md");
  if (existsSync(setup)) {
    const t = readFileSync(setup, "utf8");
    const block = t.slice(t.indexOf(FACTS_START), t.indexOf(FACTS_END));
    if (!block.includes(factsHash(m))) out.push({ kind: "facts", message: "SETUP.md facts are out of date relative to the manifest. Regenerate and review the diff." });
  }
  const live = run("docker", ["compose", "ps", "--services"], { cwd: dir });
  if (live.code === 0) {
    const names = new Set(live.out.split("\n").map((s) => s.trim()).filter(Boolean));
    for (const expected of ["tailscale", "dev"]) {
      if (!names.has(expected)) out.push({ kind: "live", message: `Service "${expected}" is not running.` });
    }
    for (const n of names) {
      if (!["tailscale", "dev"].includes(n)) out.push({ kind: "live", message: `Unexpected service "${n}" is running but is not in the manifest or SETUP.md. Add it to sandbox.config.ts.` });
    }
  }
  return out;
}
