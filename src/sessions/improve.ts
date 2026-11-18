import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installClaudeUserConfig } from "../provision/claudeUser.js";
import { buildOverview, loadStories, type Overview } from "./digest.js";
import { clearParseCache, readTelemetryConfig, type SessionSources, type TelemetryConfig } from "./parse.js";
import { clearStoryCache, type SessionStory } from "./story.js";

export type ImprovementKind = "action" | "data-collection";

export interface ImprovementSuggestion {
  id: string;
  kind: ImprovementKind;
  title: string;
  /** Measured observation from the current session window that triggered this suggestion. */
  why: string;
  /** Concrete explanation of what to change or collect and how it corrects or exposes inefficiencies. */
  guidance: string;
  /** Pattern/finding IDs this suggestion addresses. */
  findingIds: string[];
  /** Repo-relative paths in the-forge that enacting this suggestion permanently edits. */
  targetFiles: string[];
  /** Concise diff/preview of the permanent edit to the-forge repo. */
  preview: string;
  /** True when the-forge repo already has this change applied. */
  applied: boolean;
  /** "high" when directly triggered by patterns observed in the current window; "medium" when proactive. */
  priority: "high" | "medium";
  source: "deterministic" | "ollama";
  /** For Ollama-generated custom guidance rules, the markdown bullet to append to ops/claude-user/CLAUDE.md. */
  customRule?: string;
}

export interface TelemetryStats {
  bashGuardBlocks: number;
  recentBlocks: { ts: string; command: string; reason: string }[];
  hookEvents: number;
  antigravitySessions: number;
}

export interface ImprovementReport {
  generatedAt: string;
  days: number;
  sessionsAnalyzed: number;
  summary: string;
  ollamaModel?: string;
  ollamaNote?: string;
  actions: ImprovementSuggestion[];
  dataCollection: ImprovementSuggestion[];
  telemetry: TelemetryStats;
}

export interface EnactOutcome {
  ok: boolean;
  appliedId: string;
  modifiedFiles: string[];
  detail: string;
  report: ImprovementReport;
}

