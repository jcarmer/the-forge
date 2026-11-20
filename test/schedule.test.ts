import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtensionStore } from "../src/extension/store.js";
import { scanNodeModules, ScanParams, backoffMs } from "../src/jobs/scanNodeModules.js";
import { handleScheduleRoute } from "../src/schedule/api.js";
import { defineJob, type AnyJob, type JobContext } from "../src/schedule/registry.js";
import { Scheduler } from "../src/schedule/scheduler.js";
import { nextRuns, toCron, validateWhen } from "../src/schedule/when.js";

const tmp = () => mkdtempSync(join(tmpdir(), "sched-"));
const iso = (d: Date) => d.toISOString();

describe("when", () => {
  it("compiles friendly schedules to cron", () => {
    expect(toCron({ kind: "daily", time: "03:30" })).toBe("30 3 * * *");
    expect(toCron({ kind: "weekly", days: [2], time: "09:00" })).toBe("0 9 * * 2");
    expect(toCron({ kind: "monthly", day: 1, time: "00:05" })).toBe("5 0 1 * *");
    expect(toCron({ kind: "monthly", day: "last", time: "23:00" })).toBe("0 23 L * *");
  });

  it("evaluates real dates: first of month and every Tuesday", () => {
    const from = new Date("2026-11-20T12:00:00Z");
    expect(nextRuns({ kind: "monthly", day: 1, time: "06:00" }, "UTC", 2, from).map(iso)).toEqual(["2026-12-01T06:00:00.000Z", "2027-01-01T06:00:00.000Z"]);
    expect(nextRuns({ kind: "weekly", days: [2], time: "09:00" }, "UTC", 2, from).map(iso)).toEqual(["2026-11-24T09:00:00.000Z", "2026-12-01T09:00:00.000Z"]);
  });

  it("honours the timezone", () => {
    const [n] = nextRuns({ kind: "daily", time: "09:00" }, "America/New_York", 1, new Date("2026-11-20T00:00:00Z"));
    expect(iso(n as Date)).toBe("2026-11-20T14:00:00.000Z"); // 09:00 EST
  });

  it("rejects bad input", () => {
    expect(validateWhen({ kind: "cron", expr: "nope" }, "UTC")).toBeTruthy();
    expect(validateWhen({ kind: "cron", expr: "* * * * * *" }, "UTC")).toMatch(/5 fields/);
    expect(validateWhen({ kind: "daily", time: "01:00" }, "Mars/Base")).toMatch(/timezone/);
    expect(validateWhen({ kind: "daily", time: "01:00" }, "UTC")).toBeNull();
  });
});

