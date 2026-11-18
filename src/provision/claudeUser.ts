import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FORGE_ROOT = "/opt/the-forge";
export const CLAUDE_DIR = "/root/.claude";
const BEGIN = "<!-- forge:begin (managed by the-forge; edit ops/claude-user/CLAUDE.md instead) -->";
const END = "<!-- forge:end -->";
const GUARD_MARKER = "bash-guard.mjs";
const TELEMETRY_MARKER = "session-telemetry.mjs";

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

function upsertHookEvent(list: HookEntry[] | undefined, marker: string, matcher: string, command?: string): HookEntry[] | undefined {
  const cleaned = (list ?? [])
    .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !h.command?.includes(marker)) }))
    .filter((e) => (e.hooks?.length ?? 0) > 0);
  if (command) cleaned.push({ matcher, hooks: [{ type: "command", command }] });
  return cleaned.length > 0 ? cleaned : list !== undefined ? [] : undefined;
}

/** Adds our PreToolUse/Bash hook (and optional telemetry hooks), drops any older copy of them, and keeps every other setting and hook. */
export function mergeHookSettings(existing: Json, command: string, telemetryCommand?: string): Json {
  const hooks = { ...((existing.hooks as Json | undefined) ?? {}) };
  hooks.PreToolUse = upsertHookEvent(hooks.PreToolUse as HookEntry[] | undefined, GUARD_MARKER, "Bash", command);
  const preCompact = upsertHookEvent(hooks.PreCompact as HookEntry[] | undefined, TELEMETRY_MARKER, "*", telemetryCommand);
  if (preCompact !== undefined) hooks.PreCompact = preCompact;
  const postFail = upsertHookEvent(hooks.PostToolUseFailure as HookEntry[] | undefined, TELEMETRY_MARKER, "*", telemetryCommand);
  if (postFail !== undefined) hooks.PostToolUseFailure = postFail;
  return { ...existing, hooks };
}

/** The installed CLAUDE.md only points at the repo file, so the repo stays the single copy of the guidance. */
function guidancePointer(p: ClaudeUserPaths) {
  return `@${join(p.repoDir, "ops/claude-user/CLAUDE.md")}`;
}

function guardCommand(p: ClaudeUserPaths) {
  return `node ${join(p.repoDir, "ops/claude-user", GUARD_MARKER)}`;
}

function telemetryCommand(p: ClaudeUserPaths): string | undefined {
  const script = join(p.repoDir, "ops/claude-user", TELEMETRY_MARKER);
  return existsSync(script) ? `node ${script}` : undefined;
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

/** Skills shipped in the repo (ops/claude-user/skills/<name>/SKILL.md) that should exist under <claudeDir>/skills. */
function skillNames(p: ClaudeUserPaths): string[] {
  const dir = join(p.repoDir, "ops/claude-user/skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
    .map((e) => e.name);
}

function skillsCurrent(p: ClaudeUserPaths): boolean {
  return skillNames(p).every((n) => {
    const dst = join(p.claudeDir, "skills", n, "SKILL.md");
    return existsSync(dst) && readFileSync(dst, "utf8") === readFileSync(join(p.repoDir, "ops/claude-user/skills", n, "SKILL.md"), "utf8");
  });
}

export function isClaudeUserConfigCurrent(p: ClaudeUserPaths = defaults): boolean {
  try {
    const guidance = guidancePointer(p);
    const md = join(p.claudeDir, "CLAUDE.md");
    if (!existsSync(md) || mergeManagedBlock(readFileSync(md, "utf8"), guidance) !== readFileSync(md, "utf8")) return false;
    const settings = readSettings(join(p.claudeDir, "settings.json"));
    if (JSON.stringify(mergeHookSettings(settings, guardCommand(p), telemetryCommand(p))) !== JSON.stringify(settings)) return false;
    return skillsCurrent(p);
  } catch {
    return false;
  }
}

export function installClaudeUserConfig(p: ClaudeUserPaths = defaults): void {
  const guidance = guidancePointer(p);
  mkdirSync(p.claudeDir, { recursive: true });

  const md = join(p.claudeDir, "CLAUDE.md");
  const mdOld = existsSync(md) ? readFileSync(md, "utf8") : "";
  writeFileSync(md, mergeManagedBlock(mdOld, guidance), "utf8");

  const settingsPath = join(p.claudeDir, "settings.json");
  const merged = mergeHookSettings(readSettings(settingsPath), guardCommand(p), telemetryCommand(p));
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");

  for (const n of skillNames(p)) {
    cpSync(join(p.repoDir, "ops/claude-user/skills", n), join(p.claudeDir, "skills", n), { recursive: true });
  }
}
