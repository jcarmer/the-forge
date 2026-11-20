import { z } from "zod";
import { ExtensionStore } from "../extension/store.js";
import type { Scheduler } from "./scheduler.js";
import { describeJob } from "./registry.js";
import { WhenSchema, nextRuns, toCron } from "./when.js";

export interface RouteRequest {
  method: string;
  pathname: string;
  /** Parsed JSON object body (POST/PUT), or {} . */
  body: Record<string, unknown>;
  authorization?: string;
  /** True when the request came from the Forge web UI (same-origin, custom header). Required for anything that changes state. */
  fromUi: boolean;
}
export interface RouteResponse { status: number; body: unknown; raw?: { contentType: string; text: string } }

const SaveSchema = z.object({
  id: z.string().optional(),
  jobId: z.string(),
  label: z.string().max(100).default(""),
  enabled: z.boolean().default(true),
  when: WhenSchema,
  timezone: z.string().default("UTC"),
  params: z.record(z.string(), z.unknown()).default({}),
});

const err = (status: number, error: string): RouteResponse => ({ status, body: { error } });

export function isScheduleRoute(pathname: string) {
  return pathname.startsWith("/api/schedules") || pathname.startsWith("/api/ext/");
}

/** Pure request handling (no http types) so it can be tested directly. Returns null for paths it does not own. */
export function handleScheduleRoute(sched: Scheduler, ext: ExtensionStore, r: RouteRequest): RouteResponse | null {
  const { method, pathname } = r;
  const mutating = method !== "GET";

  // --- Browser extension (bearer token, no UI header: the extension is not the web UI) ---
  if (pathname === "/api/ext/config" && method === "GET") {
    if (!ext.checkToken(r.authorization)) return err(401, "bad or missing token");
    return { status: 200, body: { actions: ext.actions().filter((a) => a.enabled) } };
  }
  if (pathname === "/api/ext/result" && method === "POST") {
    if (!ext.checkToken(r.authorization)) return err(401, "bad or missing token");
    const saved = ext.saveResult(r.body);
    return saved.ok ? { status: 200, body: { ok: true, meta: saved.meta } } : err(400, saved.error);
  }

  if (!isScheduleRoute(pathname)) return null;
  if (mutating && !r.fromUi) return err(403, "this request must come from the Forge web UI");

  // --- Extension management (UI) ---
  if (pathname === "/api/ext/actions" && method === "GET") return { status: 200, body: { actions: ext.actions(), hasToken: ext.hasToken(), collected: ext.collected() } };
  if (pathname === "/api/ext/actions" && method === "PUT") {
    const saved = ext.saveActions(r.body.actions);
    return saved.ok ? { status: 200, body: { actions: saved.actions } } : err(400, saved.error);
  }
  if (pathname === "/api/ext/token" && method === "POST") return { status: 200, body: { token: ext.rotateToken() } };
  if (pathname.startsWith("/api/ext/collected/") && method === "GET") {
    const got = ext.readCollected(decodeURIComponent(pathname.slice("/api/ext/collected/".length)));
    return got ? { status: 200, body: got.meta, raw: { contentType: "text/plain; charset=utf-8", text: got.body } } : err(404, "no such collected item");
  }

  // --- Schedules (UI) ---
  if (pathname === "/api/schedules" && method === "GET") {
    const entries = sched.store.entries().map((e) => ({
      ...e,
      cron: toCron(e.when),
      running: sched.isRunning(e.id),
      next: e.enabled ? nextRuns(e.when, e.timezone, 3).map((d) => d.toISOString()) : [],
    }));
    return { status: 200, body: { jobs: sched.jobs.map(describeJob), entries, runs: sched.store.runs().slice(0, 50) } };
  }
  if (pathname === "/api/schedules" && method === "PUT") {
    const parsed = SaveSchema.safeParse(r.body);
    if (!parsed.success) return err(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const saved = sched.save(parsed.data);
    return saved.ok ? { status: 200, body: { entry: saved.entry } } : err(400, saved.error);
  }
  const m = /^\/api\/schedules\/([A-Za-z0-9-]+)(\/run)?$/.exec(pathname);
  if (m && method === "DELETE" && !m[2]) return sched.remove(m[1] as string) ? { status: 200, body: { ok: true } } : err(404, "no such entry");
  if (m && method === "POST" && m[2]) {
    const id = m[1] as string;
    if (!sched.store.entries().some((e) => e.id === id)) return err(404, "no such entry");
    if (sched.isRunning(id)) return err(409, "already running");
    void sched.runEntry(id, "manual"); // runs in the background; the UI polls /api/schedules
    return { status: 202, body: { ok: true } };
  }
  return err(404, "unknown route");
}
