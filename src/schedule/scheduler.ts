import { randomUUID } from "node:crypto";
import type { AnyJob, JobContext } from "./registry.js";
import { type RunRecord, type ScheduleEntry, ScheduleStore } from "./store.js";
import { nextRunAfter, validateWhen } from "./when.js";

export interface SchedulerOptions {
  stateDir: string;
  projectsRoot: string;
  jobs: AnyJob[];
  /** How often to look for due entries. */
  tickMs?: number;
  now?: () => Date;
}

/** Evaluates every enabled entry on a timer and runs the ones that are due. State lives in `stateDir`, so a restart loses nothing. */
export class Scheduler {
  readonly store: ScheduleStore;
  private running = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private now: () => Date;

  constructor(private opts: SchedulerOptions) {
    this.store = new ScheduleStore(opts.stateDir);
    this.now = opts.now ?? (() => new Date());
  }

  job(id: string) {
    return this.opts.jobs.find((j) => j.id === id);
  }

  get jobs() {
    return this.opts.jobs;
  }

  isRunning(entryId: string) {
    return this.running.has(entryId);
  }

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 15_000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const c of this.running.values()) c.abort();
  }

  /** Public so tests (and `schedule run`) can drive it. Fires each due entry once, even if several fire times were missed. */
  async tick(): Promise<RunRecord[]> {
    const now = this.now();
    const started: Promise<RunRecord>[] = [];
    for (const entry of this.store.entries()) {
      if (!entry.enabled || this.running.has(entry.id)) continue;
      const next = nextRunAfter(entry.when, entry.timezone, new Date(entry.lastCheckedAt));
      if (next && next <= now) started.push(this.runEntry(entry.id, "schedule"));
    }
    return Promise.all(started);
  }

  async runEntry(entryId: string, trigger: "schedule" | "manual"): Promise<RunRecord> {
    const entry = this.store.entries().find((e) => e.id === entryId);
    const startedAt = this.now().toISOString();
    const run: RunRecord = {
      id: randomUUID(),
      entryId,
      jobId: entry?.jobId ?? "?",
      label: entry?.label ?? "",
      trigger,
      startedAt,
      status: "running",
      summary: "",
      log: [],
    };
    const fail = (error: string): RunRecord => {
      const done = { ...run, status: "error" as const, error, summary: error, finishedAt: this.now().toISOString() };
      this.store.upsertRun(done);
      return done;
    };
    if (!entry) return fail("schedule entry not found");
    if (this.running.has(entryId)) return fail("already running");
    const job = this.job(entry.jobId);
    if (!job) return fail(`unknown job: ${entry.jobId}`);

    // Mark as handled before running so a slow job is not re-fired by the next tick, and a crash does not loop.
    this.touch(entry, startedAt);
    const parsed = job.params.safeParse(entry.params);
    if (!parsed.success) return fail(`invalid parameters: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);

    const abort = new AbortController();
    this.running.set(entryId, abort);
    this.store.upsertRun(run);
    const ctx: JobContext = {
      stateDir: this.opts.stateDir,
      projectsRoot: this.opts.projectsRoot,
      signal: abort.signal,
      log: (line) => run.log.push(`${this.now().toISOString().slice(11, 19)} ${line}`),
    };
    try {
      const result = await job.run(parsed.data, ctx);
      const done: RunRecord = { ...run, status: result.status ?? "ok", summary: result.summary, details: result.details, finishedAt: this.now().toISOString() };
      this.store.upsertRun(done);
      return done;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const done: RunRecord = { ...run, status: "error", error: msg, summary: msg, finishedAt: this.now().toISOString() };
      this.store.upsertRun(done);
      return done;
    } finally {
      this.running.delete(entryId);
    }
  }

  private touch(entry: ScheduleEntry, at: string) {
    this.store.saveEntries(this.store.entries().map((e) => (e.id === entry.id ? { ...e, lastCheckedAt: at } : e)));
  }

  /** Create or replace an entry from untrusted input. Returns an error string instead of throwing. */
  save(input: Omit<ScheduleEntry, "lastCheckedAt" | "id"> & { id?: string }): { ok: true; entry: ScheduleEntry } | { ok: false; error: string } {
    const job = this.job(input.jobId);
    if (!job) return { ok: false, error: `unknown job: ${input.jobId}` };
    const err = validateWhen(input.when, input.timezone);
    if (err) return { ok: false, error: err };
    const params = job.params.safeParse(input.params);
    if (!params.success) return { ok: false, error: params.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ") };
    const all = this.store.entries();
    const id = input.id ?? randomUUID().slice(0, 8);
    const entry: ScheduleEntry = { ...input, id, params: input.params, lastCheckedAt: this.now().toISOString() };
    this.store.saveEntries(all.some((e) => e.id === id) ? all.map((e) => (e.id === id ? entry : e)) : [...all, entry]);
    return { ok: true, entry };
  }

  remove(id: string): boolean {
    const all = this.store.entries();
    this.running.get(id)?.abort();
    this.store.saveEntries(all.filter((e) => e.id !== id));
    return all.some((e) => e.id === id);
  }
}
