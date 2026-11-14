import { execFile } from "node:child_process";
import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isPackageUpdateAvailable, type PackageConsumer, type PackageStatus, type RepoStatus } from "../state/forgeState.js";

const execFileAsync = promisify(execFile);

async function runQuiet(cmd: string, args: string[], cwd?: string, timeout = 15_000) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout, encoding: "utf8" });
    return { code: 0, out: stdout + stderr };
  } catch (e: unknown) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

interface PackageJsonLite {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

function readPkgJson(dir: string): PackageJsonLite | null {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PackageJsonLite;
  } catch {
    return null;
  }
}

/** True for real directories and for symlinks that resolve to one (e.g. /projects/the-forge -> /opt/the-forge). */
function isDirLike(projectsRoot: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(projectsRoot, e.name)).isDirectory();
  } catch {
    return false;
  }
}

/** Scans git repositories under `projectsRoot` (and nested `web/` if present) for branch/dirty/unpushed status. */
export async function scanRepos(projectsRoot: string): Promise<RepoStatus[]> {
  if (!existsSync(projectsRoot)) return [];
  const results: RepoStatus[] = [];
  const entries = readdirSync(projectsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const e of entries) {
    if (!isDirLike(projectsRoot, e) || e.name.startsWith(".")) continue;
    const dir = join(projectsRoot, e.name);
    if (!existsSync(join(dir, ".git"))) continue;

    const [branchRes, statusRes, revRes, remotesRes, localOnlyRes, stashRes] = await Promise.all([
      runQuiet("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]),
      runQuiet("git", ["-C", dir, "status", "--porcelain"]),
      runQuiet("git", ["-C", dir, "rev-list", "--left-right", "--count", "@{u}...HEAD"]),
      runQuiet("git", ["-C", dir, "remote"]),
      runQuiet("git", ["-C", dir, "rev-list", "--count", "--branches", "--not", "--remotes"]),
      runQuiet("git", ["-C", dir, "stash", "list"]),
    ]);
    const hasRemote = remotesRes.code === 0 && remotesRes.out.trim().length > 0;

    const branch = branchRes.code === 0 ? branchRes.out.trim() : "unknown";
    const dirty = statusRes.code === 0 && statusRes.out.trim().length > 0;
    let behind = 0;
    let ahead = 0;
    if (revRes.code === 0) {
      const parts = revRes.out.trim().split(/\s+/);
      behind = Number(parts[0] ?? 0) || 0;
      ahead = Number(parts[1] ?? 0) || 0;
    }
    // Without an upstream, `@{u}` fails: count commits that exist on no remote instead of reporting zero.
    const noUpstream = revRes.code !== 0 && hasRemote && branch !== "HEAD" && branch !== "unknown";
    const localOnlyCommits = localOnlyRes.code === 0 && hasRemote ? Number(localOnlyRes.out.trim()) || 0 : 0;
    if (noUpstream) {
      const own = await runQuiet("git", ["-C", dir, "rev-list", "--count", "HEAD", "--not", "--remotes"]);
      ahead = Number(own.out.trim()) || 0;
    }
    const stashes = stashRes.code === 0 ? stashRes.out.split("\n").filter(Boolean).length : 0;

    results.push({
      name: e.name,
      path: dir,
      branch,
      dirty,
      ahead,
      behind,
      noUpstream,
      localOnlyCommits,
      stashes,
      unpushed: ahead > 0 || noUpstream || localOnlyCommits > 0,
    });
  }
  return results;
}

function isSymlinkedTo(consumerDir: string, pkgName: string, targetDir: string): boolean {
  const linkPath = join(consumerDir, "node_modules", ...pkgName.split("/"));
  if (!existsSync(linkPath)) return false;
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;
    return realpathSync(linkPath) === realpathSync(targetDir);
  } catch {
    return false;
  }
}

/** Discovers shared `@tbe/*` packages under `projectsRoot` and their consumers (including `the-forge/web`). */
export function scanPackages(projectsRoot: string, repos: RepoStatus[]): PackageStatus[] {
  if (!existsSync(projectsRoot)) return [];
  const repoMap = new Map(repos.map((r) => [r.path, r]));

  // Candidate consumer directories (top-level repos/symlinks + `the-forge/web`)
  const consumerDirs: { name: string; dir: string }[] = [];
  for (const e of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const dir = join(projectsRoot, e.name);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "package.json"))) consumerDirs.push({ name: e.name, dir });
    const webDir = join(dir, "web");
    if (existsSync(join(webDir, "package.json"))) consumerDirs.push({ name: `${e.name}/web`, dir: webDir });
  }

  const packages: PackageStatus[] = [];
  for (const e of readdirSync(projectsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isDirLike(projectsRoot, e) || e.name.startsWith(".")) continue;
    const dir = join(projectsRoot, e.name);
    const pkg = readPkgJson(dir);
    if (!pkg?.name?.startsWith("@tbe/") || !pkg.version) continue;

    const repoMeta = repoMap.get(dir);
    const apiDts = join(dir, "dist", "API.d.ts");
    const indexDts = join(dir, "dist", "index.d.ts");
    const hasApiDts = existsSync(apiDts) || existsSync(indexDts);

    const consumers: PackageConsumer[] = [];
    for (const c of consumerDirs) {
      if (c.dir === dir) continue;
      const cPkg = readPkgJson(c.dir);
      const pinned = cPkg?.dependencies?.[pkg.name] ?? cPkg?.devDependencies?.[pkg.name];
      if (!pinned) continue;
      consumers.push({
        repo: c.name,
        repoPath: c.dir,
        pinnedVersion: pinned,
        linked: isSymlinkedTo(c.dir, pkg.name, dir),
        updateAvailable: isPackageUpdateAvailable(pkg.version, pinned),
      });
    }

    packages.push({
      name: pkg.name,
      version: pkg.version,
      repoName: e.name,
      repoPath: dir,
      dirty: repoMeta?.dirty ?? false,
      unpushed: repoMeta?.unpushed ?? false,
      hasApiDts,
      consumers,
    });
  }

  return packages;
}

