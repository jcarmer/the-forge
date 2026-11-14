import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../sandbox.config.js";
import { writeAll } from "./generators/index.js";
import { preflight, doctor, drift, run, migrateCheck, cloneRepos, type Check } from "./ops.js";
import { collectUsage } from "./usage/collector.js";
import { pickProvider, type TaskComplexity } from "./usage/router.js";
import { UsageSnapshotSchema, type ProviderName } from "./usage/schema.js";

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
  case "tunnel-login": {
    console.log("Follow the device-login prompt below, then run `sandboxctl up` to start the tunnel.");
    const r = run("docker", ["exec", "-it", manifest.containerName, "code", "tunnel", "user", "login", "--provider", "github"]);
    process.stdout.write(r.out);
    process.exitCode = r.code;
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
    process.exitCode = d.length ? 1 : 0;
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
  default:
    console.log("the-forge <generate|init|build|up|down|status|doctor|logs [svc]|tunnel-login|healthcheck|migrate-check|clone|usage [container]|route [trivial|normal|hard]>");
}
