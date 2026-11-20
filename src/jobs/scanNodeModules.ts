import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type JobContext, type JobResult, defineJob } from "../schedule/registry.js";
import { writeJsonAtomic } from "../schedule/store.js";

const DAY = 86_400_000;
/** The file types npm malware is delivered in: scripts, manifests, native/binary payloads. Docs, maps and typings are skipped. */
const SCANNED_EXT = new Set([".js", ".cjs", ".mjs", ".json", ".sh", ".ps1", ".bat", ".cmd", ".py", ".node", ".exe", ".dll", ".so", ".dylib", ".wasm"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const HASH_CONCURRENCY = 8;
const OSV_BATCH = 500;

export const ScanParams = z.object({
  roots: z.array(z.string()).default(["/projects"]).describe("Directories searched for node_modules folders"),
  osv: z.boolean().default(true).describe("Check every package@version against OSV malicious-package advisories (MAL-*); needs internet"),
  iocHashFile: z.string().default("").describe("Optional file of known-bad SHA-256 hashes, one per line (# comments allowed). Leave empty to skip."),
  recheckBaseDays: z.number().min(0).default(1).describe("An unchanged file or package is first re-checked after this many days..."),
  maxRecheckDays: z.number().min(0).default(30).describe("...and the gap doubles each clean re-check, up to this many days"),
});
export type ScanParams = z.infer<typeof ScanParams>;

interface FileEntry { s: number; m: number; h: string; n: number; k: number }
interface PkgEntry { mal: string[]; n: number; k: number }
interface Cache { files: Record<string, FileEntry>; pkgs: Record<string, PkgEntry> }

export interface ScanDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface Finding {
  kind: "malicious-package" | "known-bad-file";
  path: string;
  detail: string;
}

/** Next gap after a clean re-check: base * 2^streak days, capped. */
export function backoffMs(streak: number, p: Pick<ScanParams, "recheckBaseDays" | "maxRecheckDays">): number {
  return Math.min(p.maxRecheckDays, p.recheckBaseDays * 2 ** streak) * DAY;
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

async function mapLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length && !signal.aborted) await fn(items[i++] as T);
    }),
  );
}

interface Walked { files: { path: string; pkg?: string }[]; pkgs: Map<string, { name: string; version: string; dir: string }> }

/** Finds every file worth hashing under any node_modules below `root`. Symlinks are never followed (pnpm links would double-count). */
async function walk(root: string, out: Walked, signal: AbortSignal) {
  const visit = async (dir: string, inNm: boolean, pkgKey?: string): Promise<void> => {
    if (signal.aborted) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (inNm && entries.some((e) => e.name === "package.json" && e.isFile())) {
      try {
        const pj = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (typeof pj.name === "string" && typeof pj.version === "string") {
          pkgKey = `${pj.name}@${pj.version}`;
          if (!out.pkgs.has(pkgKey)) out.pkgs.set(pkgKey, { name: pj.name, version: pj.version, dir });
        }
      } catch { /* unreadable manifest: still scan its files */ }
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        await visit(p, inNm || e.name === "node_modules", pkgKey);
      } else if (inNm && e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot >= 0 && SCANNED_EXT.has(e.name.slice(dot).toLowerCase())) out.files.push({ path: p, pkg: pkgKey });
      }
    }
  };
  await visit(root, false);
}

function loadIoc(file: string, log: (s: string) => void): Set<string> {
  const set = new Set<string>();
  if (!file) return set;
  if (!existsSync(file)) { log(`IoC hash file not found: ${file}`); return set; }
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\b/i.exec(line.trim());
    if (m) set.add((m[1] as string).toLowerCase());
  }
  log(`loaded ${set.size} known-bad hashes`);
  return set;
}

