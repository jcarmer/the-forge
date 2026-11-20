import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { WhenSchema } from "./when.js";

/** One row in the schedule table. A job can have any number of entries, each with its own schedule and parameters. */
export const EntrySchema = z.object({
  id: z.string().min(1).max(64),
  jobId: z.string().min(1).max(100),
  label: z.string().max(100).default(""),
  enabled: z.boolean().default(true),
  when: WhenSchema,
  timezone: z.string().default("UTC"),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Fire times after this instant are due. Set on create/edit and after every run, so a restart catches up once, never repeatedly. */
  lastCheckedAt: z.string(),
});
export type ScheduleEntry = z.infer<typeof EntrySchema>;

export const RunSchema = z.object({
  id: z.string(),
  entryId: z.string(),
  jobId: z.string(),
  label: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["running", "ok", "findings", "error"]),
  summary: z.string().default(""),
  error: z.string().optional(),
  log: z.array(z.string()).default([]),
  details: z.unknown().optional(),
});
export type RunRecord = z.infer<typeof RunSchema>;

const MAX_RUNS = 200;
const MAX_LOG_LINES = 200;

function readJson<T>(file: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    return parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return fallback;
  }
}

/** Write-then-rename so a crash mid-write never leaves half a file. */
export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export class ScheduleStore {
  private entriesFile: string;
  private runsFile: string;

  constructor(stateDir: string) {
    this.entriesFile = join(stateDir, "schedules.json");
    this.runsFile = join(stateDir, "schedule-runs.json");
  }

  entries(): ScheduleEntry[] {
    if (!existsSync(this.entriesFile)) return [];
    return readJson(this.entriesFile, (r) => z.array(EntrySchema).parse(r), []);
  }

  saveEntries(entries: ScheduleEntry[]) {
    writeJsonAtomic(this.entriesFile, entries);
  }

  runs(): RunRecord[] {
    if (!existsSync(this.runsFile)) return [];
    return readJson(this.runsFile, (r) => z.array(RunSchema).parse(r), []);
  }

  upsertRun(run: RunRecord) {
    const trimmed = { ...run, log: run.log.slice(-MAX_LOG_LINES) };
    writeJsonAtomic(this.runsFile, [trimmed, ...this.runs().filter((r) => r.id !== run.id)].slice(0, MAX_RUNS));
  }
}
