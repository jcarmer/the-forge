import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** One tappable suggestion. Tapping it replaces the whole input line with `line`. */
export interface Chip {
  label: string;
  line: string;
  kind: "dir" | "path" | "flag" | "idea" | "start" | "history";
  hint?: string;
}

export interface SuggestRequest {
  cwd: string;
  line: string;
  history?: string[];
}

const PATH_COMMANDS = new Set(["ls", "cat", "less", "more", "head", "tail", "code", "vim", "nano", "rm", "cp", "mv", "mkdir", "touch", "du", "wc", "file", "stat", "tree", "bat", "open"]);
const MAX_ENTRIES = 40;

/**
 * Fixes shorthand a thumb-typist produces: `cd..` -> `cd ..`, `cd...` -> `cd ../..`, `cd....` -> `cd ../../..`.
 * Anything else is returned unchanged.
 */
export function normalizeLine(line: string): string {
  const m = /^(\s*)cd(\.{2,})(\/?)(.*)$/.exec(line);
  if (!m) return line;
  const ups = Array.from({ length: m[2].length - 1 }, () => "..").join("/");
  const rest = m[4] ? `/${m[4]}` : "";
  return `${m[1]}cd ${ups}${rest}`;
}

/** Splits at the last unquoted space: the text before it and the token being typed. */
function splitLast(line: string): { head: string; token: string } {
  const i = line.lastIndexOf(" ");
  return i < 0 ? { head: "", token: line } : { head: line.slice(0, i + 1), token: line.slice(i + 1) };
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function quote(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

interface Entry {
  name: string;
  dir: boolean;
}

export function listDir(dir: string): Entry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((d) => {
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try {
            isDir = statSync(join(dir, d.name)).isDirectory();
          } catch {
            /* broken link: treat as file */
          }
        }
        return { name: d.name, dir: isDir };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Path completions for the token being typed, resolved against cwd. */
export function pathChips(cwd: string, line: string, dirsOnly: boolean): Chip[] {
  const { head, token } = splitLast(line);
  const slash = token.lastIndexOf("/");
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
  const prefix = slash >= 0 ? token.slice(slash + 1) : token;
  const base = resolve(cwd, expandHome(dirPart || "."));
  const showHidden = prefix.startsWith(".");
  const chips: Chip[] = [];

  // Going up is the most common phone gesture, so it always leads.
  if (dirsOnly && !token.startsWith("-")) {
    const up = base === "/" ? null : dirname(base);
    if (up && (prefix === "" || "..".startsWith(prefix))) chips.push({ label: "..", line: `${head}${dirPart}../`, kind: "dir", hint: basename(up) || "/" });
  }

  for (const e of listDir(base)) {
    if (!showHidden && e.name.startsWith(".")) continue;
    if (!e.name.startsWith(prefix)) continue;
    if (dirsOnly && !e.dir) continue;
    chips.push({
      label: e.dir ? `${e.name}/` : e.name,
      line: `${head}${dirPart}${quote(e.name)}${e.dir ? "/" : ""}`,
      kind: e.dir ? "dir" : "path",
    });
    if (chips.length >= MAX_ENTRIES) break;
  }
  return chips;
}

/** Pulls `-x, --long VALUE   description` rows out of `--help` text. */
export function parseFlags(help: string, max = 40): { flag: string; desc: string }[] {
  const out: { flag: string; desc: string }[] = [];
  const seen = new Set<string>();
  for (const raw of help.split(/\r?\n/)) {
    const m = /^\s{1,12}(?:(-[A-Za-z0-9]),?\s+)?(--[A-Za-z][\w-]*)(?:\[?[ =][\[<A-Za-z_][^\s]*)?(?:\s{2,}(.*))?$/.exec(raw) ?? /^\s{1,12}(-[A-Za-z0-9])(?:\s+[<\[A-Z_][^\s]*)?(?:,\s*(--[A-Za-z][\w-]*))?(?:\s{2,}(.*))?$/.exec(raw);
    if (!m) continue;
    const flag = m[2] ?? m[1];
    if (!flag || seen.has(flag)) continue;
    seen.add(flag);
    out.push({ flag, desc: (m[3] ?? "").trim().slice(0, 100) });
    if (out.length >= max) break;
  }
  return out;
}

const helpCache = new Map<string, Promise<string>>();

/** Runs `<cmd> [sub] --help` with a short timeout. Only plain command names are ever executed. */
export function helpText(cwd: string, words: string[]): Promise<string> {
  const [cmd, sub] = words;
  if (!cmd || !/^[\w.+-]+$/.test(cmd)) return Promise.resolve("");
  const args = sub && /^[a-z][\w-]*$/.test(sub) ? [sub, "--help"] : ["--help"];
  const key = `${cmd} ${args.join(" ")}`;
  let hit = helpCache.get(key);
  if (!hit) {
    hit = new Promise<string>((done) => {
      execFile(cmd, args, { cwd: existsSync(cwd) ? cwd : undefined, timeout: 3000, maxBuffer: 256 * 1024, env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", MANPAGER: "cat" } }, (_e, stdout, stderr) => {
        done(`${stdout}\n${stderr}`.slice(0, 20_000));
      }).stdin?.end();
    });
    helpCache.set(key, hit);
  }
  return hit;
}

function flagChips(line: string, help: string): Chip[] {
  const { token } = splitLast(line);
  const typedFlag = token.startsWith("-") ? token : "";
  const base = typedFlag ? line.slice(0, line.length - token.length) : line.endsWith(" ") ? line : `${line} `;
  return parseFlags(help)
    .filter((f) => !typedFlag || f.flag.startsWith(typedFlag))
    .map((f) => ({ label: f.flag, line: `${base}${f.flag}`, kind: "flag" as const, hint: f.desc || undefined }));
}

/** Deterministic, instant suggestions. No model involved. */
export async function localChips(req: SuggestRequest): Promise<Chip[]> {
  const line = normalizeLine(req.line);
  const trimmed = line.trimStart();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const cmd = words[0] ?? "";
  const endsSpace = /\s$/.test(line);

  if (!trimmed) {
    const starters = ["ls -la", "cd ", "git status", "git log --oneline -10", "pwd", "df -h", "docker ps"];
    const hist = [...new Set(req.history ?? [])].slice(-6).reverse();
    return [
      ...hist.map((h): Chip => ({ label: h, line: h, kind: "history" })),
      ...starters.map((s): Chip => ({ label: s.trim(), line: s, kind: "start" })),
    ];
  }

  if (cmd === "cd") {
    const afterCd = line.replace(/^\s*cd\s*/, "");
    if (words.length <= 2 || (words.length === 2 && !endsSpace)) {
      const chips = pathChips(req.cwd, `cd ${afterCd}`, true);
      if (!afterCd) chips.push({ label: "~", line: "cd ~", kind: "dir", hint: "home" }, { label: "/opt/the-forge", line: "cd /opt/the-forge", kind: "dir" });
      return chips;
    }
    return [];
  }

  // Single word, still typing the command name: leave that to the model/history.
  if (words.length === 1 && !endsSpace) {
    return [...new Set(req.history ?? [])].filter((h) => h.startsWith(trimmed) && h !== trimmed).slice(-6).reverse().map((h): Chip => ({ label: h, line: h, kind: "history" }));
  }

  const { token } = splitLast(line);
  const chips: Chip[] = [];
  const looksPath = token.includes("/") || token.startsWith(".") || token.startsWith("~");
  if (token.startsWith("-") || (endsSpace && !PATH_COMMANDS.has(cmd))) {
    chips.push(...flagChips(line, await helpText(req.cwd, words)));
  }
  if (!token.startsWith("-") && (PATH_COMMANDS.has(cmd) || looksPath)) chips.push(...pathChips(req.cwd, line, false));
  return chips.slice(0, 60);
}

export interface Fetcher {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/**
 * Asks local Ollama for a handful of likely next commands. Output is validated and capped; the model only ever
 * proposes text that lands in the input box, nothing is run until the user presses Run.
 */
export async function ollamaIdeas(
  req: SuggestRequest,
  opts: { model: string; baseUrl?: string; fetchImpl?: Fetcher; timeoutMs?: number; help?: string },
): Promise<{ ok: boolean; chips: Chip[]; detail?: string }> {
  const line = normalizeLine(req.line);
  const entries = listDir(req.cwd).slice(0, 40).map((e) => (e.dir ? `${e.name}/` : e.name));
  const prompt = [
    "You help someone type shell commands on a phone. Suggest up to 6 useful complete commands they may want next.",
    "Rules: bash on Linux; prefer short, safe, read-only commands unless the typed text clearly asks otherwise; never suggest sudo, rm -rf, or anything destructive;",
    "if text is already typed, every suggestion must be a completion or fix of it (correct typos, add helpful flags).",
    "Reply with JSON only: {\"ideas\":[{\"command\":\"<full command line>\",\"why\":\"<under 8 words>\"}]}.",
    "",
    `cwd: ${req.cwd}`,
    `entries: ${entries.join(" ") || "(empty)"}`,
    `recent: ${(req.history ?? []).slice(-5).join(" | ") || "(none)"}`,
    `typed: ${JSON.stringify(line)}`,
    opts.help ? `help excerpt:\n${opts.help.slice(0, 1500)}` : "",
  ].join("\n");

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetcher);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(`${opts.baseUrl ?? "http://127.0.0.1:11434"}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, prompt, stream: false, format: "json", options: { temperature: 0.2, num_predict: 400 } }),
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, chips: [], detail: `Ollama returned HTTP ${res.status}` };
    const body = (await res.json()) as { response?: string };
    return { ok: true, chips: parseIdeas(body.response ?? "") };
  } catch (e) {
    return { ok: false, chips: [], detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const DANGEROUS = /(^|[\s;&|])(sudo|mkfs\w*|dd|shutdown|reboot)\b|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|>\s*\/dev\/sd/;

/** Validates model output into chips; drops anything malformed, multi-line, oversized or obviously destructive. */
export function parseIdeas(raw: string): Chip[] {
  let parsed: { ideas?: { command?: unknown; why?: unknown }[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return [];
  }
  const out: Chip[] = [];
  for (const i of parsed.ideas ?? []) {
    if (typeof i?.command !== "string") continue;
    const command = i.command.trim();
    if (!command || command.length > 200 || /[\r\n]/.test(command) || DANGEROUS.test(command)) continue;
    if (out.some((c) => c.line === command)) continue;
    out.push({ label: command, line: command, kind: "idea", hint: typeof i.why === "string" ? i.why.slice(0, 80) : undefined });
    if (out.length >= 6) break;
  }
  return out;
}
