import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { normalizeLine } from "./suggest.js";

export interface RunResult {
  ok: boolean;
  output: string;
  cwd: string;
  exitCode: number | null;
  truncated?: boolean;
}

const MARK = "__FORGE_CWD__";
const MAX_OUTPUT = 60_000;

/**
 * Runs one command line in `cwd` and reports the directory the shell ended in, so `cd` sticks between calls.
 * Stdin is closed (no interactive programs) and the run is killed after `timeoutMs`.
 */
export function runCommand(cwd: string, rawLine: string, timeoutMs = 30_000): Promise<RunResult> {
  const line = normalizeLine(rawLine).trim();
  const start = existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : "/";
  if (!line) return Promise.resolve({ ok: true, output: "", cwd: start, exitCode: 0 });

  const script = `cd "$1" 2>/dev/null; eval "$2"; rc=$?; printf '\\n${MARK}%s\\n' "$PWD"; exit $rc`;
  return new Promise((done) => {
    const child = spawn("bash", ["-c", script, "forge-console", start, line], {
      cwd: start,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" },
    });
    let buf = "";
    let truncated = false;
    const add = (d: Buffer) => {
      if (buf.length < MAX_OUTPUT) buf += d.toString("utf8");
      else truncated = true;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      // Kill the whole process group so grandchildren (e.g. `sleep`) release the pipes.
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, output: e.message, cwd: start, exitCode: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const at = buf.lastIndexOf(`\n${MARK}`);
      const newCwd = at >= 0 ? buf.slice(at + 1 + MARK.length).split("\n")[0] : start;
      let output = at >= 0 ? buf.slice(0, at) : buf;
      if (signal === "SIGKILL") output += `\n(stopped after ${timeoutMs / 1000}s)`;
      done({ ok: code === 0, output: output.replace(/\s+$/, ""), cwd: newCwd || start, exitCode: code, truncated: truncated || undefined });
    });
  });
}

/**
 * The console runs arbitrary commands, so it refuses anything a hostile web page could trigger from the user's browser:
 * a custom header forces a CORS preflight (which this server never grants), and a cross-site Origin is rejected outright.
 */
export function consoleRequestAllowed(req: IncomingMessage): boolean {
  if (req.headers["x-forge-console"] !== "1") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