interface Fetcher {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface ImproveOptions {
  repoDir?: string;
  claudeDir?: string;
  stateDir?: string;
  src?: SessionSources;
  stories?: SessionStory[];
  overview?: Overview;
  useOllama?: boolean;
  model?: string;
  baseUrl?: string;
  fetchImpl?: Fetcher;
  timeoutMs?: number;
}

const fmtDur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function writeRepoFile(repoDir: string, relPath: string, content: string): string {
  const full = join(repoDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return relPath;
}

function appendSectionIfMissing(existing: string, heading: string, lines: string[]): string {
  if (existing.includes(heading)) return existing;
  const block = [heading, ...lines].join("\n");
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function renderBashGuard(opts: { strictRgAndHeadTail: boolean; logBlocks: boolean }): string {
  const lines: string[] = [
    "#!/usr/bin/env node",
    "// PreToolUse hook for Bash. Blocks output-flooding patterns and tells the agent what to do instead:",
    "//   1. `cat <files>` (anywhere in a compound command) when the files total more than MAX_CAT_BYTES",
    "//   2. recursive `grep`, `find` or `ls -R` with nothing limiting their output",
    "//   3. `sed -n 'A,Bp'` printing more than MAX_SED_LINES lines",
  ];
  if (opts.strictRgAndHeadTail) {
    lines.push("//   4. unbounded `rg` (ripgrep) or `head -n N` / `tail -n N` over MAX_HEAD_TAIL_LINES lines");
  }
  lines.push(
    "// Exit 2 + stderr is how Claude Code feeds a block reason back to the model. Any other failure exits 0 (fail open).",
    "// Escape hatches: put `# allow-unbounded` in the command, or set FORGE_BASH_GUARD=off.",
    'import { appendFileSync, mkdirSync, statSync } from "node:fs";',
    'import { dirname, resolve } from "node:path";',
    "",
    "export const MAX_CAT_BYTES = 64 * 1024;",
    "",
    "const RECURSIVE_GREP = /(^|[;&|(]\\s*)grep\\s+(?:[^|;&]*\\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(\\s|$)/;",
    "const OUTPUT_LIMITER = /\\|\\s*(head|tail|wc)\\b|(^|\\s)-[a-zA-Z]*[lcq]\\b|(^|\\s)-m\\s*\\d+|--max-count|--files-with-matches|--count|--quiet/;",
    "// A `cat <files>` that ends its command segment (so not piped, redirected or a heredoc). Matches anywhere in a compound command.",
    "const CAT_SEGMENT = /(?:^|[;&|(\\n])\\s*cat\\s+([^|;&<>`$()\\n]+?)(?=\\s*(?:$|[;&\\n]))/g;",
    "const SED_RANGE = /(?:^|[;&|(\\n])\\s*sed\\s+(?:-[a-zA-Z]*n[a-zA-Z]*|--quiet|--silent)\\s+['\"]?(\\d+),(\\d+|\\$)p['\"]?/g;",
    "const MAX_SED_LINES = 300;",
    "const FIND_CMD = /(^|[;&|(]\\s*)find\\s/;",
    "const FIND_LIMITER = /-maxdepth|-quit|-print -quit|\\|\\s*(head|tail|wc)\\b/;",
    "const LS_RECURSIVE = /(^|[;&|(]\\s*)ls\\s+(?:[^|;&]*\\s)?-[a-zA-Z]*R[a-zA-Z]*(\\s|$)/;",
  );
  if (opts.strictRgAndHeadTail) {
    lines.push(
      "const UNBOUNDED_RG = /(^|[;&|(]\\s*)rg\\s/;",
      "const HEAD_TAIL_LINES = /(?:^|[;&|(\\n])\\s*(?:head|tail)\\s+(?:-n\\s*|-)?(\\d+)\\b/g;",
      "export const MAX_HEAD_TAIL_LINES = 200;",
    );
  }
  lines.push(
    "",
    "function recordBlock(command, cwd, reason, logFile) {",
    "  if (!logFile) return;",
    "  try {",
    "    mkdirSync(dirname(logFile), { recursive: true });",
    '    appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), cwd, command: String(command ?? "").slice(0, 240), reason }) + "\\n", "utf8");',
    "  } catch {",
    "    // ignore telemetry write errors",
    "  }",
    "}",
    "",
    "/** @returns {string | null} a reason to block, or null to allow */",
    "export function checkBashCommand(command, cwd = process.cwd(), env = process.env) {",
    '  if (!command || env.FORGE_BASH_GUARD === "off" || command.includes("# allow-unbounded")) return null;',
    "  const finish = (reason) => {",
    opts.logBlocks
      ? "    if (reason && env?.FORGE_GUARD_LOG) recordBlock(command, cwd, reason, env.FORGE_GUARD_LOG);"
      : "    void env;",
    "    return reason;",
    "  };",
    "",
    "  if (RECURSIVE_GREP.test(command) && !OUTPUT_LIMITER.test(command)) {",
    '    return finish("Blocked: recursive grep with unbounded output. Use the Grep tool (it limits results), or add `| head -50`, `-l`, `-c` or `-m N`. If you really need everything, append `# allow-unbounded`.");',
    "  }",
  );
  if (opts.strictRgAndHeadTail) {
    lines.push(
      "  if (UNBOUNDED_RG.test(command) && !OUTPUT_LIMITER.test(command)) {",
      '    return finish("Blocked: `rg` with unbounded output. Use the Grep tool with `head_limit`, or add `-m N`, `-l`, `-c` or `| head -50`. If you really need everything, append `# allow-unbounded`.");',
      "  }",
      "  for (const m of command.matchAll(HEAD_TAIL_LINES)) {",
      "    if (Number(m[1]) > MAX_HEAD_TAIL_LINES) {",
      "      return finish(`Blocked: head/tail of ${m[1]} lines exceeds ${MAX_HEAD_TAIL_LINES}. Use the Read tool with offset/limit (<= 200 lines) or summarize via ollama-helper. Append \\`# allow-unbounded\\` only if required.`);",
      "    }",
      "  }",
    );
  }
  lines.push(
    "",
    "  if (FIND_CMD.test(command) && !FIND_LIMITER.test(command)) {",
    '    return finish("Blocked: `find` with no limit. Use the Glob/Grep tools, or add `-maxdepth N` or `| head -50`. If you really need everything, append `# allow-unbounded`.");',
    "  }",
    "  if (LS_RECURSIVE.test(command) && !OUTPUT_LIMITER.test(command)) {",
    '    return finish("Blocked: `ls -R` with no limit. Use the Glob tool, or add `| head -50`. If you really need everything, append `# allow-unbounded`.");',
    "  }",
    "",
    "  for (const m of command.matchAll(SED_RANGE)) {",
    '    const end = m[2] === "$" ? Infinity : Number(m[2]);',
    "    if (end - Number(m[1]) > MAX_SED_LINES) {",
    "      return finish(`Blocked: sed prints more than ${MAX_SED_LINES} lines. Use the Read tool with an offset/limit, or a narrower range. If you really need it all, append \\`# allow-unbounded\\`.`);",
    "    }",
    "  }",
    "",
    "  // Every `cat` in the command counts toward one total, so `cat a; cat b; cat c` cannot dodge the limit.",
    '  const cd = /(?:^|[;&|(\\n])\\s*cd\\s+(?:"([^"]+)"|\'([^\']+)\'|([^\\s;&|]+))\\s*(?:&&|;)/.exec(command);',
    "  const base = cd ? resolve(cwd, cd[1] ?? cd[2] ?? cd[3]) : cwd;",
    "  let total = 0;",
    "  for (const m of command.matchAll(CAT_SEGMENT)) {",
    '    for (const f of m[1].split(/\\s+/).filter((a) => a && !a.startsWith("-"))) {',
    "      try {",
    '        const st = statSync(resolve(base, f.replace(/^["\']|["\']$/g, "")));',
    "        if (st.isFile()) total += st.size;",
    "      } catch {",
    "        // missing file: let cat report it",
    "      }",
    "    }",
    "  }",
    "  if (total > MAX_CAT_BYTES) {",
    "    return finish(`Blocked: cat of ${Math.round(total / 1024)} KB would flood the conversation. Use the Read tool with an offset/limit, or \\`head -n 100 <file>\\` / \\`grep\\` for what you need. If you really need it all, append \\`# allow-unbounded\\`.`);",
    "  }",
    "  return null;",
    "}",
    "",
    "async function main() {",
    '  let raw = "";',
    "  for await (const chunk of process.stdin) raw += chunk;",
    "  let input;",
    "  try {",
    "    input = JSON.parse(raw);",
    "  } catch {",
    "    return; // not valid hook input: fail open",
    "  }",
    "  const cmd = input?.tool_input?.command;",
    "  const cwd = input?.cwd || process.cwd();",
    "  const reason = checkBashCommand(cmd, cwd);",
    "  if (reason) {",
  );
  if (opts.logBlocks) {
    lines.push(
      "    if (!process.env.FORGE_GUARD_LOG) {",
      '      recordBlock(cmd, cwd, reason, "/var/lib/the-forge/bash-guard-blocks.jsonl");',
      "    }",
    );
  }
  lines.push(
    '    process.stderr.write(reason + "\\n");',
    "    process.exit(2);",
    "  }",
    "}",
    "",
    "if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {",
    "  main().catch(() => process.exit(0));",
    "}",
    "",
  );
  return lines.join("\n");
}

const FAST_EXPLORE_SKILL = `---
name: fast-explore
description: Fast, low-token codebase exploration using ollama-helper and batched parallel Read/Grep calls. Use at the start of any multi-file investigation or search-heavy turn.
---

# fast-explore

## 1. Load local search tools on Step 1
- Call \`ToolSearch\` with query \`select:mcp__ollama-helper__local_code_search_and_scan,mcp__ollama-helper__local_summarize_files\` alongside your initial \`Glob\` or \`Grep\` calls.
- Never chain 5+ single-call steps one after another when independent lookups can run in the same turn.

## 2. Sweep with GPU, verify with bounded Read
- Use \`mcp__ollama-helper__local_code_search_and_scan\` to scan directories or answer broad "where is X handled?" questions without adding raw files to Claude context.
- Use \`mcp__ollama-helper__local_summarize_files\` to digest long files or logs (>200 lines).
- Once you know the exact file and line range, call \`Read\` with \`offset\` and \`limit\` (<= 200 lines) in a single batched step.
`;

const SESSION_TELEMETRY_SCRIPT = `#!/usr/bin/env node
// Records Claude Code PreCompact and PostToolUseFailure hook events to /var/lib/the-forge/session-telemetry.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return;
  try {
    const ev = JSON.parse(raw);
    const logFile = process.env.FORGE_TELEMETRY_LOG || "/var/lib/the-forge/session-telemetry.jsonl";
    mkdirSync(dirname(logFile), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      event: ev.hook_event_name || ev.event || "hook",
      sessionId: ev.session_id || undefined,
      tool: ev.tool_name || undefined,
      trigger: ev.trigger || undefined,
      error: typeof ev.error === "string" ? ev.error.slice(0, 200) : undefined,
    };
    appendFileSync(logFile, JSON.stringify(entry) + "\\n", "utf8");
  } catch {
    // fail open
  }
}

main().catch(() => process.exit(0));
`;

function readTelemetryStats(stateDir: string, stories: SessionStory[]): TelemetryStats {
  const guardFile = join(stateDir, "bash-guard-blocks.jsonl");
  const recentBlocks: { ts: string; command: string; reason: string }[] = [];
  let bashGuardBlocks = 0;
  if (existsSync(guardFile)) {
    for (const line of safeRead(guardFile).split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { ts?: string; command?: string; reason?: string };
        bashGuardBlocks++;
        if (o.command && o.reason) {
          recentBlocks.push({ ts: String(o.ts ?? ""), command: o.command, reason: o.reason });
        }
      } catch {
        // ignore malformed line
      }
    }
  }
  const hookFile = join(stateDir, "session-telemetry.jsonl");
  const hookEvents = existsSync(hookFile)
    ? safeRead(hookFile)
        .split("\n")
        .filter((l) => l.trim().length > 0).length
    : 0;
  const antigravitySessions = stories.filter((s) => s.source === "antigravity-transcript").length;
  return {
    bashGuardBlocks,
    recentBlocks: recentBlocks.slice(-5).reverse(),
    hookEvents,
    antigravitySessions,
  };
}

function updateTelemetryConfig(repoDir: string, patch: Partial<TelemetryConfig>): string {
  const rel = "ops/claude-user/telemetry-config.json";
  const cur = readTelemetryConfig(repoDir);
  const next: TelemetryConfig = { ...cur, ...patch };
  return writeRepoFile(repoDir, rel, JSON.stringify(next, null, 2) + "\n");
}

function buildDeterministicSuggestions(repoDir: string, stories: SessionStory[], o: Overview, telemetry: TelemetryStats): {
  actions: ImprovementSuggestion[];
  dataCollection: ImprovementSuggestion[];
} {
  const claudeMd = safeRead(join(repoDir, "ops/claude-user/CLAUDE.md"));
  const bashGuard = safeRead(join(repoDir, "ops/claude-user/bash-guard.mjs"));
  const fastExploreExists = existsSync(join(repoDir, "ops/claude-user/skills/fast-explore/SKILL.md"));
  const telemetryHookExists = existsSync(join(repoDir, "ops/claude-user/session-telemetry.mjs"));
  const telCfg = readTelemetryConfig(repoDir);

  const byId = new Map(o.findings.map((f) => [f.id, f]));
  const totalErrors = stories.reduce((n, s) => n + s.calls.filter((c) => c.isError).length, 0);
  const ollamaUnused = o.availableNeverUsed.mcpServers.includes("ollama-helper");

  const actions: ImprovementSuggestion[] = [
    {
      id: "tighten-bash-guard",
      kind: "action",
      title: "Block unbounded rg and large head/tail ranges in bash-guard.mjs",
      why: byId.has("bash-for-search")
        ? `Detected in ${byId.get("bash-for-search")!.sessions} conversation(s): ${byId.get("bash-for-search")!.detail}`
        : "Agents can bypass Read/Grep by running unbounded `rg` or `head -n 500` in Bash, flooding context.",
      guidance:
        "Extends `ops/claude-user/bash-guard.mjs` to block unbounded `rg` (ripgrep) and `head`/`tail` commands over 200 lines, and adds a rule in `ops/claude-user/CLAUDE.md` directing agents to use bounded `Read` and `Grep`.",
      findingIds: ["bash-for-search", "big-tool-results"],
      targetFiles: ["ops/claude-user/bash-guard.mjs", "ops/claude-user/CLAUDE.md"],
      preview: [
        "// ops/claude-user/bash-guard.mjs",
        "+ const UNBOUNDED_RG = /(^|[;&|(]\\s*)rg\\s/;",
        "+ export const MAX_HEAD_TAIL_LINES = 200;",
        "+ // Blocks unbounded rg and head/tail > 200 lines with guidance to use Read/Grep",
      ].join("\n"),
      applied: bashGuard.includes("MAX_HEAD_TAIL_LINES") && bashGuard.includes("UNBOUNDED_RG"),
      priority: byId.has("bash-for-search") || byId.has("big-tool-results") ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "enforce-batch-lookups",
      kind: "action",
      title: "Install fast-explore skill & require first-turn ToolSearch + batched lookups",
      why:
        byId.has("serial-exploration") || byId.has("no-delegation")
          ? `Serial lookup chains in ${byId.get("serial-exploration")?.sessions ?? 0} session(s) and un-delegated search in ${byId.get("no-delegation")?.sessions ?? 0} session(s)${ollamaUnused ? "; ollama-helper was available but never called" : ""}.`
          : ollamaUnused
            ? "`ollama-helper` MCP was advertised in session init but called 0 times in this window."
            : "Keeps broad codebase exploration out of the paid model's context window.",
      guidance:
        "Creates `ops/claude-user/skills/fast-explore/SKILL.md` (and installs it to `/root/.claude/skills/fast-explore`) plus adds a rule in `ops/claude-user/CLAUDE.md` to load `ollama-helper` via `ToolSearch` on step 1 and batch independent `Read`/`Grep` calls.",
      findingIds: ["serial-exploration", "no-delegation"],
      targetFiles: ["ops/claude-user/skills/fast-explore/SKILL.md", "ops/claude-user/CLAUDE.md"],
      preview: [
        "# ops/claude-user/skills/fast-explore/SKILL.md",
        "+ Load ollama-helper via ToolSearch on step 1 and batch all known Read/Grep calls into a single message.",
        "# ops/claude-user/CLAUDE.md",
        "+ - On turn 1 of any multi-file search, load `ollama-helper` with `ToolSearch` alongside your first batched lookups (see `fast-explore` skill).",
      ].join("\n"),
      applied: fastExploreExists && claudeMd.includes("fast-explore"),
      priority: byId.has("serial-exploration") || byId.has("no-delegation") || ollamaUnused ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "cap-big-tool-results",
      kind: "action",
      title: "Add strict Read/Grep output bounds & local summarization rules to CLAUDE.md",
      why: byId.has("big-tool-results")
        ? `Detected in ${byId.get("big-tool-results")!.sessions} conversation(s): ${byId.get("big-tool-results")!.detail}`
        : `Total fresh tokens in window: ${fmtTok(o.freshTokens)} across ${o.calls} calls.`,
      guidance:
        "Adds an `## Output & context bounds` section to `ops/claude-user/CLAUDE.md` requiring `limit <= 200` on unfamiliar `Read` calls, `head_limit <= 50` on `Grep`, and `local_summarize_files` for large files or logs.",
      findingIds: ["big-tool-results"],
      targetFiles: ["ops/claude-user/CLAUDE.md"],
      preview: [
        "## Output & context bounds",
        "- Always pass `limit` (<= 200 lines) and `offset` to `Read` when inspecting unfamiliar files.",
        "- Always pass `head_limit` (<= 50) to `Grep` so broad matches never dump thousands of lines.",
        "- Summarize files or logs over 200 lines with `mcp__ollama-helper__local_summarize_files`.",
      ].join("\n"),
      applied: claudeMd.includes("## Output & context bounds"),
      priority: byId.has("big-tool-results") ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "context-hygiene-rules",
      kind: "action",
      title: "Add anti-reread, early compaction, and break-hygiene rules to CLAUDE.md",
      why:
        byId.has("context-bloat") || byId.has("cache-rebuild") || byId.has("repeat-reads")
          ? `Triggered by ${[
              byId.has("context-bloat") ? `context bloat (${byId.get("context-bloat")!.sessions}x)` : "",
              byId.has("cache-rebuild") ? `cache rebuilds (${byId.get("cache-rebuild")!.sessions}x)` : "",
              byId.has("repeat-reads") ? `repeated file reads (${byId.get("repeat-reads")!.sessions}x)` : "",
            ]
              .filter(Boolean)
              .join(", ")}.`
          : "Prevents context growth above 200k tokens and redundant file reads.",
      guidance:
        "Adds `## Context hygiene & cache discipline` to `ops/claude-user/CLAUDE.md` to stop re-reading unchanged files, compact before 200k tokens, and isolate multi-phase tasks in sub-agents.",
      findingIds: ["context-bloat", "cache-rebuild", "repeat-reads"],
      targetFiles: ["ops/claude-user/CLAUDE.md"],
      preview: [
        "## Context hygiene & cache discipline",
        "- Never re-read a file already in context unless an external command modified it; after `Edit`, read only the changed line range.",
        "- Compact context (`/compact`) or delegate the next phase via `forge-orchestrate` before context exceeds ~200k tokens.",
      ].join("\n"),
      applied: claudeMd.includes("## Context hygiene & cache discipline"),
      priority: byId.has("context-bloat") || byId.has("cache-rebuild") || byId.has("repeat-reads") ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "background-slow-commands",
      kind: "action",
      title: "Add background execution & parallel verification rules to CLAUDE.md",
      why: byId.has("slow-blocking")
        ? `Detected in ${byId.get("slow-blocking")!.sessions} conversation(s): ${byId.get("slow-blocking")!.detail}`
        : `Tools ran for ${fmtDur(o.toolMs)} across ${o.sessions} conversation(s) with ${fmtDur(o.parallel.savedMs)} parallel overlap.`,
      guidance:
        "Adds `## Long-running commands & parallel checks` to `ops/claude-user/CLAUDE.md` so builds/tests >30s use `run_in_background: true` and independent checks run in parallel.",
      findingIds: ["slow-blocking"],
      targetFiles: ["ops/claude-user/CLAUDE.md"],
      preview: [
        "## Long-running commands & parallel checks",
        "- Run builds, full test suites, and long commands (>30s) with `run_in_background: true` when other work can proceed.",
        "- Issue independent verification steps (`typecheck`, `test`, `lint`) in parallel in one message.",
      ].join("\n"),
      applied: claudeMd.includes("## Long-running commands & parallel checks"),
      priority: byId.has("slow-blocking") ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "model-tier-routing",
      kind: "action",
      title: "Add model & reasoning-effort tiering rules to CLAUDE.md",
      why:
        byId.has("model-bound") || byId.has("light-turn-on-opus")
          ? `Model thinking/writing accounted for ${fmtDur(o.modelMs)} of ${fmtDur(o.activeMs)} active time${byId.has("light-turn-on-opus") ? ", including short read-only turns on Opus" : ""}.`
          : `Model generation took ${fmtDur(o.modelMs)} (${o.activeMs > 0 ? Math.round((o.modelMs / o.activeMs) * 100) : 0}% of active time).`,
      guidance:
        "Adds `## Model & effort tiering` to `ops/claude-user/CLAUDE.md` to route quick lookups/boilerplate to `ollama-helper` or Flash/Sonnet and reserve Opus/high effort for complex architecture or debugging.",
      findingIds: ["model-bound", "light-turn-on-opus"],
      targetFiles: ["ops/claude-user/CLAUDE.md"],
      preview: [
        "## Model & effort tiering",
        "- Route quick read-only questions to `mcp__ollama-helper__ask_local_helper` or Sonnet/Flash instead of Opus.",
        "- Use medium/low reasoning effort for routine edits; reserve high effort for complex multi-file debugging.",
      ].join("\n"),
      applied: claudeMd.includes("## Model & effort tiering"),
      priority: byId.has("model-bound") || byId.has("light-turn-on-opus") ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "reduce-tool-errors",
      kind: "action",
      title: "Add tool precondition checks & retry caps to CLAUDE.md",
      why:
        byId.has("tool-errors") || totalErrors > 0
          ? `${totalErrors} tool call(s) failed in this window${byId.has("tool-errors") ? ` (${byId.get("tool-errors")!.sessions} conversation(s) flagged with 5+ errors)` : ""}.`
          : "Prevents wasted model turns from repeated failing tool or MCP calls.",
      guidance:
        "Adds `## Tool precondition & retry rules` to `ops/claude-user/CLAUDE.md` requiring `preview_status` before `preview_open`, script verification before `Bash`, and a 2-error retry cap.",
      findingIds: ["tool-errors"],
      targetFiles: ["ops/claude-user/CLAUDE.md"],
      preview: [
        "## Tool precondition & retry rules",
        "- Call `preview_status` before `preview_open` and stop after 2 failed preview attempts on a step.",
        "- Never retry a failed Bash or MCP call with identical arguments; inspect the error first.",
      ].join("\n"),
      applied: claudeMd.includes("## Tool precondition & retry rules"),
      priority: byId.has("tool-errors") || totalErrors >= 5 ? "high" : "medium",
      source: "deterministic",
    },
  ];

  const dataCollection: ImprovementSuggestion[] = [
    {
      id: "collect-bash-guard-blocks",
      kind: "data-collection",
      title: "Log blocked Bash commands from bash-guard.mjs to audit JSONL",
      why:
        byId.has("bash-for-search") || telemetry.bashGuardBlocks > 0
          ? `Shell search patterns were detected (${byId.get("bash-for-search")?.sessions ?? 0} session(s)), and ${telemetry.bashGuardBlocks} guard block(s) are currently logged.`
          : "Currently, when `bash-guard.mjs` blocks a command, no persistent counter or command log is recorded for session analysis.",
      guidance:
        "Updates `ops/claude-user/bash-guard.mjs` and `ops/claude-user/telemetry-config.json` in `the-forge` repo so every blocked command is appended to `/var/lib/the-forge/bash-guard-blocks.jsonl`, letting the Sessions view show which commands agents repeatedly try to run.",
      findingIds: ["bash-for-search"],
      targetFiles: ["ops/claude-user/bash-guard.mjs", "ops/claude-user/telemetry-config.json"],
      preview: [
        "// ops/claude-user/bash-guard.mjs",
        '+ const logFile = process.env.FORGE_GUARD_LOG || "/var/lib/the-forge/bash-guard-blocks.jsonl";',
        "+ appendFileSync(logFile, JSON.stringify({ ts, cwd, command, reason }) + \"\\n\");",
      ].join("\n"),
      applied: Boolean(telCfg.logBashGuardBlocks) && bashGuard.includes("bash-guard-blocks.jsonl"),
      priority: byId.has("bash-for-search") ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "collect-tool-error-details",
      kind: "data-collection",
      title: "Capture tool error message snippets in session stories",
      why:
        totalErrors > 0
          ? `${totalErrors} tool call(s) returned errors in this window, but without error snippet collection only the tool name is shown.`
          : "When tool or MCP calls fail, knowing the failure message (e.g. hook block vs missing file vs unsupported browser call) reveals the root cause.",
      guidance:
        "Enables `captureToolErrorSnippets` in `ops/claude-user/telemetry-config.json` so `src/sessions/story.ts` extracts a 140-character error snippet from failed `tool_result` records and displays it in `Many failed tool calls` evidence.",
      findingIds: ["tool-errors"],
      targetFiles: ["ops/claude-user/telemetry-config.json"],
      preview: [
        "// ops/claude-user/telemetry-config.json",
        '+ { "captureToolErrorSnippets": true }',
      ].join("\n"),
      applied: Boolean(telCfg.captureToolErrorSnippets),
      priority: totalErrors > 0 ? "high" : "medium",
      source: "deterministic",
    },
    {
      id: "collect-antigravity-sessions",
      kind: "data-collection",
      title: "Collect Antigravity ACP session transcripts & token usage",
      why:
        telemetry.antigravitySessions > 0
          ? `Collecting ${telemetry.antigravitySessions} Antigravity ACP conversation(s) in this window.`
          : "Antigravity ACP writes per-step token and tool-call logs (`transcript.jsonl`) that are not included in Sessions by default.",
      guidance:
        "Enables `includeAntigravityTranscripts` in `ops/claude-user/telemetry-config.json` so `src/sessions/parse.ts` and `src/sessions/story.ts` discover and analyze Antigravity ACP `transcript.jsonl` logs alongside Claude sessions.",
      findingIds: [],
      targetFiles: ["ops/claude-user/telemetry-config.json"],
      preview: [
        "// ops/claude-user/telemetry-config.json",
        '+ { "includeAntigravityTranscripts": true }',
      ].join("\n"),
      applied: Boolean(telCfg.includeAntigravityTranscripts),
      priority: "high",
      source: "deterministic",
    },
    {
      id: "collect-hook-and-compact-telemetry",
      kind: "data-collection",
      title: "Record PreCompact, PostToolUseFailure & session effort settings",
      why:
        byId.has("context-bloat") || byId.has("model-bound")
          ? `Context bloat or model-bound turns were observed; tracking compaction triggers and session effort levels helps pinpoint why steps are slow or costly.`
          : "Captures session launch `effort`/`permissionMode` from `query.open` and installs a Claude hook for `PreCompact` and `PostToolUseFailure` events.",
      guidance:
        "Creates `ops/claude-user/session-telemetry.mjs`, registers it in `/root/.claude/settings.json` via `installClaudeUserConfig()`, and enables `captureInitSettings` in `ops/claude-user/telemetry-config.json`.",
      findingIds: ["context-bloat", "model-bound", "light-turn-on-opus"],
      targetFiles: ["ops/claude-user/session-telemetry.mjs", "ops/claude-user/telemetry-config.json"],
      preview: [
        "// ops/claude-user/session-telemetry.mjs",
        "+ Logs PreCompact and PostToolUseFailure events to /var/lib/the-forge/session-telemetry.jsonl",
        "// ops/claude-user/telemetry-config.json",
        '+ { "captureInitSettings": true, "enableTelemetryHook": true }',
      ].join("\n"),
      applied: Boolean(telCfg.captureInitSettings && telCfg.enableTelemetryHook) && telemetryHookExists,
      priority: byId.has("context-bloat") || byId.has("model-bound") ? "high" : "medium",
      source: "deterministic",
    },
  ];

  const rank = (a: ImprovementSuggestion, b: ImprovementSuggestion) => {
    if (a.applied !== b.applied) return a.applied ? 1 : -1;
    if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
    return 0;
  };

  return {
    actions: actions.sort(rank),
    dataCollection: dataCollection.sort(rank),
  };
}

function sanitizeCustomRule(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^@+/, ""))
    .filter(Boolean)
    .join(" ")
    .slice(0, 360);
}

