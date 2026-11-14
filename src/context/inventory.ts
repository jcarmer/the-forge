import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ItemKind = "guidance" | "rule" | "skill" | "mcp" | "setting";
export type ItemProvider = "claude" | "antigravity" | "opencode" | "shared";
export type ItemScope = "global" | "ancestor" | "project";

export interface ContextItem {
  kind: ItemKind;
  provider: ItemProvider;
  scope: ItemScope;
  name: string;
  /** Source file the item comes from. */
  path: string;
  bytes: number;
  /** Rough context cost (bytes / 4). Skills and MCPs only cost their short listing until used. */
  approxTokens: number;
  detail?: string;
}

export interface ContextReport {
  project: string;
  scannedAt: string;
  items: ContextItem[];
  warnings: string[];
}

const GUIDANCE_FILES: { rel: string; provider: ItemProvider }[] = [
  { rel: "CLAUDE.md", provider: "claude" },
  { rel: "CLAUDE.local.md", provider: "claude" },
  { rel: ".claude/CLAUDE.md", provider: "claude" },
  { rel: "AGENTS.md", provider: "shared" },
  { rel: ".agents/AGENTS.md", provider: "shared" },
  { rel: "GEMINI.md", provider: "antigravity" },
];

const SKILL_ROOTS: { rel: string; provider: ItemProvider }[] = [
  { rel: ".claude/skills", provider: "claude" },
  { rel: ".agents/skills", provider: "shared" },
];

const SKIP_DIRS = new Set([".staging", "node_modules", ".git", ".venv"]);

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function fileItem(kind: ItemKind, provider: ItemProvider, scope: ItemScope, name: string, path: string, detail?: string): ContextItem | null {
  if (!isFile(path)) return null;
  const bytes = statSync(path).size;
  return { kind, provider, scope, name, path, bytes, approxTokens: Math.ceil(bytes / 4), detail };
}

/** Pulls `name` and `description` from a SKILL.md YAML frontmatter block (single-line values only). */
export function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** `@path` import lines in a CLAUDE.md, resolved against the importing file. */
export function findImports(text: string, fromFile: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^@(\S+)\s*$/);
    if (!m) continue;
    const p = m[1].startsWith("~/") ? join(homedir(), m[1].slice(2)) : resolve(dirname(fromFile), m[1]);
    out.push(p);
  }
  return out;
}

function collectSkills(root: string, provider: ItemProvider, scope: ItemScope, depth = 0): ContextItem[] {
  if (depth > 4) return [];
  const items: ContextItem[] = [];
  for (const entry of listDir(root)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const dir = join(root, entry);
    const skillFile = join(dir, "SKILL.md");
    if (isFile(skillFile)) {
      const fm = parseFrontmatter(safeRead(skillFile) ?? "");
      const name = fm.name ?? entry;
      const desc = fm.description ?? "";
      const it = fileItem("skill", provider, scope, name, skillFile, desc.slice(0, 160));
      // Only the name + description sit in context until the skill is invoked.
      if (it) items.push({ ...it, approxTokens: Math.ceil((name.length + desc.length) / 4) });
    } else {
      items.push(...collectSkills(dir, provider, scope, depth + 1));
    }
  }
  return items;
}

const SECRET_KEY = /(key|token|secret|password|auth|credential)/i;
const SECRET_VALUE = /^(ghp_|github_pat_|sk-|xox[bp]-|AIza)/;

/** Describes an MCP server without leaking secrets: env values are never shown and URLs lose userinfo/query. */
export function describeMcp(cfg: unknown): string {
  if (!cfg || typeof cfg !== "object") return "";
  const c = cfg as { command?: string; args?: unknown[]; url?: string; type?: string; env?: Record<string, unknown>; headers?: Record<string, unknown> };
  const parts: string[] = [];
  if (c.url) {
    try {
      const u = new URL(c.url);
      parts.push(`${c.type ?? "http"} ${u.origin}${u.pathname}`);
    } catch {
      parts.push(`${c.type ?? "http"} (unparseable url)`);
    }
  }
  if (c.command) {
    const args: string[] = [];
    let maskNext = false;
    for (const a of c.args ?? []) {
      const s = String(a);
      if (maskNext) {
        args.push("***");
        maskNext = false;
      } else if (SECRET_VALUE.test(s)) args.push("***");
      else if (/^--?[\w-]+$/.test(s) && SECRET_KEY.test(s)) {
        args.push(s);
        maskNext = true;
      } else if (/^--?[\w-]*(key|token|secret|password)[\w-]*=/i.test(s)) args.push(s.split("=")[0] + "=***");
      else args.push(s);
    }
    parts.push([c.command, ...args].join(" "));
  }
  const envKeys = Object.keys(c.env ?? {});
  if (envKeys.length) parts.push(`env: ${envKeys.join(", ")}`);
  const headerKeys = Object.keys(c.headers ?? {});
  if (headerKeys.length) parts.push(`headers: ${headerKeys.join(", ")}`);
  return parts.join("; ");
}

