import { Cron } from "croner";
import { z } from "zod";

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM (24h)");

/** What the UI offers. Everything compiles to a cron expression so one library evaluates them all. */
export const WhenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: TimeSchema }),
  /** `days`: 0 = Sunday ... 6 = Saturday. */
  z.object({ kind: z.literal("weekly"), days: z.array(z.number().int().min(0).max(6)).min(1), time: TimeSchema }),
  /** `day`: 1-31, or "last" for the last day of the month. */
  z.object({ kind: z.literal("monthly"), day: z.union([z.number().int().min(1).max(31), z.literal("last")]), time: TimeSchema }),
  z.object({ kind: z.literal("everyMinutes"), minutes: z.number().int().min(1).max(59) }),
  z.object({ kind: z.literal("everyHours"), hours: z.number().int().min(1).max(23) }),
  /** Any 5-field cron expression (or 6 with seconds is rejected: the scheduler ticks every 15s). */
  z.object({ kind: z.literal("cron"), expr: z.string().min(1).max(100) }),
]);
export type When = z.infer<typeof WhenSchema>;

export function toCron(w: When): string {
  const hm = (t: string) => `${Number(t.slice(3))} ${Number(t.slice(0, 2))}`;
  switch (w.kind) {
    case "daily":
      return `${hm(w.time)} * * *`;
    case "weekly":
      return `${hm(w.time)} * * ${[...new Set(w.days)].sort().join(",")}`;
    case "monthly":
      return `${hm(w.time)} ${w.day === "last" ? "L" : w.day} * *`;
    case "everyMinutes":
      return `*/${w.minutes} * * * *`;
    case "everyHours":
      return `0 */${w.hours} * * *`;
    case "cron":
      return w.expr.trim();
  }
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns an error message, or null when the schedule can be evaluated. */
export function validateWhen(w: When, timezone: string): string | null {
  if (!isValidTimezone(timezone)) return `unknown timezone: ${timezone}`;
  const expr = toCron(w);
  if (expr.split(/\s+/).length !== 5) return "cron expression must have 5 fields (minute hour day month weekday)";
  try {
    const c = new Cron(expr, { timezone, paused: true });
    return c.nextRun() ? null : "schedule never fires";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** First scheduled time strictly after `after`, or null. */
export function nextRunAfter(w: When, timezone: string, after: Date): Date | null {
  return new Cron(toCron(w), { timezone, paused: true }).nextRun(after);
}

export function nextRuns(w: When, timezone: string, count: number, from = new Date()): Date[] {
  const out: Date[] = [];
  let t: Date | null = from;
  while (out.length < count && (t = nextRunAfter(w, timezone, t))) out.push(t);
  return out;
}
