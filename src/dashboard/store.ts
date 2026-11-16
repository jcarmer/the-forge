import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../schema.js";

/** One launch-pad tile as shown on the Dashboard tab. */
export interface DashboardTile {
  id: string;
  label: string;
  kind: "workspace" | "service" | "custom";
  description?: string;
  /** workspace: absolute path inside the container (opened through the VS Code tunnel). */
  path?: string;
  /** service: port on the Forge host (the browser builds http://<host>:<port>). */
  port?: number;
  /** custom: a link to open. */
  url?: string;
  /** custom: a shell command the server runs inside the container. */
  command?: string;
  hidden: boolean;
}

/** What is persisted: only the user's choices, so newly discovered tiles still show up. */
export interface DashboardConfig {
  order: string[];
  hidden: string[];
  custom: Omit<DashboardTile, "hidden">[];
}

export const EMPTY_CONFIG: DashboardConfig = { order: [], hidden: [], custom: [] };

const MAX_CUSTOM = 100;
const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function dashboardPath(stateDir: string): string {
  return join(stateDir, "dashboard.json");
}

/** Validates untrusted JSON into a config; returns null if the shape is wrong. */
export function parseConfig(raw: unknown): DashboardConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ids = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length <= 1000 && v.every((x) => str(x, 200)) ? (v as string[]) : null;
  const order = ids(r.order ?? []);
  const hidden = ids(r.hidden ?? []);
  if (!order || !hidden || !Array.isArray(r.custom ?? []) || (r.custom as unknown[]).length > MAX_CUSTOM) return null;
  const custom: DashboardConfig["custom"] = [];
  for (const c of (r.custom ?? []) as unknown[]) {
    if (!c || typeof c !== "object") return null;
    const t = c as Record<string, unknown>;
    if (!str(t.id, 200) || !t.id.startsWith("custom:") || !str(t.label, 100)) return null;
    for (const k of ["url", "command", "description"]) if (t[k] !== undefined && !str(t[k], 2000)) return null;
    if (t.url === undefined && t.command === undefined) return null;
    custom.push({
      id: t.id,
      label: t.label,
      kind: "custom",
      ...(t.description ? { description: t.description as string } : {}),
      ...(t.url ? { url: t.url as string } : {}),
      ...(t.command ? { command: t.command as string } : {}),
    });
  }
  return { order, hidden, custom };
}

export function loadConfig(stateDir: string): DashboardConfig {
  try {
    return parseConfig(JSON.parse(readFileSync(dashboardPath(stateDir), "utf8"))) ?? EMPTY_CONFIG;
  } catch {
    return EMPTY_CONFIG;
  }
}

export function saveConfig(stateDir: string, cfg: DashboardConfig): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(dashboardPath(stateDir), JSON.stringify(cfg, null, 2));
}

/** Git repos under the projects root plus any `*.code-workspace` files (two levels deep). */
export function discoverWorkspaces(projectsRoot: string): DashboardTile[] {
  const out: DashboardTile[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(projectsRoot).sort();
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = join(projectsRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(dir, ".git"))) {
      out.push({ id: `ws:${name}`, label: name, kind: "workspace", path: `/projects/${name}`, hidden: false });
    }
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".code-workspace")) {
          out.push({
            id: `ws:${name}/${f}`,
            label: `${name} · ${f.replace(/\.code-workspace$/, "")}`,
            kind: "workspace",
            description: "VS Code workspace file",
            path: `/projects/${name}/${f}`,
            hidden: false,
          });
        }
      }
    } catch {
      /* unreadable dir: skip */
    }
  }
  return out;
}

/** T3, ComfyUI, Ollama and the TBE platform preview, derived from the manifest. */
export function presetTiles(manifest: Pick<Manifest, "services" | "previews">): DashboardTile[] {
  const pretty: Record<string, string> = { t3: "T3", comfyui: "ComfyUI", ollama: "Ollama" };
  const tiles: DashboardTile[] = [];
  for (const s of manifest.services) {
    if (!(s.name in pretty)) continue;
    tiles.push({ id: `svc:${s.name}`, label: pretty[s.name], kind: "service", description: s.description, port: s.port, hidden: false });
  }
  const tbe = manifest.previews.find((p) => p.name === "tbe");
  if (tbe) tiles.push({ id: "svc:tbe", label: "TBE platform", kind: "service", description: "TBE dev preview", port: tbe.port, hidden: false });
  return tiles;
}

/** Applies the saved order/hidden/custom choices over everything currently available. Unknown ids are dropped. */
export function mergeTiles(available: DashboardTile[], cfg: DashboardConfig): DashboardTile[] {
  const all = [...available, ...cfg.custom.map((c) => ({ ...c, hidden: false }))];
  const byId = new Map(all.map((t) => [t.id, t]));
  const ordered: DashboardTile[] = [];
  for (const id of cfg.order) {
    const t = byId.get(id);
    if (t) {
      ordered.push(t);
      byId.delete(id);
    }
  }
  ordered.push(...byId.values());
  const hidden = new Set(cfg.hidden);
  return ordered.map((t) => ({ ...t, hidden: hidden.has(t.id) }));
}
