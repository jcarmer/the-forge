/**
 * Repo discovery and name validation shared by the Git summary (tiles) and the per-repo detail API.
 * Repos are only ever addressed by a bare directory name under `projectsRoot`; caller paths are never accepted.
 */
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

/** Expected, client-caused failure: reported as HTTP 400 (or `status`) with `detail`. */
export class RepoActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const REPO_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export function isValidRepoName(name: unknown): name is string {
  return typeof name === "string" && REPO_NAME_RE.test(name) && !name.includes("..");
}

function isDirLike(root: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(root, e.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a repo by bare name to `<projectsRoot>/<name>`. Only top-level, non-hidden directories (or symlinks to
 * directories, like /projects/the-forge) containing `.git` are accepted, exactly like `scanRepos` discovers them.
 */
export function resolveRepo(projectsRoot: string, name: unknown): string {
  if (!isValidRepoName(name)) throw new RepoActionError("invalid repo name");
  const root = resolve(projectsRoot);
  if (!existsSync(root)) throw new RepoActionError(`repo not found: ${name}`, 404);
  const entry = readdirSync(root, { withFileTypes: true }).find((e) => e.name === name);
  if (!entry || !isDirLike(root, entry)) throw new RepoActionError(`repo not found: ${name}`, 404);
  const dir = join(root, name);
  if (!existsSync(join(dir, ".git"))) throw new RepoActionError(`repo not found: ${name}`, 404);
  return dir;
}

/** Names of the repos under `projectsRoot` (same rules as `resolveRepo`), sorted; no git commands are run. */
export function listRepoNames(projectsRoot: string): string[] {
  const root = resolve(projectsRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => isValidRepoName(e.name) && isDirLike(root, e) && existsSync(join(root, e.name, ".git")))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}