describe("scheduler", () => {
  const calls: unknown[] = [];
  const job: AnyJob = defineJob({
    id: "echo",
    title: "Echo",
    description: "",
    params: z.object({ msg: z.string().default("hi"), n: z.number().default(1) }),
    run: async (p) => { calls.push(p); return { summary: `ran ${p.msg}` }; },
  }) as AnyJob;

  function setup(start: string) {
    let now = new Date(start);
    const s = new Scheduler({ stateDir: tmp(), projectsRoot: "/x", jobs: [job], now: () => now });
    return { s, advance: (to: string) => { now = new Date(to); } };
  }

  it("runs several entries of one job with different params, once per due time", async () => {
    calls.length = 0;
    const { s, advance } = setup("2026-11-20T00:00:00Z");
    const a = s.save({ jobId: "echo", label: "a", enabled: true, when: { kind: "daily", time: "08:00" }, timezone: "UTC", params: { msg: "A" } });
    const b = s.save({ jobId: "echo", label: "b", enabled: true, when: { kind: "weekly", days: [5], time: "08:00" }, timezone: "UTC", params: { msg: "B", n: 7 } });
    expect(a.ok && b.ok).toBe(true);

    expect(await s.tick()).toHaveLength(0); // nothing due yet
    advance("2026-11-20T08:00:30Z"); // a Friday
    expect((await s.tick()).map((r) => r.summary).sort()).toEqual(["ran A", "ran B"]);
    expect(calls).toContainEqual({ msg: "B", n: 7 });
    expect(await s.tick()).toHaveLength(0); // not again

    advance("2026-11-23T09:00:00Z"); // 3 days pass (server was "down"): daily catches up once, weekly not due
    expect((await s.tick()).map((r) => r.summary)).toEqual(["ran A"]);
    expect(s.store.runs()).toHaveLength(3);
  });

  it("validates params and records failures", async () => {
    const { s } = setup("2026-11-20T00:00:00Z");
    expect(s.save({ jobId: "echo", label: "", enabled: true, when: { kind: "daily", time: "08:00" }, timezone: "UTC", params: { n: "x" } }).ok).toBe(false);
    expect(s.save({ jobId: "nope", label: "", enabled: true, when: { kind: "daily", time: "08:00" }, timezone: "UTC", params: {} }).ok).toBe(false);
    const bad = defineJob({ id: "boom", title: "", description: "", params: z.object({}), run: async () => { throw new Error("kaput"); } }) as AnyJob;
    const s2 = new Scheduler({ stateDir: tmp(), projectsRoot: "/x", jobs: [bad] });
    const e = s2.save({ jobId: "boom", label: "", enabled: true, when: { kind: "daily", time: "08:00" }, timezone: "UTC", params: {} });
    const run = await s2.runEntry((e as { entry: { id: string } }).entry.id, "manual");
    expect(run).toMatchObject({ status: "error", error: "kaput" });
  });
});

describe("scanNodeModules", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const DAY = 86_400_000;

  function project() {
    const root = tmp();
    const pkg = join(root, "app", "node_modules", "evil-pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "evil-pkg", version: "1.0.0" }));
    writeFileSync(join(pkg, "index.js"), "console.log('x')");
    writeFileSync(join(pkg, "README.md"), "docs are not scanned");
    return { root, file: join(pkg, "index.js") };
  }
  const ctx = (stateDir: string): JobContext => ({ stateDir, projectsRoot: "/", log: () => {}, signal: new AbortController().signal });
  const osv = (ids: string[]): typeof fetch => (async () => new Response(JSON.stringify({ results: [{ vulns: ids.map((id) => ({ id })) }] }))) as unknown as typeof fetch;

  it("flags OSV malware advisories (MAL-* only) and skips unchanged files until they are due", async () => {
    const { root } = project();
    const state = tmp();
    const params = ScanParams.parse({ roots: [root] });
    let t = Date.parse("2026-11-20T00:00:00Z");

    const first = await scanNodeModules(params, ctx(state), { fetch: osv(["MAL-2024-1", "GHSA-xxxx"]), now: () => t });
    expect(first.status).toBe("findings");
    expect(first.summary).toContain("2 hashed");
    expect(JSON.stringify(first.details)).toContain("MAL-2024-1");
    expect(JSON.stringify(first.details)).not.toContain("GHSA");

    // Next day (before the 1-day backoff expires... just under): no file is read, no OSV call, finding still reported.
    t += DAY - 1000;
    const failFetch = (async () => { throw new Error("should not be called"); }) as unknown as typeof fetch;
    const second = await scanNodeModules(params, ctx(state), { fetch: failFetch, now: () => t });
    expect(second.summary).toContain("0 hashed, 2 unchanged");
    expect(second.status).toBe("findings");

    // Due again: rehashed, gap doubles to 2 days.
    t += 2000;
    const third = await scanNodeModules(params, ctx(state), { fetch: osv(["MAL-2024-1"]), now: () => t });
    expect(third.summary).toContain("2 hashed");
    t += DAY + 1000;
    expect((await scanNodeModules(params, ctx(state), { fetch: failFetch, now: () => t })).summary).toContain("0 hashed");
  });

  it("rehashes changed files immediately and matches known-bad hashes, including cached ones", async () => {
    const { root, file } = project();
    const state = tmp();
    const t = Date.parse("2026-11-20T00:00:00Z");
    const params = ScanParams.parse({ roots: [root], osv: false });
    expect((await scanNodeModules(params, ctx(state), { now: () => t })).status).toBe("ok");

    // A new IoC list that names the (unchanged, cached) file applies without rehashing it.
    const ioc = join(tmp(), "ioc.txt");
    writeFileSync(ioc, `# list\n${sha("console.log('x')")}  evil\n`);
    const hit = await scanNodeModules({ ...params, iocHashFile: ioc }, ctx(state), { now: () => t + 1000 });
    expect(hit.status).toBe("findings");
    expect(hit.summary).toContain("0 hashed");

    // Edited file (new size) is hashed right away.
    writeFileSync(file, "console.log('changed!!')");
    utimesSync(file, new Date(), new Date(t / 1000 + 60));
    const changed = await scanNodeModules(params, ctx(state), { now: () => t + 2000 });
    expect(changed.summary).toContain("1 hashed");
  });

  it("backs off 1,2,4... days up to the cap", () => {
    const p = { recheckBaseDays: 1, maxRecheckDays: 10 };
    expect([0, 1, 2, 3, 4, 5].map((k) => backoffMs(k, p) / DAY)).toEqual([1, 2, 4, 8, 10, 10]);
  });
});

