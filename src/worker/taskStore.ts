import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskRecord } from "../state/forgeState.js";

const DEFAULT_TASK_FILE = "/tmp/the-forge-tasks.json";

export function taskStorePath(stateDir?: string): string {
  return stateDir ? join(stateDir, "tasks.json") : DEFAULT_TASK_FILE;
}

export function loadTaskRecords(filePath = taskStorePath()): TaskRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(raw) ? (raw as TaskRecord[]) : [];
  } catch {
    return [];
  }
}

export function upsertTaskRecord(record: TaskRecord, filePath = taskStorePath()): TaskRecord[] {
  const list = loadTaskRecords(filePath).filter((t) => t.id !== record.id);
  const next = [record, ...list].slice(0, 50);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** A "running" record older than this is treated as crashed/abandoned, so it can never block a repo forever. */
const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Ids of agent tasks currently running in the repo at `repoDir` (symlinks resolved; stale records ignored). */
export function runningTaskIds(stateDir: string | undefined, repoDir: string, now = Date.now()): string[] {
  const dir = canonical(repoDir);
  return loadTaskRecords(taskStorePath(stateDir))
    .filter((t) => t.status === "running" && now - Date.parse(t.startedAt) < RUNNING_STALE_MS && canonical(t.repoDir) === dir)
    .map((t) => t.id);
}
