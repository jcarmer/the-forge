import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../sandbox.config.js";
import { writeAll } from "./generators/index.js";
import { preflight, doctor, drift, run, type Check } from "./ops.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "generated");
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
    process.exitCode = d.length ? 1 : 0;
    break;
  }
  default:
    console.log("sandboxctl <generate|init|up|down|status|doctor|logs [svc]|tunnel-login|healthcheck>");
}