function mcpItems(servers: unknown, provider: ItemProvider, scope: ItemScope, path: string, origin: string): ContextItem[] {
  if (!servers || typeof servers !== "object") return [];
  const bytes = (() => {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  })();
  return Object.entries(servers as Record<string, unknown>).map(([name, cfg]) => ({
    kind: "mcp" as const,
    provider,
    scope,
    name,
    path,
    bytes,
    // Tool schemas are not known statically; the listing itself is small. Real cost shows up in session analysis.
    approxTokens: 0,
    detail: `${origin}: ${describeMcp(cfg)}`,
  }));
}

function readJson(path: string): Record<string, unknown> | null {
  const t = safeRead(path);
  if (t === null) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function settingsItem(provider: ItemProvider, scope: ItemScope, path: string): ContextItem[] {
  const j = readJson(path);
  if (!j) return [];
  const hooks = j.hooks && typeof j.hooks === "object" ? Object.keys(j.hooks as object) : [];
  const perms = (j.permissions ?? {}) as { allow?: unknown[]; deny?: unknown[]; ask?: unknown[] };
  const bits: string[] = [];
  if (hooks.length) bits.push(`hooks: ${hooks.join(", ")}`);
  if (perms.allow?.length) bits.push(`${perms.allow.length} allow`);
  if (perms.deny?.length) bits.push(`${perms.deny.length} deny`);
  if (perms.ask?.length) bits.push(`${perms.ask.length} ask`);
  if (j.env && typeof j.env === "object") bits.push(`env: ${Object.keys(j.env as object).join(", ")}`);
  if (typeof j.model === "string") bits.push(`model: ${j.model}`);
  if (!bits.length) return [];
  const it = fileItem("setting", provider, scope, basename(path), path, bits.join("; "));
  return it ? [{ ...it, approxTokens: 0 }] : [];
}

/** All instructions, rules, skills, MCP servers and settings in effect for a project directory. */
export function scanContext(projectDir: string, home = homedir()): ContextReport {
  const project = resolve(projectDir);
  const items: ContextItem[] = [];
  const warnings: string[] = [];
  const push = (...xs: (ContextItem | null)[]) => {
    for (const x of xs) if (x) items.push(x);
  };

  const claudeHome = join(home, ".claude");
  const geminiCfg = join(home, ".gemini", "config");

  // Guidance: global, then every ancestor directory (Claude loads these), then the project itself.
  push(fileItem("guidance", "claude", "global", "CLAUDE.md", join(claudeHome, "CLAUDE.md")));
  push(fileItem("guidance", "antigravity", "global", "GEMINI.md", join(home, ".gemini", "GEMINI.md")));
  push(fileItem("guidance", "antigravity", "global", "GEMINI.md", join(geminiCfg, "GEMINI.md")));
  const ancestors: string[] = [];
  for (let d = dirname(project); d !== dirname(d); d = dirname(d)) ancestors.push(d);
  for (const dir of ancestors.reverse()) {
    if (dir === home || dir === "/") continue;
    for (const g of GUIDANCE_FILES) push(fileItem("guidance", g.provider, "ancestor", g.rel, join(dir, g.rel)));
  }
  const seenImports = new Set<string>();
  for (const g of GUIDANCE_FILES) {
    const p = join(project, g.rel);
    const it = fileItem("guidance", g.provider, "project", g.rel, p);
    if (!it) continue;
    items.push(it);
    // Follow @imports (one level of recursion is enough for the Forge's CLAUDE.md -> OPERATOR.md pattern).
    const queue = findImports(safeRead(p) ?? "", p).map((f) => ({ f, from: p, depth: 1 }));
    while (queue.length) {
      const { f, from, depth } = queue.shift()!;
      if (seenImports.has(f) || depth > 3) continue;
      seenImports.add(f);
      const imp = fileItem("guidance", g.provider, "project", basename(f), f, `imported by ${basename(from)}`);
      if (!imp) {
        warnings.push(`${basename(from)} imports ${f}, which does not exist`);
        continue;
      }
      items.push(imp);
      for (const nf of findImports(safeRead(f) ?? "", f)) queue.push({ f: nf, from: f, depth: depth + 1 });
    }
  }

  // Rules
  const ruleDirs: { dir: string; provider: ItemProvider; scope: ItemScope }[] = [
    { dir: join(claudeHome, "rules"), provider: "claude", scope: "global" },
    { dir: join(geminiCfg, "rules"), provider: "antigravity", scope: "global" },
    { dir: join(project, ".claude", "rules"), provider: "claude", scope: "project" },
    { dir: join(project, ".agents", "rules"), provider: "shared", scope: "project" },
  ];
  for (const r of ruleDirs) {
    for (const f of listDir(r.dir)) push(fileItem("rule", r.provider, r.scope, f, join(r.dir, f)));
  }

  // Skills
  for (const s of SKILL_ROOTS) items.push(...collectSkills(join(project, s.rel), s.provider, "project"));
  items.push(...collectSkills(join(claudeHome, "skills"), "claude", "global"));
  items.push(...collectSkills(join(geminiCfg, "skills"), "antigravity", "global"));

  // MCP servers
  const claudeJsonPath = [join(home, ".claude.json"), join(claudeHome, ".claude.json")].find(isFile);
  if (claudeJsonPath) {
    const cj = readJson(claudeJsonPath);
    items.push(...mcpItems(cj?.mcpServers, "claude", "global", claudeJsonPath, "user"));
    const projects = (cj?.projects ?? {}) as Record<string, { mcpServers?: unknown }>;
    items.push(...mcpItems(projects[project]?.mcpServers, "claude", "project", claudeJsonPath, "local"));
  }
  const mcpJson = join(project, ".mcp.json");
  items.push(...mcpItems(readJson(mcpJson)?.mcpServers, "claude", "project", mcpJson, ".mcp.json"));
  const geminiMcp = join(geminiCfg, "mcp_config.json");
  items.push(...mcpItems(readJson(geminiMcp)?.mcpServers, "antigravity", "global", geminiMcp, "mcp_config.json"));

  // Settings (hooks, permissions)
  items.push(...settingsItem("claude", "global", join(claudeHome, "settings.json")));
  items.push(...settingsItem("claude", "project", join(project, ".claude", "settings.json")));
  items.push(...settingsItem("claude", "project", join(project, ".claude", "settings.local.json")));
  items.push(...settingsItem("antigravity", "global", join(geminiCfg, "settings.json")));

  // Warnings
  const skillByName = new Map<string, ContextItem[]>();
  for (const it of items.filter((i) => i.kind === "skill")) skillByName.set(it.name, [...(skillByName.get(it.name) ?? []), it]);
  for (const [name, list] of skillByName) {
    if (list.length > 1) warnings.push(`skill "${name}" is defined ${list.length} times (${list.map((l) => l.scope).join(", ")})`);
  }
  const mcpByName = new Map<string, ContextItem[]>();
  for (const it of items.filter((i) => i.kind === "mcp" && i.provider === "claude")) mcpByName.set(it.name, [...(mcpByName.get(it.name) ?? []), it]);
  for (const [name, list] of mcpByName) {
    if (list.length > 1) warnings.push(`MCP server "${name}" is configured in ${list.length} places for Claude (${list.map((l) => l.detail?.split(":")[0]).join(", ")})`);
  }
  const guidanceTokens = items.filter((i) => i.kind === "guidance" || i.kind === "rule").reduce((n, i) => n + i.approxTokens, 0);
  if (guidanceTokens > 8000) warnings.push(`guidance and rules total ~${guidanceTokens} tokens, loaded into every conversation`);
  if (existsSync(join(project, "CLAUDE.md")) && !existsSync(join(project, "AGENTS.md"))) warnings.push("has CLAUDE.md but no AGENTS.md (other agents will not see these instructions)");

  return { project, scannedAt: new Date().toISOString(), items, warnings };
}

/** Project directories worth showing: every git repo directly under projectsRoot, plus any extra dirs. */
export function listProjects(projectsRoot: string, extra: string[] = []): string[] {
  const dirs = listDir(projectsRoot)
    .filter((n) => !n.startsWith("."))
    .map((n) => join(projectsRoot, n))
    .filter((d) => existsSync(join(d, ".git")));
  return [...new Set([...extra.filter((d) => existsSync(d)), ...dirs])];
}