async function queryOsv(pkgs: { name: string; version: string }[], doFetch: typeof fetch, signal: AbortSignal): Promise<string[][]> {
  const res = await doFetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: pkgs.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })) }),
    signal,
  });
  if (!res.ok) throw new Error(`OSV returned HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
  return pkgs.map((_, i) => (body.results?.[i]?.vulns ?? []).map((v) => v.id).filter((id) => id.startsWith("MAL-")));
}

export async function scanNodeModules(params: ScanParams, ctx: JobContext, deps: ScanDeps = {}): Promise<JobResult> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const cacheFile = join(ctx.stateDir, "scan-cache", "node-modules.json");
  let cache: Cache = { files: {}, pkgs: {} };
  try { cache = JSON.parse(await readFile(cacheFile, "utf8")) as Cache; } catch { /* first run */ }

  const walked: Walked = { files: [], pkgs: new Map() };
  for (const root of params.roots) await walk(root, walked, ctx.signal);
  ctx.log(`found ${walked.pkgs.size} packages, ${walked.files.length} candidate files`);

  const nextFiles: Record<string, FileEntry> = {};
  let hashed = 0, skipped = 0, tooBig = 0;
  const silent: string[] = [];
  const t0 = now();
  await mapLimit(walked.files, HASH_CONCURRENCY, ctx.signal, async ({ path }) => {
    let st;
    try { st = await stat(path); } catch { return; }
    if (st.size > MAX_FILE_BYTES) { tooBig++; return; }
    const old = cache.files[path];
    const same = !!old && old.s === st.size && old.m === st.mtimeMs;
    // Unchanged and not yet due: trust the stored hash, do not read the file.
    if (same && t0 < old.n) { nextFiles[path] = old; skipped++; return; }
    let h: string;
    try { h = await hashFile(path); } catch { return; }
    hashed++;
    // Same size and mtime but different bytes is how a tampered file hides, so it is worth a line in the log.
    if (same && old.h !== h) silent.push(path);
    const streak = same && old.h === h ? old.k + 1 : 0;
    nextFiles[path] = { s: st.size, m: st.mtimeMs, h, k: streak, n: t0 + backoffMs(streak, params) };
  });

  const findings: Finding[] = [];
  // Matching is cheap and uses the stored hashes, so a freshly added IoC applies to skipped files immediately.
  const ioc = loadIoc(params.iocHashFile, ctx.log);
  if (ioc.size) for (const [path, e] of Object.entries(nextFiles)) if (ioc.has(e.h)) findings.push({ kind: "known-bad-file", path, detail: `sha256 ${e.h} is on the known-bad list` });

  const nextPkgs: Record<string, PkgEntry> = {};
  let osvQueried = 0, osvError = "";
  if (params.osv) {
    const due: [string, { name: string; version: string; dir: string }][] = [];
    for (const [key, p] of walked.pkgs) {
      const old = cache.pkgs[key];
      if (old && t0 < old.n) nextPkgs[key] = old;
      else due.push([key, p]);
    }
    try {
      for (let i = 0; i < due.length && !ctx.signal.aborted; i += OSV_BATCH) {
        const batch = due.slice(i, i + OSV_BATCH);
        const results = await queryOsv(batch.map(([, p]) => p), doFetch, ctx.signal);
        batch.forEach(([key], j) => {
          const old = cache.pkgs[key];
          const mal = results[j] as string[];
          // A package that is clean again after being flagged, or newly flagged, restarts its backoff.
          const streak = old && old.mal.length === mal.length ? old.k + 1 : 0;
          nextPkgs[key] = { mal, k: streak, n: t0 + backoffMs(streak, params) };
        });
        osvQueried += batch.length;
      }
    } catch (e) {
      osvError = e instanceof Error ? e.message : String(e);
      ctx.log(`OSV check failed, will retry next run: ${osvError}`);
      // Keep what we knew so a network blip does not erase earlier findings.
      for (const [key] of due) if (cache.pkgs[key]) nextPkgs[key] = cache.pkgs[key] as PkgEntry;
    }
    for (const [key, e] of Object.entries(nextPkgs)) {
      const p = walked.pkgs.get(key);
      if (e.mal.length && p) findings.push({ kind: "malicious-package", path: p.dir, detail: `${key}: ${e.mal.join(", ")}` });
    }
  }

  // Aborted runs keep old entries for anything not reached; complete runs drop entries for files that no longer exist.
  const merged: Cache = ctx.signal.aborted
    ? { files: { ...cache.files, ...nextFiles }, pkgs: { ...cache.pkgs, ...nextPkgs } }
    : { files: nextFiles, pkgs: nextPkgs };
  writeJsonAtomic(cacheFile, merged);

  for (const f of findings.slice(0, 20)) ctx.log(`FINDING ${f.kind}: ${f.detail} (${f.path})`);
  for (const p of silent.slice(0, 20)) ctx.log(`content changed but size and mtime did not: ${p}`);
  const parts = [
    `${walked.pkgs.size} packages, ${walked.files.length} files (${hashed} hashed, ${skipped} unchanged and skipped${tooBig ? `, ${tooBig} over 20MB ignored` : ""})`,
    params.osv ? (osvError ? `OSV unavailable (${osvError})` : `OSV queried for ${osvQueried} packages`) : "OSV off",
    findings.length ? `${findings.length} FINDING(S)` : "nothing found",
  ];
  return {
    summary: parts.join("; "),
    status: findings.length ? "findings" : "ok",
    details: { findings: findings.slice(0, 200), silentContentChanges: silent.slice(0, 50) },
  };
}

export const scanNodeModulesJob = defineJob({
  id: "scan-node-modules",
  title: "Scan node_modules for known malware",
  description:
    "Hashes JS/JSON/script/binary files in every node_modules and checks package versions against the OSV malicious-package feed. Unchanged files are re-hashed on a growing schedule (1, 2, 4... days up to a cap); changed files are checked at once.",
  params: ScanParams,
  run: (params, ctx) => scanNodeModules(params, ctx),
});