async function queryOllamaForImprovements(
  o: Overview,
  claudeMd: string,
  opts: ImproveOptions,
): Promise<{ note?: string; customActions: ImprovementSuggestion[] }> {
  if (opts.useOllama === false || !opts.model) return { customActions: [] };
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetcher);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45_000);
  const prompt = [
    "You are the self-improvement advisor for The Forge (an AI coding agent sandbox).",
    "Given the measured workflow summary and current CLAUDE.md rules below, reply with JSON only:",
    '{"summary":"<1-2 sentence diagnosis of the main inefficiency>","rule":{"title":"<short title>","why":"<measured reason>","bullet":"<- single markdown rule bullet to add to CLAUDE.md>"}}',
    "",
    `Window: ${o.days < 1 ? `${Math.round(o.days * 24)}h` : `${o.days}d`}, ${o.sessions} conversations, ${o.turns} turns, ${o.calls} calls, cost $${o.costUsd.toFixed(2)}, active ${fmtDur(o.activeMs)} (model ${fmtDur(o.modelMs)}, tools ${fmtDur(o.toolMs)}).`,
    `Findings: ${o.findings.map((f) => `${f.id} (${f.sessions}x): ${f.title}`).join("; ") || "none"}`,
    `Unused MCP: ${o.availableNeverUsed.mcpServers.join(", ") || "none"}`,
    `Current CLAUDE.md:\n${claudeMd.slice(0, 1500)}`,
  ].join("\n");

  try {
    const res = await fetchImpl(`${opts.baseUrl ?? "http://127.0.0.1:11434"}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, prompt, stream: false, format: "json", options: { temperature: 0 } }),
      signal: ctl.signal,
    });
    if (!res.ok) return { customActions: [] };
    const body = (await res.json()) as { response?: string };
    const parsed = JSON.parse(body.response ?? "{}") as {
      summary?: unknown;
      rule?: { title?: unknown; why?: unknown; bullet?: unknown };
    };
    const note = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim().slice(0, 400) : undefined;
    const customActions: ImprovementSuggestion[] = [];
    if (parsed.rule && typeof parsed.rule.title === "string" && typeof parsed.rule.bullet === "string") {
      const cleanBullet = sanitizeCustomRule(parsed.rule.bullet);
      const bulletLine = cleanBullet.startsWith("- ") ? cleanBullet : `- ${cleanBullet}`;
      if (cleanBullet.length >= 10) {
        const already = claudeMd.includes(cleanBullet);
        customActions.push({
          id: "custom-ollama-rule",
          kind: "action",
          title: parsed.rule.title.slice(0, 100),
          why: typeof parsed.rule.why === "string" && parsed.rule.why.trim() ? parsed.rule.why.slice(0, 240) : "Suggested by local Ollama model from this window's digest.",
          guidance: `Appends this rule to \`ops/claude-user/CLAUDE.md\` under \`## Custom self-improvement rules\`.`,
          findingIds: [],
          targetFiles: ["ops/claude-user/CLAUDE.md"],
          preview: `## Custom self-improvement rules\n${bulletLine}`,
          applied: already,
          priority: "medium",
          source: "ollama",
          customRule: bulletLine,
        });
      }
    }
    return { note, customActions };
  } catch {
    return { customActions: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateImprovements(days: number, opts: ImproveOptions = {}): Promise<ImprovementReport> {
  const repoDir = opts.repoDir ?? "/opt/the-forge";
  const stateDir = opts.stateDir ?? "/var/lib/the-forge";
  const stories = opts.stories ?? loadStories(days, { src: opts.src, repoDir });
  const overview = opts.overview ?? buildOverview(stories, days);
  const telemetry = readTelemetryStats(stateDir, stories);
  const { actions, dataCollection } = buildDeterministicSuggestions(repoDir, stories, overview, telemetry);

  const claudeMd = safeRead(join(repoDir, "ops/claude-user/CLAUDE.md"));
  const ollama = await queryOllamaForImprovements(overview, claudeMd, opts);
  for (const ca of ollama.customActions) {
    if (!actions.some((a) => a.id === ca.id)) actions.push(ca);
  }

  const windowLabel = days < 1 ? `${Math.round(days * 24)}h` : `${days}d`;
  const suggestCount = overview.findings.filter((f) => f.severity === "suggest").length;
  const openActions = actions.filter((a) => !a.applied).length;
  const openData = dataCollection.filter((d) => !d.applied).length;
  const baseSummary =
    overview.sessions === 0
      ? `No conversations recorded in the last ${windowLabel}. You can still enact proactive guard rules or enable additional data collection below.`
      : `Analyzed ${overview.sessions} conversation(s) (${overview.turns} turns, ${overview.calls} tool calls, $${overview.costUsd.toFixed(2)}) over the last ${windowLabel}: ${suggestCount} inefficiency pattern(s) detected, ${openActions} action(s) and ${openData} data-collection upgrade(s) ready to enact in the-forge.`;

  return {
    generatedAt: new Date().toISOString(),
    days,
    sessionsAnalyzed: overview.sessions,
    summary: baseSummary,
    ollamaModel: ollama.note ? opts.model : undefined,
    ollamaNote: ollama.note,
    actions,
    dataCollection,
    telemetry,
  };
}

export async function enactImprovement(
  req: { id: string; days?: number; customRule?: string },
  opts: ImproveOptions = {},
): Promise<EnactOutcome> {
  const repoDir = opts.repoDir ?? "/opt/the-forge";
  const claudeDir = opts.claudeDir ?? "/root/.claude";
  const days = req.days ?? 7;
  const modifiedFiles: string[] = [];

  const claudeMdRel = "ops/claude-user/CLAUDE.md";
  const bashGuardRel = "ops/claude-user/bash-guard.mjs";
  const curClaudeMd = safeRead(join(repoDir, claudeMdRel));
  const curBashGuard = safeRead(join(repoDir, bashGuardRel));
  const hasStrictGuard = curBashGuard.includes("MAX_HEAD_TAIL_LINES") && curBashGuard.includes("UNBOUNDED_RG");
  const hasLogBlocks = curBashGuard.includes("bash-guard-blocks.jsonl");

  switch (req.id) {
    case "tighten-bash-guard": {
      modifiedFiles.push(writeRepoFile(repoDir, bashGuardRel, renderBashGuard({ strictRgAndHeadTail: true, logBlocks: hasLogBlocks })));
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Shell read & search guardrails", [
        "- Never run unbounded `rg`, `grep -r`, `find`, or `head`/`tail` over 200 lines in Bash; use `Grep` (with `head_limit`) and `Read` (with `offset`/`limit`).",
      ]);
      if (updatedMd !== curClaudeMd) modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "enforce-batch-lookups": {
      modifiedFiles.push(writeRepoFile(repoDir, "ops/claude-user/skills/fast-explore/SKILL.md", FAST_EXPLORE_SKILL));
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Fast exploration (`fast-explore` skill)", [
        "- On turn 1 of any multi-file investigation, call `ToolSearch` (`select:mcp__ollama-helper__local_code_search_and_scan,mcp__ollama-helper__local_summarize_files`) alongside your initial batched `Read`/`Grep`/`Glob` calls.",
        "- Use `fast-explore` to sweep directories with `ollama-helper` and batch follow-up file reads into a single step.",
      ]);
      if (updatedMd !== curClaudeMd) modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "cap-big-tool-results": {
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Output & context bounds", [
        "- Always pass `limit` (<= 200 lines) and `offset` to `Read` when inspecting unfamiliar files.",
        "- Always pass `head_limit` (<= 50) to `Grep` so broad matches never dump thousands of lines into context.",
        "- Summarize files or logs over 200 lines with `mcp__ollama-helper__local_summarize_files` instead of reading them raw.",
      ]);
      modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "context-hygiene-rules": {
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Context hygiene & cache discipline", [
        "- Do not re-read a file that is already in context unless an external command modified it; after `Edit`, read only the changed line range if needed.",
        "- Compact context (`/compact`) or delegate the next phase to an isolated sub-agent (`forge-orchestrate`) before context exceeds ~200k tokens or before a long break.",
      ]);
      modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "background-slow-commands": {
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Long-running commands & parallel checks", [
        "- Run builds, full test suites, and commands expected to take >30s with `run_in_background: true` when other edits or independent checks can proceed concurrently.",
        "- Issue independent verification commands (`typecheck`, `test`, `lint`) as parallel tool calls in a single assistant message.",
      ]);
      modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "model-tier-routing": {
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Model & effort tiering", [
        "- Offload quick read-only questions and boilerplate drafts to `ollama-helper` (`ask_local_helper`, `local_draft_code`).",
        "- Use Sonnet or Flash with medium effort for standard implementation turns, and reserve Opus / high effort for cross-cutting architecture or subtle bugs.",
      ]);
      modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "reduce-tool-errors": {
      const updatedMd = appendSectionIfMissing(curClaudeMd, "## Tool precondition & retry rules", [
        "- Before calling browser preview tools, check `preview_status` first; if two preview calls fail on one step, stop and switch approaches.",
        "- Never retry a failing Bash or MCP tool call with identical arguments; inspect the error message and fix the command or path first.",
      ]);
      modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    case "collect-bash-guard-blocks": {
      modifiedFiles.push(writeRepoFile(repoDir, bashGuardRel, renderBashGuard({ strictRgAndHeadTail: hasStrictGuard, logBlocks: true })));
      modifiedFiles.push(updateTelemetryConfig(repoDir, { logBashGuardBlocks: true }));
      break;
    }
    case "collect-tool-error-details": {
      modifiedFiles.push(updateTelemetryConfig(repoDir, { captureToolErrorSnippets: true, captureInitSettings: true }));
      break;
    }
    case "collect-antigravity-sessions": {
      modifiedFiles.push(updateTelemetryConfig(repoDir, { includeAntigravityTranscripts: true }));
      break;
    }
    case "collect-hook-and-compact-telemetry": {
      modifiedFiles.push(writeRepoFile(repoDir, "ops/claude-user/session-telemetry.mjs", SESSION_TELEMETRY_SCRIPT));
      modifiedFiles.push(updateTelemetryConfig(repoDir, { captureInitSettings: true, enableTelemetryHook: true }));
      break;
    }
    case "custom-ollama-rule": {
      const clean = sanitizeCustomRule(req.customRule ?? "");
      if (!clean) throw new Error("customRule is required for custom-ollama-rule");
      const bullet = clean.startsWith("- ") ? clean : `- ${clean}`;
      let updatedMd = curClaudeMd;
      if (!updatedMd.includes(bullet)) {
        if (updatedMd.includes("## Custom self-improvement rules")) {
          updatedMd = `${updatedMd.trimEnd()}\n${bullet}\n`;
        } else {
          updatedMd = appendSectionIfMissing(updatedMd, "## Custom self-improvement rules", [bullet]);
        }
      }
      modifiedFiles.push(writeRepoFile(repoDir, claudeMdRel, updatedMd));
      break;
    }
    default:
      throw new Error(`Unknown improvement id: ${req.id}`);
  }

  installClaudeUserConfig({ repoDir, claudeDir });
  clearParseCache();
  clearStoryCache();

  const report = await generateImprovements(days, { ...opts, repoDir, claudeDir, useOllama: false });
  return {
    ok: true,
    appliedId: req.id,
    modifiedFiles: [...new Set(modifiedFiles)],
    detail: `Updated ${[...new Set(modifiedFiles)].join(", ")} in ${repoDir} and synced Claude user config.`,
    report,
  };
}
