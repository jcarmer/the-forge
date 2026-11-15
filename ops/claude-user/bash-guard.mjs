#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks two output-flooding patterns and tells the agent what to do instead:
//   1. `cat <files>` when the files total more than MAX_CAT_BYTES
//   2. recursive `grep` with nothing limiting its output
// Exit 2 + stderr is how Claude Code feeds a block reason back to the model. Any other failure exits 0 (fail open).
// Escape hatches: put `# allow-unbounded` in the command, or set FORGE_BASH_GUARD=off.
import { statSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_CAT_BYTES = 64 * 1024;

const RECURSIVE_GREP = /(^|[;&|(]\s*)grep\s+(?:[^|;&]*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(\s|$)/;
const OUTPUT_LIMITER = /\|\s*(head|tail|wc)\b|(^|\s)-[a-zA-Z]*[lcq]\b|(^|\s)-m\s*\d+|--max-count|--files-with-matches|--count|--quiet/;
const SIMPLE_CAT = /^\s*cat\s+([^|;&<>`$()\n]+?)\s*$/;

/** @returns {string | null} a reason to block, or null to allow */
export function checkBashCommand(command, cwd = process.cwd(), env = process.env) {
  if (!command || env.FORGE_BASH_GUARD === "off" || command.includes("# allow-unbounded")) return null;

  if (RECURSIVE_GREP.test(command) && !OUTPUT_LIMITER.test(command)) {
    return "Blocked: recursive grep with unbounded output. Use the Grep tool (it limits results), or add `| head -50`, `-l`, `-c` or `-m N`. If you really need everything, append `# allow-unbounded`.";
  }

  const cat = SIMPLE_CAT.exec(command);
  if (cat) {
    const files = cat[1].split(/\s+/).filter((a) => a && !a.startsWith("-"));
    let total = 0;
    for (const f of files) {
      try {
        const s = statSync(resolve(cwd, f.replace(/^["']|["']$/g, "")));
        if (s.isFile()) total += s.size;
      } catch {
        // missing file: let cat report it
      }
    }
    if (total > MAX_CAT_BYTES) {
      return `Blocked: cat of ${Math.round(total / 1024)} KB would flood the conversation. Use the Read tool with an offset/limit, or \`head -n 100 <file>\` / \`grep\` for what you need. If you really need it all, append \`# allow-unbounded\`.`;
    }
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
  const reason = checkBashCommand(input?.tool_input?.command, input?.cwd || process.cwd());
  if (reason) {
    process.stderr.write(reason + "\n");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch(() => process.exit(0));
}
