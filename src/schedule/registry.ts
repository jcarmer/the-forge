import { z } from "zod";

export interface JobContext {
  /** Persistent runtime state (a Docker volume): put caches here, never next to the code. */
  stateDir: string;
  /** Where the repos live (/projects in the container). */
  projectsRoot: string;
  log: (line: string) => void;
  signal: AbortSignal;
}

export interface JobResult {
  /** One line shown in the run history. */
  summary: string;
  /** "findings" marks a successful run that found something worth looking at. */
  status?: "ok" | "findings";
  /** Anything JSON; stored with the run. */
  details?: unknown;
}

/**
 * A function the scheduler can run. Register new ones in `src/jobs/index.ts`.
 * `params` is a zod schema: it validates the parameters saved in the UI, supplies defaults, and (via z.toJSONSchema) draws the form.
 */
export interface JobDef<S extends z.ZodType = z.ZodType> {
  id: string;
  title: string;
  description: string;
  params: S;
  run: (params: z.infer<S>, ctx: JobContext) => Promise<JobResult>;
}

export function defineJob<S extends z.ZodType>(def: JobDef<S>): JobDef<S> {
  return def;
}

export type AnyJob = JobDef<z.ZodType>;

export function describeJob(job: AnyJob) {
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    paramsSchema: z.toJSONSchema(job.params, { io: "input", unrepresentable: "any" }),
  };
}