/**
 * Toggles a container-local symlink in `consumerDir/node_modules/<pkgName>` without modifying `package.json` or lockfiles.
 * When `enable` is false, restores the pinned install via `npm install --no-save` if a lockfile/node_modules exists.
 */
export async function togglePackageLink(
  projectsRoot: string,
  pkgName: string,
  consumerRepo: string,
  enable: boolean,
): Promise<{ ok: boolean; detail: string }> {
  const repos = await scanRepos(projectsRoot);
  const pkgs = scanPackages(projectsRoot, repos);
  const pkg = pkgs.find((p) => p.name === pkgName);
  if (!pkg) return { ok: false, detail: `Package ${pkgName} not found` };

  const consumer = pkg.consumers.find((c) => c.repo === consumerRepo);
  if (!consumer) return { ok: false, detail: `Consumer ${consumerRepo} does not depend on ${pkgName}` };

  const targetLink = join(consumer.repoPath, "node_modules", ...pkgName.split("/"));
  if (enable) {
    if (!existsSync(join(pkg.repoPath, "dist"))) {
      const built = await buildPackage(projectsRoot, pkgName);
      if (!built.ok) return built;
    }
    mkdirSync(dirname(targetLink), { recursive: true });
    rmSync(targetLink, { recursive: true, force: true });
    symlinkSync(pkg.repoPath, targetLink, process.platform === "win32" ? "junction" : "dir");
    return { ok: true, detail: `Linked ${pkgName} -> ${consumerRepo}` };
  } else {
    rmSync(targetLink, { recursive: true, force: true });
    return { ok: true, detail: `Unlinked ${pkgName} in ${consumerRepo} (run npm install to restore pinned tarball)` };
  }
}

/** Pushes the repo's current branch to `origin` (sets upstream on first push). Never forces. */
export async function pushRepo(projectsRoot: string, repoName: string): Promise<{ ok: boolean; detail: string }> {
  const repos = await scanRepos(projectsRoot);
  const repo = repos.find((r) => r.name === repoName);
  if (!repo) return { ok: false, detail: `Repo ${repoName} not found` };
  if (repo.branch === "HEAD" || repo.branch === "unknown") {
    return { ok: false, detail: `${repoName} is not on a branch (detached HEAD); check out a branch first` };
  }
  const hasUpstream = (await runQuiet("git", ["-C", repo.path, "rev-parse", "--abbrev-ref", "@{u}"])).code === 0;
  const args = hasUpstream ? ["push"] : ["push", "-u", "origin", repo.branch];
  const r = await runQuiet("git", ["-C", repo.path, ...args], undefined, 60_000);
  const tail = r.out.trim().slice(-500);
  return r.code === 0
    ? { ok: true, detail: `Pushed ${repoName} (${repo.branch})${tail ? `: ${tail}` : ""}` }
    : { ok: false, detail: `Push failed for ${repoName}: ${tail}` };
}

export async function buildPackage(projectsRoot: string, pkgName: string): Promise<{ ok: boolean; detail: string }> {
  const repos = await scanRepos(projectsRoot);
  const pkgs = scanPackages(projectsRoot, repos);
  const pkg = pkgs.find((p) => p.name === pkgName);
  if (!pkg) return { ok: false, detail: `Package ${pkgName} not found` };

  const r = await runQuiet("npm", ["run", "build"], pkg.repoPath, 60_000);
  return { ok: r.code === 0, detail: r.code === 0 ? `Built ${pkgName}` : r.out.slice(-500) };
}

export function readPackageApiDts(projectsRoot: string, pkgName: string): string | null {
  for (const e of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!isDirLike(projectsRoot, e) || e.name.startsWith(".")) continue;
    const dir = join(projectsRoot, e.name);
    const pkg = readPkgJson(dir);
    if (pkg?.name !== pkgName) continue;
    const apiPath = join(dir, "dist", "API.d.ts");
    if (existsSync(apiPath)) return readFileSync(apiPath, "utf8");
    const idxPath = join(dir, "dist", "index.d.ts");
    if (existsSync(idxPath)) return readFileSync(idxPath, "utf8");
  }
  return null;
}
