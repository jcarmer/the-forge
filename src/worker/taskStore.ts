import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
