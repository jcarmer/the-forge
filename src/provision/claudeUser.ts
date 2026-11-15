import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FORGE_ROOT = "/opt/the-forge";
export const CLAUDE_DIR = "/root/.claude";
const BEGIN = "<!-- forge:begin (managed by the-forge; edit ops/claude-user/CLAUDE.md instead) -->";
const END = "<!-- forge:end -->";
const GUARD_MARKER = "bash-guard.mjs";

export interface ClaudeUserPaths {
  repoDir: string;
  claudeDir: string;
}

const defaults: ClaudeUserPaths = { repoDir: FORGE_ROOT, claudeDir: CLAUDE_DIR };

/** Replaces (or appends) the managed block and leaves everything else in the file alone. */
export function mergeManagedBlock(existing: string, guidance: string): string {
  const block = `${BEGIN}\n${guidance.trim()}\n${END}\n`;
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length).replace(/^\n/, "");
  }
  const base = existing.trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

type Json = Record<string, unknown>;
interface HookEntry { matcher?: string; hooks?: { type?: string; command?: string }[] }

/** Adds our PreToolUse/Bash hook, drops any older copy of it, and keeps every other setting and hook. */
export function mergeHookSettings(existing: Json, command: string): Json {
  const hooks = { ...((existing.hooks as Json | undefined) ?? {}) };
  const pre = ((hooks.PreToolUse as HookEntry[] | undefined) ?? [])
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !h.command?.includes(GUARD_MARKER)) }))
    .filter((e) => (e.hooks?.length ?? 0) > 0);
  pre.push({ matcher: "Bash", hooks: [{ type: "command", command }] });
  hooks.PreToolUse = pre;
  return { ...existing, hooks };
}

function guardCommand(p: ClaudeUserPaths) {
  return `node ${join(p.repoDir, "ops/claude-user", GUARD_MARKER)}`;
}

function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  // A file we cannot parse is the user's: fail loudly instead of overwriting it.
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Json;
}

export function isClaudeUserConfigCurrent(p: ClaudeUserPaths = defaults): boolean {
  try {
    const guidance = readFileSync(join(p.repoDir, "ops/claude-user/CLAUDE.md"), "utf8");
    const md = join(p.claudeDir, "CLAUDE.md");
    if (!existsSync(md) || mergeManagedBlock(readFileSync(md, "utf8"), guidance) !== readFileSync(md, "utf8")) return false;
    const settings = readSettings(join(p.claudeDir, "settings.json"));
    return JSON.stringify(mergeHookSettings(settings, guardCommand(p))) === JSON.stringify(settings);
  } catch {
    return false;
  }
}

export function installClaudeUserConfig(p: ClaudeUserPaths = defaults): void {
  const guidance = readFileSync(join(p.repoDir, "ops/claude-user/CLAUDE.md"), "utf8");
  mkdirSync(p.claudeDir, { recursive: true });

  const md = join(p.claudeDir, "CLAUDE.md");
  const mdOld = existsSync(md) ? readFileSync(md, "utf8") : "";
  writeFileSync(md, mergeManagedBlock(mdOld, guidance), "utf8");

  const settingsPath = join(p.claudeDir, "settings.json");
  const merged = mergeHookSettings(readSettings(settingsPath), guardCommand(p));
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
}
