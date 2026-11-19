#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks output-flooding patterns and tells the agent what to do instead:
//   1. `cat <files>` (anywhere in a compound command) when the files total more than MAX_CAT_BYTES
//   2. recursive `grep`, `find` or `ls -R` with nothing limiting their output
//   3. `sed -n 'A,Bp'` printing more than MAX_SED_LINES lines
//   4. unbounded `rg` (ripgrep) or `head -n N` / `tail -n N` over MAX_HEAD_TAIL_LINES lines
// Exit 2 + stderr is how Claude Code feeds a block reason back to the model. Any other failure exits 0 (fail open).
// Escape hatches: put `# allow-unbounded` in the command, or set FORGE_BASH_GUARD=off.
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MAX_CAT_BYTES = 64 * 1024;

const RECURSIVE_GREP = /(^|[;&|(]\s*)grep\s+(?:[^|;&]*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(\s|$)/;
const OUTPUT_LIMITER = /\|\s*(head|tail|wc)\b|(^|\s)-[a-zA-Z]*[lcq]\b|(^|\s)-m\s*\d+|--max-count|--files-with-matches|--count|--quiet/;
// A `cat <files>` that ends its command segment (so not piped, redirected or a heredoc). Matches anywhere in a compound command.
const CAT_SEGMENT = /(?:^|[;&|(\n])\s*cat\s+([^|;&<>`$()\n]+?)(?=\s*(?:$|[;&\n]))/g;
const SED_RANGE = /(?:^|[;&|(\n])\s*sed\s+(?:-[a-zA-Z]*n[a-zA-Z]*|--quiet|--silent)\s+['"]?(\d+),(\d+|\$)p['"]?/g;
const MAX_SED_LINES = 300;
const FIND_CMD = /(^|[;&|(]\s*)find\s/;
const FIND_LIMITER = /-maxdepth|-quit|-print -quit|\|\s*(head|tail|wc)\b/;
const LS_RECURSIVE = /(^|[;&|(]\s*)ls\s+(?:[^|;&]*\s)?-[a-zA-Z]*R[a-zA-Z]*(\s|$)/;
const UNBOUNDED_RG = /(^|[;&|(]\s*)rg\s/;
const HEAD_TAIL_LINES = /(?:^|[;&|(\n])\s*(?:head|tail)\s+(?:-n\s*|-)?(\d+)\b/g;
export const MAX_HEAD_TAIL_LINES = 200;

function recordBlock(command, cwd, reason, logFile) {
  if (!logFile) return;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), cwd, command: String(command ?? "").slice(0, 240), reason }) + "\n", "utf8");
  } catch {
    // ignore telemetry write errors
  }
}

/** @returns {string | null} a reason to block, or null to allow */
export function checkBashCommand(command, cwd = process.cwd(), env = process.env) {
  if (!command || env.FORGE_BASH_GUARD === "off" || command.includes("# allow-unbounded")) return null;
  const finish = (reason) => {
    if (reason && env?.FORGE_GUARD_LOG) recordBlock(command, cwd, reason, env.FORGE_GUARD_LOG);
    return reason;
  };

  if (RECURSIVE_GREP.test(command) && !OUTPUT_LIMITER.test(command)) {
    return finish("Blocked: recursive grep with unbounded output. Use the Grep tool (it limits results), or add `| head -50`, `-l`, `-c` or `-m N`. If you really need everything, append `# allow-unbounded`.");
  }
  if (UNBOUNDED_RG.test(command) && !OUTPUT_LIMITER.test(command)) {
    return finish("Blocked: `rg` with unbounded output. Use the Grep tool with `head_limit`, or add `-m N`, `-l`, `-c` or `| head -50`. If you really need everything, append `# allow-unbounded`.");
  }
  for (const m of command.matchAll(HEAD_TAIL_LINES)) {
    if (Number(m[1]) > MAX_HEAD_TAIL_LINES) {
      return finish(`Blocked: head/tail of ${m[1]} lines exceeds ${MAX_HEAD_TAIL_LINES}. Use the Read tool with offset/limit (<= 200 lines) or summarize via ollama-helper. Append \`# allow-unbounded\` only if required.`);
    }
  }

  if (FIND_CMD.test(command) && !FIND_LIMITER.test(command)) {
    return finish("Blocked: `find` with no limit. Use the Glob/Grep tools, or add `-maxdepth N` or `| head -50`. If you really need everything, append `# allow-unbounded`.");
  }
  if (LS_RECURSIVE.test(command) && !OUTPUT_LIMITER.test(command)) {
    return finish("Blocked: `ls -R` with no limit. Use the Glob tool, or add `| head -50`. If you really need everything, append `# allow-unbounded`.");
  }

  for (const m of command.matchAll(SED_RANGE)) {
    const end = m[2] === "$" ? Infinity : Number(m[2]);
    if (end - Number(m[1]) > MAX_SED_LINES) {
      return finish(`Blocked: sed prints more than ${MAX_SED_LINES} lines. Use the Read tool with an offset/limit, or a narrower range. If you really need it all, append \`# allow-unbounded\`.`);
    }
  }

  // Every `cat` in the command counts toward one total, so `cat a; cat b; cat c` cannot dodge the limit.
  const cd = /(?:^|[;&|(\n])\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/.exec(command);
  const base = cd ? resolve(cwd, cd[1] ?? cd[2] ?? cd[3]) : cwd;
  let total = 0;
  for (const m of command.matchAll(CAT_SEGMENT)) {
    for (const f of m[1].split(/\s+/).filter((a) => a && !a.startsWith("-"))) {
      try {
        const st = statSync(resolve(base, f.replace(/^["']|["']$/g, "")));
        if (st.isFile()) total += st.size;
      } catch {
        // missing file: let cat report it
      }
    }
  }
  if (total > MAX_CAT_BYTES) {
    return finish(`Blocked: cat of ${Math.round(total / 1024)} KB would flood the conversation. Use the Read tool with an offset/limit, or \`head -n 100 <file>\` / \`grep\` for what you need. If you really need it all, append \`# allow-unbounded\`.`);
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // not valid hook input: fail open
  }
  const cmd = input?.tool_input?.command;
  const cwd = input?.cwd || process.cwd();
  const reason = checkBashCommand(cmd, cwd);
  if (reason) {
    if (!process.env.FORGE_GUARD_LOG) {
      recordBlock(cmd, cwd, reason, "/var/lib/the-forge/bash-guard-blocks.jsonl");
    }
    process.stderr.write(reason + "\n");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch(() => process.exit(0));
}