describe("extension api", () => {
  const dir = tmp();
  const sched = new Scheduler({ stateDir: dir, projectsRoot: "/x", jobs: [] });
  const ext = new ExtensionStore(dir);
  const call = (method: string, pathname: string, body: Record<string, unknown> = {}, extra: { authorization?: string; fromUi?: boolean } = {}) =>
    handleScheduleRoute(sched, ext, { method, pathname, body, fromUi: false, ...extra })!;

  const action = { id: "a1", matchUrl: "https://bank.example/accounts/*", contains: "Balance", request: { path: "/api/balance?x=1" }, storeAs: "bank-balance" };

  it("only the web UI may change config, and the extension needs the token", () => {
    expect(call("PUT", "/api/ext/actions", { actions: [action] }).status).toBe(403);
    expect(call("GET", "/api/ext/config").status).toBe(401);
    expect(call("PUT", "/api/ext/actions", { actions: [action] }, { fromUi: true }).status).toBe(200);
    const token = (call("POST", "/api/ext/token", {}, { fromUi: true }).body as { token: string }).token;
    const auth = { authorization: `Bearer ${token}` };
    expect(call("GET", "/api/ext/config", {}, { authorization: "Bearer wrong" }).status).toBe(401);
    expect((call("GET", "/api/ext/config", {}, auth).body as { actions: unknown[] }).actions).toHaveLength(1);

    const up = call("POST", "/api/ext/result", { actionId: "a1", name: "bank-balance", url: "https://bank.example/api/balance", status: 200, contentType: "application/json", body: '{"b":1}' }, auth);
    expect(up.status).toBe(200);
    const got = call("GET", "/api/ext/collected/bank-balance");
    expect(got.raw?.text).toBe('{"b":1}');
  });

  it("rejects cross-origin request paths, bad names and bad patterns", () => {
    const bad = (patch: object) => call("PUT", "/api/ext/actions", { actions: [{ ...action, ...patch }] }, { fromUi: true }).status;
    expect(bad({ request: { path: "https://evil.example/x" } })).toBe(400);
    expect(bad({ request: { path: "//evil.example/x" } })).toBe(400);
    expect(bad({ storeAs: "../../etc/passwd" })).toBe(400);
    expect(bad({ matchUrl: "bank.example/*" })).toBe(400);
    expect(bad({ contains: "(" })).toBe(400);
    expect(call("GET", "/api/ext/collected/..%2F..%2Fx").status).toBe(404);
  });
});
