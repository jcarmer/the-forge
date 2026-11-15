#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../sandbox.config.js";
import { writeAll } from "./generators/index.js";
import { preflight, doctor, drift, run, migrateCheck, cloneRepos, createT3Pairing, t3PairingUrl, type Check } from "./ops.js";
import { collectUsage } from "./usage/collector.js";
import { pickProvider, type TaskComplexity } from "./usage/router.js";
import { UsageSnapshotSchema, type ProviderName } from "./usage/schema.js";
import { syncMainToIntegration, createTaskWorktree, mergeTaskWorktree } from "./git/worktree.js";
import { openPullRequest } from "./git/pullRequest.js";
import { startPreviewLandingServer, syncPreviewWorktrees, syncTbeVscodeExtension } from "./preview/supervisor.js";
import { checkCoderModelUpdates } from "./healthcheck/models.js";
import { buildProvisionSteps, checkAuthStatus, runProvision } from "./provision/steps.js";
import { listProjects, scanContext } from "./context/inventory.js";
import { getSession, listSessions, windowTotals } from "./sessions/parse.js";
import { annotateWithOllama, deterministicFlags } from "./sessions/analyze.js";
import { buildOverview, loadStories, renderDigest } from "./sessions/digest.js";
import { renderStoryText, storyForFile } from "./sessions/story.js";
import { listSessionFiles, defaultSources } from "./sessions/parse.js";
import { executeTask } from "./worker/runner.js";
import { taskStorePath, upsertTaskRecord } from "./worker/taskStore.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "generated");
const stateDir = resolve(root, ".forge-state");
const [cmd = "help", ...rest] = process.argv.slice(2);

