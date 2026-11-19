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

export interface RunOptions {
  signal?: AbortSignal;
  cols?: number;
}

// Strips CSI, OSC, and stray single-char ANSI escape sequences so output stays readable on mobile.
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function killGroup(pid: number | undefined, fallback: () => void) {
  if (!pid) {
    fallback();
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    fallback();
  }
}

/**
 * Runs one command line in `cwd` and reports the directory the shell ended in, so `cd` sticks between calls.
 * Stdin is closed (no interactive programs) and the run is killed after `timeoutMs` or when `opts.signal` aborts.
 */
export function runCommand(cwd: string, rawLine: string, timeoutMs = 30_000, opts?: RunOptions): Promise<RunResult> {
  const line = normalizeLine(rawLine).trim();
  const start = existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : "/";
  if (!line) return Promise.resolve({ ok: true, output: "", cwd: start, exitCode: 0 });
  if (opts?.signal?.aborted) {
    return Promise.resolve({ ok: false, output: "(cancelled)", cwd: start, exitCode: null });
  }

  const cols = opts?.cols && Number.isFinite(opts.cols) ? Math.max(40, Math.min(200, Math.round(opts.cols))) : 80;
  const script = `cd "$1" 2>/dev/null; eval "$2"; rc=$?; printf '\\n${MARK}%s\\n' "$PWD"; exit $rc`;
  return new Promise((done) => {
    const child = spawn("bash", ["-c", script, "forge-console", start, line], {
      cwd: start,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", COLUMNS: String(cols) },
    });
    let buf = "";
    let truncated = false;
    let cancelled = false;
    let timedOut = false;
    const add = (d: Buffer) => {
      if (buf.length < MAX_OUTPUT) buf += d.toString("utf8");
      else truncated = true;
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);

    const onAbort = () => {
      cancelled = true;
      killGroup(child.pid, () => child.kill("SIGKILL"));
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group so grandchildren (e.g. `sleep`) release the pipes.
      killGroup(child.pid, () => child.kill("SIGKILL"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    };

    child.on("error", (e) => {
      cleanup();
      done({ ok: false, output: e.message, cwd: start, exitCode: null });
    });
    child.on("close", (code, signal) => {
      cleanup();
      const at = buf.lastIndexOf(`\n${MARK}`);
      const newCwd = at >= 0 ? buf.slice(at + 1 + MARK.length).split("\n")[0] : start;
      let output = stripAnsi(at >= 0 ? buf.slice(0, at) : buf);
      if (cancelled) output += `${output ? "\n" : ""}(cancelled)`;
      else if (timedOut || signal === "SIGKILL") output += `${output ? "\n" : ""}(stopped after ${timeoutMs / 1000}s)`;
      done({
        ok: !cancelled && !timedOut && code === 0,
        output: output.replace(/\s+$/, ""),
        cwd: newCwd || start,
        exitCode: cancelled ? null : code,
        truncated: truncated || undefined,
      });
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