function printChecks(checks: Check[]): boolean {
  for (const c of checks) {
    console.log(`${c.ok ? "OK  " : "FAIL"} ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) console.log(`     -> ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} problem(s) found.` : "\nAll checks passed.");
  return failed === 0;
}

function compose(args: string[]) {
  const r = run("docker", ["compose", ...args], { cwd: dir });
  process.stdout.write(r.out);
  return r.code;
}

switch (cmd) {
  case "generate": {
    for (const f of writeAll(manifest, dir)) console.log("wrote", f);
    break;
  }
  case "init": {
    writeAll(manifest, dir);
    console.log(`Generated files in ${dir}\n`);
    process.exitCode = printChecks(preflight(manifest, dir)) ? 0 : 1;
    break;
  }
  case "up": {
    writeAll(manifest, dir);
    if (!printChecks(preflight(manifest, dir))) {
      console.log("\nFix the problems above, then run `up` again.");
      process.exitCode = 1;
      break;
    }
    process.exitCode = compose(["up", "-d", "--build"]);
    console.log("\nNext: run `sandboxctl tunnel-login` (one time), then `sandboxctl doctor`.");
    break;
  }
  case "down":
    process.exitCode = compose(["down"]);
    break;
  case "status":
    process.exitCode = compose(["ps"]);
    break;
  case "doctor":
    process.exitCode = printChecks(doctor(manifest)) ? 0 : 1;
    break;
  case "logs": {
    const svc = rest[0] ?? "buddy";
    const file = svc === "buddy" ? "/var/log/buddy.log" : `/var/log/${svc}.log`;
    const r = run("docker", ["exec", manifest.containerName, "tail", "-n", "100", file]);
    process.stdout.write(r.out);
    process.exitCode = r.code;
    break;
  }
  case "t3-pair": {
    const res = createT3Pairing(manifest, rest[0] ?? "10m");
    if (!res.ok) { console.error(res.detail); process.exitCode = 1; break; }
    console.log(`Open this link to pair a browser (expires ${res.pairing.expiresAt}, single use):`);
    console.log(t3PairingUrl(manifest, res.pairing.credential));
    console.log(`\nOr paste this code on the T3 pairing screen: ${res.pairing.credential}`);
    break;
  }
  case "tunnel-login": {
    console.log("Follow the device-login prompt below, then run `npx tsx src/cli.ts up` to start the tunnel.");
    const r = spawnSync("docker", ["exec", "-it", manifest.containerName, "code", "tunnel", "user", "login", "--provider", "github"], { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
    break;
  }
  case "healthcheck": {
    const d = drift(manifest, dir);
    if (!d.length) console.log("No drift detected.");
    for (const x of d) console.log(`[${x.kind}] ${x.message}`);

    // Test case: verify live /usage collection & parsing works when container is running
    const target = rest.find((a) => !a.startsWith("-")) ?? manifest.containerName;
    if (run("docker", ["inspect", "-f", "{{.State.Running}}", target]).out.trim() === "true") {
      const snap = await collectUsage(manifest, stateDir, { containerName: target });
      for (const [prov, src] of Object.entries(snap.sources)) {
        const ok = src !== "error";
        console.log(`[usage] ${prov}: ${ok ? `OK (${src})` : "FAIL (parse/exec error)"}`);
        if (!ok) d.push({ kind: "live", message: `/usage failed for ${prov}` });
      }
    }

    // Model upgrade check (10 GB VRAM)
    const rec = await checkCoderModelUpdates(manifest);
    for (const c of rec.candidates) console.log(`[model] ${c.tag}: ${c.note}`);
    process.exitCode = d.length ? 1 : 0;
    break;
  }
  case "sync": {
    const repo = rest[0];
    if (!repo) {
      console.error("Usage: the-forge sync <repoDir>");
      process.exitCode = 1;
      break;
    }
    const r = syncMainToIntegration(repo, manifest.git.mainBranch, manifest.git.integrationBranch);
    console.log(r.ok ? `OK: ${r.detail}` : `FAIL${r.conflict ? " (CONFLICT — spawn resolution task)" : ""}: ${r.detail}`);
    process.exitCode = r.ok ? 0 : 1;
    break;
  }
  case "promote": {
    const repo = rest[0];
    if (!repo) {
      console.error("Usage: the-forge promote <repoDir>   (opens a PR from the integration branch into main for you to review)");
      process.exitCode = 1;
      break;
    }
    const { mainBranch, integrationBranch } = manifest.git;
    const pr = openPullRequest(repo, {
      head: integrationBranch,
      base: mainBranch,
      title: `Promote ${integrationBranch} to ${mainBranch}`,
      body: `Automated promotion of \`${integrationBranch}\` into \`${mainBranch}\`. Review and merge when ready.`,
    });
    console.log(pr.ok ? `OK: ${pr.detail}: ${pr.url}` : `FAIL: ${pr.detail}`);
    process.exitCode = pr.ok ? 0 : 1;
    break;
  }
  case "context": {
    const targets = rest[0] ? [rest[0]] : listProjects("/projects", [root]);
    for (const dir of targets) {
      const r = scanContext(dir);
      console.log(`\n== ${r.project}`);
      for (const kind of ["guidance", "rule", "skill", "mcp", "setting"] as const) {
        const items = r.items.filter((i) => i.kind === kind);
        if (!items.length) continue;
        console.log(`  ${kind} (${items.length}, ~${items.reduce((n, i) => n + i.approxTokens, 0)} tokens)`);
        for (const i of items) console.log(`    [${i.provider}/${i.scope}] ${i.name}${i.detail ? ` - ${i.detail.slice(0, 90)}` : ""}`);
      }
      for (const w of r.warnings) console.log(`  ! ${w}`);
    }
    break;
  }
  case "sessions": {
    if (rest[0] === "digest") {
      // Markdown brief of recent conversations, meant to be handed to an LLM for workflow advice.
      const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
      const days = Number(flag("--days") ?? 7);
      const redact = rest.includes("--redact");
      const stories = loadStories(days, { redact });
      const md = renderDigest(stories, buildOverview(stories, days), { redact });
      const out = flag("--out");
      if (out) {
        writeFileSync(out, md);
        console.log(`Wrote ${md.length} characters (${stories.length} conversations) to ${out}`);
      } else console.log(md);
      break;
    }
    if (rest[0] === "story") {
      // Narrative of one conversation: turns, timing, tools, and findings.
      const q = rest[1];
      const f = q && q.length >= 8 ? listSessionFiles(defaultSources()).find((x) => x.file.includes(q)) : undefined;
      if (!f) {
        console.error(q ? `No session matching ${q}` : "Usage: the-forge sessions story <id>");
        process.exitCode = 1;
        break;
      }
      console.log(renderStoryText(storyForFile(f.file, f.source, { redact: rest.includes("--redact") })));
      break;
    }
    const id = rest.find((a) => !a.startsWith("--"));
    const week = windowTotals();
    if (!id) {
      for (const s of listSessions()) {
        const mcp = s.mcp.map((m) => `${m.server}:${m.calls}`).join(",") || "-";
        console.log(`${s.id.slice(0, 8)}  ${s.source.padEnd(17)} ${s.startedAt.slice(0, 16)}  steps=${String(s.stepCount).padStart(3)}  fresh=${String(s.totals.fresh).padStart(8)}  total=${String(s.totals.total).padStart(10)}  mcp=${mcp}  ${s.project ?? ""}`);
      }
      console.log(`\nLast 7 days: ${week.fresh} fresh / ${week.total} total tokens across ${week.sessions} sessions`);
      break;
    }
    const d = getSession(id);
    if (!d) {
      console.error(`No session matching ${id}`);
      process.exitCode = 1;
      break;
    }
    const flags = deterministicFlags(d);
    console.log(`${d.id} (${d.source}) ${d.project ?? ""}\nmodels: ${d.models.join(", ")}  steps: ${d.stepCount}  fresh: ${d.totals.fresh}  total: ${d.totals.total}  (${((d.totals.fresh / Math.max(week.fresh, 1)) * 100).toFixed(1)}% of last-7-day fresh tokens)`);
    if (d.allowedMcp?.length) console.log(`MCP pre-approved by T3: ${d.allowedMcp.join(", ")}`);
    for (const m of d.mcp) console.log(`MCP ${m.server}: ${m.calls} calls (${Object.entries(m.tools).map(([k, v]) => `${k}x${v}`).join(", ")}), ~${m.attributedFresh} fresh tokens`);
    for (const f of flags) console.log(`  step ${f.index} [${f.kind}] ${f.message}`);
    if (rest.includes("--ollama")) {
      const a = await annotateWithOllama(d, { model: manifest.ollama.primaryModel });
      console.log(a.ok ? `\nOllama (${a.model}):` : `\nOllama failed: ${a.detail}`);
      for (const n of a.notes) console.log(`  step ${d.steps.findIndex((s) => s.id === n.stepId) + 1}: ${n.note}`);
    }
    break;
  }
  case "worktree": {
    const [action, repo, taskId] = rest;
    if (!action || !repo || !taskId) {
      console.error("Usage: the-forge worktree <create|merge> <repoDir> <taskId>");
      process.exitCode = 1;
      break;
    }
    if (action === "create") {
      const r = createTaskWorktree(repo, taskId, manifest.git.integrationBranch, manifest.git.taskBranchPrefix);
      console.log(r.ok ? `OK: ${r.worktreePath} (${r.branch})` : `FAIL: ${r.detail}`);
      process.exitCode = r.ok ? 0 : 1;
    } else if (action === "merge") {
      const r = mergeTaskWorktree(repo, taskId, manifest.git.integrationBranch, manifest.git.taskBranchPrefix);
      console.log(r.ok ? `OK: ${r.detail}` : `FAIL: ${r.detail}`);
      process.exitCode = r.ok ? 0 : 1;
    }
    break;
  }
  case "preview": {
    const projectsRoot = rest[0] ?? "/projects";
    startPreviewLandingServer(manifest, projectsRoot, 5173);
    let syncing = false;
    const tick = async () => {
      if (syncing) return;
      syncing = true;
      try {
        await syncPreviewWorktrees(projectsRoot, manifest.git.integrationBranch);
        await syncTbeVscodeExtension(projectsRoot);
      } finally {
        syncing = false;
      }
    };
    void tick();
    setInterval(() => void tick(), 30_000);
    console.log("Preview landing server listening on :5173");
    break;
  }
  case "provision": {
    const outcomes = runProvision(buildProvisionSteps(manifest));
    let failed = 0;
    for (const o of outcomes) {
      if (o.status === "failed") failed++;
      console.log(`[Provision] ${o.name}: ${o.status}${o.detail ? ` (${o.detail})` : ""}`);
    }
    process.exitCode = failed ? 1 : 0;
    break;
  }
  case "auth-status": {
    process.exitCode = printChecks(checkAuthStatus(manifest).map((a) => ({ name: a.service, ok: a.ok, detail: a.ok ? "authenticated" : "missing", fix: a.fix }))) ? 0 : 1;
    break;
  }
  case "rebuild": {
    writeAll(manifest, dir);
    const b = run("npm", ["run", "build"], { cwd: root });
    if (b.code !== 0) { process.stdout.write(b.out); process.exitCode = b.code; break; }
    if (existsSync("/.dockerenv")) {
      // Spawn a detached helper container so `the_forge` can recreate itself without dying mid-command
      const r = run("docker", ["run", "--rm", "-d", "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${manifest.paths.forgeDir}:/forge`, "-w", "/forge/generated", "docker:cli", "sh", "-c", "docker compose up -d --build"]);
      process.stdout.write(r.out);
      process.exitCode = r.code;
    } else {
      process.exitCode = compose(["up", "-d", "--build"]);
    }
    break;
  }
  case "usage": {
    const target = rest[0] ?? manifest.containerName;
    const snap = await collectUsage(manifest, stateDir, { containerName: target });
    console.log(`Collected at ${snap.collectedAt}`);
    for (const [p, s] of Object.entries(snap.sources)) console.log(`  source[${p}] = ${s}`);
    for (const e of snap.entries) {
      console.log(`  ${e.provider.padEnd(11)} ${e.scope.padEnd(12)} ${(e.model ?? "-").padEnd(22)} ${String(e.remainingPct).padStart(4)}%  resets ${e.resetsAt}`);
    }
    break;
  }
  case "route": {
    const complexity = (rest[0] as TaskComplexity) || "normal";
    const exclude = rest.slice(1) as ProviderName[];
    const cacheFile = resolve(stateDir, "usage.json");
    const snap = existsSync(cacheFile)
      ? UsageSnapshotSchema.parse(JSON.parse(readFileSync(cacheFile, "utf8")))
      : await collectUsage(manifest, stateDir);
    const decision = pickProvider(manifest, snap, { complexity, exclude });
    console.log(`Chosen: ${decision.provider ?? "NONE"} (${decision.reason})`);
    console.log("Scores:", JSON.stringify(decision.scores));
    if (Object.keys(decision.blocked).length) console.log("Blocked:", JSON.stringify(decision.blocked));
    break;
  }
  case "build":
    writeAll(manifest, dir);
    process.exitCode = compose(["build"]);
    break;
  case "migrate-check": {
    let warn = 0;
    for (const r of migrateCheck(manifest)) {
      if (r.status === "warn") warn++;
      console.log(`${r.status === "ok" ? "OK  " : "WARN"} ${r.dir}: ${r.note}`);
    }
    console.log(warn ? `\n${warn} item(s) need attention before cutover.` : "\nReady to migrate.");
    break;
  }
  case "clone": {
    let bad = 0;
    for (const r of cloneRepos(manifest)) {
      if (!r.ok) bad++;
      console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}: ${r.detail}`);
    }
    process.exitCode = bad ? 1 : 0;
    break;
  }
  case "dispatch": {
    const flag = (k: string) => {
      const i = rest.indexOf(k);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const repoDir = flag("--repo") ?? process.cwd();
    const complexity = (flag("--complexity") as TaskComplexity) || "normal";
    const prompt = flag("--prompt") ?? rest.filter((a) => !a.startsWith("--")).join(" ");
    if (!prompt) {
      console.error("Usage: sandboxctl dispatch --repo <dir> --complexity <trivial|normal|hard> --prompt <text>");
      process.exitCode = 1;
      break;
    }
    const id = `task-${Date.now().toString(36)}`;
    const startedAt = new Date().toISOString();
    const storeFile = taskStorePath(existsSync("/var/lib/the-forge") ? "/var/lib/the-forge" : stateDir);
    upsertTaskRecord({ id, repoDir, prompt, complexity, status: "running", startedAt, merged: false, attempts: [] }, storeFile);
    const snap = await collectUsage(manifest, stateDir);
    const outcome = await executeTask(manifest, snap, { id, repoDir, prompt, complexity });
    upsertTaskRecord({
      id, repoDir, prompt, complexity,
      status: outcome.ok ? "passed" : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      merged: outcome.merged,
      prUrl: outcome.prUrl,
      error: outcome.error,
      attempts: outcome.attempts,
    }, storeFile);
    console.log(JSON.stringify(outcome, null, 2));
    process.exitCode = outcome.ok ? 0 : 1;
    break;
  }
  default:
    console.log("the-forge <generate|init|build|up|down|rebuild|provision|auth-status|status|doctor|logs [svc]|tunnel-login|healthcheck|migrate-check|clone|usage|route|dispatch|sync|promote|context|sessions|worktree|preview>");
}
