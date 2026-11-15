import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { Manifest } from "../schema.js";
import { createT3Pairing, doctor } from "../ops.js";
import { buildProvisionSteps, checkAuthStatus, runProvision } from "../provision/steps.js";
import { collectUsage } from "../usage/collector.js";
import { pickProvider, type TaskComplexity } from "../usage/router.js";
import { type ProviderName, UsageSnapshotSchema } from "../usage/schema.js";
import { listProjects, scanContext } from "../context/inventory.js";
import { getSession, listSessions, windowTotals } from "../sessions/parse.js";
import { annotateWithOllama, deterministicFlags } from "../sessions/analyze.js";
import { buildOverview, loadStories, renderDigest } from "../sessions/digest.js";
import { storyForFile } from "../sessions/story.js";
import { listSessionFiles, defaultSources } from "../sessions/parse.js";
import { executeTask } from "../worker/runner.js";
import { loadTaskRecords, taskStorePath, upsertTaskRecord } from "../worker/taskStore.js";
import { buildPackage, pushRepo, readPackageApiDts, scanPackages, scanRepos, togglePackageLink } from "../packages/hub.js";
import { summarizeAllRepos, summarizeRepo } from "../git/repoSummary.js";
import { RepoActionError } from "../git/repoResolve.js";
import { handleRepoRoute, matchRepoRoute } from "../git/repoActions.js";
import type { ForgeState, ServiceStatus, TaskRecord } from "../state/forgeState.js";

export interface ServiceController {
  listTargets: () => { name: string; port: number; branch: string; state?: "starting" | "running" | "stopped" }[];
  controlTarget: (name: string, action: "start" | "stop" | "restart") => Promise<{ ok: boolean; detail: string }>;
  syncWorktrees: () => Promise<string[]>;
}

export interface ForgeApiContext {
  manifest: Manifest;
  projectsRoot: string;
  stateDir: string;
  webDistDir: string;
  services: ServiceController;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

/** Like readJsonBody, but capped at `limit` bytes and returns null for oversized or malformed JSON objects. */
async function readJsonObjectLimited(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function tailLog(logPath: string, lines = 200): string {
  if (!existsSync(logPath)) return `(no log file at ${logPath})`;
  const text = readFileSync(logPath, "utf8");
  const all = text.split(/\r?\n/);
  return all.slice(-lines).join("\n");
}

function buildCoreServices(manifest: Manifest): ServiceStatus[] {
  return manifest.services
    .filter((s) => s.name !== "preview")
    .map((s) => ({
      id: s.name,
      name: s.description || s.name,
      kind: "core" as const,
      port: s.port,
      state: "unknown" as const,
      logFile: `/var/log/${s.name}.log`,
    }));
}

export class ForgeStateHub {
  private version = 1;
  private state: ForgeState;
  private listeners = new Set<(state: ForgeState) => void>();

  constructor(private ctx: ForgeApiContext) {
    this.state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      hostname: ctx.manifest.network.tailscaleHostname,
      integrationBranch: ctx.manifest.git.integrationBranch,
      services: buildCoreServices(ctx.manifest),
      diagnostics: { checkedAt: new Date(0).toISOString(), checks: [] },
      auth: { checkedAt: new Date(0).toISOString(), items: [] },
      usage: this.readCachedUsage(),
      repos: [],
      packages: [],
      tasks: loadTaskRecords(taskStorePath(ctx.stateDir)),
    };
  }

  private readCachedUsage() {
    const cacheFile = join(this.ctx.stateDir, "usage.json");
    if (!existsSync(cacheFile)) return null;
    try {
      return UsageSnapshotSchema.parse(JSON.parse(readFileSync(cacheFile, "utf8")));
    } catch {
      return null;
    }
  }

  getState(): ForgeState {
    return this.state;
  }

  subscribe(fn: (s: ForgeState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private commit(patch: Partial<ForgeState>) {
    this.version += 1;
    this.state = {
      ...this.state,
      ...patch,
      version: this.version,
      updatedAt: new Date().toISOString(),
    };
    for (const fn of this.listeners) fn(this.state);
  }

  async refreshFast(): Promise<ForgeState> {
    const previews: ServiceStatus[] = this.ctx.services.listTargets().map((t) => ({
      id: t.name,
      name: t.name,
      kind: "preview",
      port: t.port,
      branch: t.branch,
      state: t.state ?? "starting",
      logFile: `/var/log/preview-${t.name}.log`,
    }));
    const repos = await scanRepos(this.ctx.projectsRoot);
    const packages = scanPackages(this.ctx.projectsRoot, repos);
    const tasks = loadTaskRecords(taskStorePath(this.ctx.stateDir));
    this.commit({
      services: [...previews, ...buildCoreServices(this.ctx.manifest)],
      repos,
      packages,
      tasks,
      usage: this.readCachedUsage() ?? this.state.usage,
    });
    return this.state;
  }

  refreshDiagnostics(): ForgeState {
    const now = new Date().toISOString();
    const checks = doctor(this.ctx.manifest);
    const auth = checkAuthStatus(this.ctx.manifest).map((a) => ({
      name: a.service,
      ok: a.ok,
      detail: a.ok ? "authenticated" : "missing",
      fix: a.fix,
    }));
    this.commit({
      diagnostics: { checkedAt: now, checks },
      auth: { checkedAt: now, items: auth },
    });
    return this.state;
  }

  async refreshUsage(): Promise<ForgeState> {
    const usage = await collectUsage(this.ctx.manifest, this.ctx.stateDir);
    this.commit({ usage });
    return this.state;
  }

  async dispatchTask(repoDir: string, prompt: string, complexity: TaskComplexity): Promise<TaskRecord> {
    const id = `task-${Date.now().toString(36)}`;
    const record: TaskRecord = {
      id,
      repoDir,
      prompt,
      complexity,
      status: "running",
      startedAt: new Date().toISOString(),
      merged: false,
      attempts: [],
    };
    const storeFile = taskStorePath(this.ctx.stateDir);
    this.commit({ tasks: upsertTaskRecord(record, storeFile) });

    void (async () => {
      const snap = this.state.usage ?? (await collectUsage(this.ctx.manifest, this.ctx.stateDir));
      const outcome = await executeTask(this.ctx.manifest, snap, { id, repoDir, prompt, complexity });
      const done: TaskRecord = {
        ...record,
        status: outcome.ok ? "passed" : "failed",
        finishedAt: new Date().toISOString(),
        merged: outcome.merged,
        prUrl: outcome.prUrl,
        error: outcome.error,
        attempts: outcome.attempts,
      };
      this.commit({ tasks: upsertTaskRecord(done, storeFile) });
    })();

    return record;
  }
}

const SESSION_COVERAGE = [
  { source: "T3 provider logs / Claude transcripts", tokens: true, mcp: true, note: "exact per-step usage and tool calls" },
  { source: "Antigravity CLI", tokens: false, mcp: false, note: "logs are HTTP/config debug output; conversations are binary protobuf, so no per-step data is available" },
  { source: "OpenCode (Ollama)", tokens: false, mcp: false, note: "no session logs are written" },
];

function contextProjects(ctx: ForgeApiContext): string[] {
  return listProjects(ctx.projectsRoot, [existsSync("/opt/the-forge") ? "/opt/the-forge" : process.cwd()]);
}

export function createForgeRequestHandler(ctx: ForgeApiContext, hub: ForgeStateHub) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (req.method === "GET" && pathname === "/api/state") {
        await hub.refreshFast();
        return sendJson(res, 200, hub.getState());
      }

      if (req.method === "GET" && pathname === "/api/git/repos") {
        // ?repo=<name> summarises just that repo (after an action); ?refresh=1 is an explicit user refresh that
        // bypasses the per-repo `git fetch` throttle and the gh cache.
        const opts = {
          mainBranch: ctx.manifest.git.mainBranch,
          integrationBranch: ctx.manifest.git.integrationBranch,
          refresh: url.searchParams.get("refresh") === "1",
        };
        const one = url.searchParams.get("repo");
        let repos;
        try {
          repos = one !== null ? [await summarizeRepo(ctx.projectsRoot, one, opts)] : await summarizeAllRepos(ctx.projectsRoot, opts);
        } catch (e) {
          if (e instanceof RepoActionError) return sendJson(res, e.status, { ok: false, error: e.message, detail: e.message });
          throw e;
        }
        return sendJson(res, 200, { repos, generatedAt: new Date().toISOString() });
      }

      // Per-repo Git detail page: /api/git/repo/<name>/<action> (see src/git/repoActions.ts for the route table).
      const repoRoute = matchRepoRoute(pathname);
      if (repoRoute) {
        const body = req.method === "POST" ? await readJsonObjectLimited(req) : {};
        if (body === null) return sendJson(res, 400, { ok: false, error: "invalid JSON body", detail: "body must be a JSON object under 1MB" });
        const r = await handleRepoRoute(
          {
            projectsRoot: ctx.projectsRoot,
            mainBranch: ctx.manifest.git.mainBranch,
            integrationBranch: ctx.manifest.git.integrationBranch,
            model: ctx.manifest.ollama.primaryModel,
          },
          { method: req.method ?? "GET", name: repoRoute.name, action: repoRoute.action, query: url.searchParams, body },
        );
        return sendJson(res, r.status, r.body);
      }

      if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(hub.getState())}\n\n`);
        const unsub = hub.subscribe((s) => {
          res.write(`data: ${JSON.stringify(s)}\n\n`);
        });
        const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
        req.on("close", () => {
          unsub();
          clearInterval(keepAlive);
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/logs/")) {
        const name = pathname.slice("/api/logs/".length).replace(/[^a-zA-Z0-9._-]/g, "");
        const lines = Number(url.searchParams.get("tail") ?? "200") || 200;
        const known = hub.getState().services.find((s) => s.id === name || s.name === name);
        const logPath = known?.logFile ?? `/var/log/preview-${name}.log`;
        return sendJson(res, 200, { name, logPath, content: tailLog(logPath, lines) });
      }

      if (req.method === "GET" && pathname === "/api/context/projects") {
        return sendJson(res, 200, { projects: contextProjects(ctx) });
      }

      if (req.method === "GET" && pathname === "/api/context") {
        const project = url.searchParams.get("project") ?? "";
        // Only directories we list ourselves: never an arbitrary caller-supplied path.
        if (!contextProjects(ctx).includes(project)) return sendJson(res, 404, { error: `unknown project: ${project}` });
        return sendJson(res, 200, scanContext(project));
      }

      if (req.method === "GET" && pathname === "/api/sessions") {
        const claudeWeekly = hub.getState().usage?.entries.find((e) => e.provider === "claude" && e.scope === "weekly");
        return sendJson(res, 200, {
          sessions: listSessions(),
          week: windowTotals(),
          claudeWeeklyRemainingPct: claudeWeekly?.remainingPct ?? null,
          coverage: SESSION_COVERAGE,
        });
      }

      if (req.method === "GET" && pathname === "/api/sessions/overview") {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
        const stories = loadStories(days);
        return sendJson(res, 200, { overview: buildOverview(stories, days) });
      }

      if (req.method === "GET" && pathname === "/api/sessions/digest") {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
        const redact = url.searchParams.get("redact") === "1";
        const stories = loadStories(days, { redact });
        return sendJson(res, 200, { markdown: renderDigest(stories, buildOverview(stories, days), { redact }) });
      }

      if (req.method === "GET" && pathname.startsWith("/api/sessions/") && pathname.endsWith("/story")) {
        const id = pathname.slice("/api/sessions/".length, -"/story".length).replace(/[^a-zA-Z0-9._-]/g, "");
        const f = id.length >= 8 ? listSessionFiles(defaultSources()).find((x) => x.file.includes(id)) : undefined;
        if (!f) return sendJson(res, 404, { error: `session not found: ${id}` });
        return sendJson(res, 200, { story: storyForFile(f.file, f.source) });
      }

      if (req.method === "GET" && pathname.startsWith("/api/sessions/")) {
        const id = pathname.slice("/api/sessions/".length).replace(/[^a-zA-Z0-9._-]/g, "");
        const detail = getSession(id);
        if (!detail) return sendJson(res, 404, { error: `session not found: ${id}` });
        return sendJson(res, 200, { session: detail, flags: deterministicFlags(detail), week: windowTotals() });
      }

      if (req.method === "POST" && pathname === "/api/actions/session-analyze") {
        const body = await readJsonBody<{ id: string }>(req);
        const detail = getSession(body.id ?? "");
        if (!detail) return sendJson(res, 404, { error: "session not found" });
        return sendJson(res, 200, await annotateWithOllama(detail, { model: ctx.manifest.ollama.primaryModel }));
      }

      if (req.method === "GET" && pathname === "/api/packages/api") {
        const pkgName = url.searchParams.get("name") ?? "";
        const content = readPackageApiDts(ctx.projectsRoot, pkgName);
        if (!content) return sendJson(res, 404, { error: `API.d.ts not found for ${pkgName}` });
        return sendJson(res, 200, { name: pkgName, content });
      }

      if (req.method === "POST" && pathname === "/api/actions/service") {
        const body = await readJsonBody<{ name: string; action: "start" | "stop" | "restart" }>(req);
        const result = await ctx.services.controlTarget(body.name, body.action);
        await hub.refreshFast();
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && pathname === "/api/actions/t3-pair") {
        const result = createT3Pairing(ctx.manifest);
        return sendJson(res, result.ok ? 200 : 500, result.ok ? result.pairing : { detail: result.detail });
      }

      if (req.method === "POST" && pathname === "/api/actions/doctor") {
        const state = hub.refreshDiagnostics();
        return sendJson(res, 200, { diagnostics: state.diagnostics, auth: state.auth });
      }

      if (req.method === "POST" && pathname === "/api/actions/usage-refresh") {
        const state = await hub.refreshUsage();
        return sendJson(res, 200, { usage: state.usage });
      }

      if (req.method === "POST" && pathname === "/api/actions/route-sim") {
        const body = await readJsonBody<{ complexity?: TaskComplexity; modelHint?: string; exclude?: ProviderName[] }>(req);
        const snap = hub.getState().usage ?? (await collectUsage(ctx.manifest, ctx.stateDir));
        const decision = pickProvider(ctx.manifest, snap, {
          complexity: body.complexity ?? "normal",
          modelHint: body.modelHint || undefined,
          exclude: body.exclude,
        });
        return sendJson(res, 200, decision);
      }

      if (req.method === "POST" && pathname === "/api/actions/package-link") {
        const body = await readJsonBody<{ pkg: string; consumer: string; enable: boolean }>(req);
        const result = await togglePackageLink(ctx.projectsRoot, body.pkg, body.consumer, body.enable);
        await hub.refreshFast();
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && pathname === "/api/actions/package-build") {
        const body = await readJsonBody<{ pkg: string }>(req);
        const result = await buildPackage(ctx.projectsRoot, body.pkg);
        await hub.refreshFast();
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && pathname === "/api/actions/repo-push") {
        const body = await readJsonBody<{ repo: string }>(req);
        if (!body.repo) return sendJson(res, 400, { error: "repo is required" });
        const result = await pushRepo(ctx.projectsRoot, body.repo);
        await hub.refreshFast();
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (req.method === "POST" && pathname === "/api/actions/sync") {
        const updated = await ctx.services.syncWorktrees();
        await hub.refreshFast();
        return sendJson(res, 200, { ok: true, updated });
      }

      if (req.method === "POST" && pathname === "/api/actions/provision") {
        const outcomes = runProvision(buildProvisionSteps(ctx.manifest));
        hub.refreshDiagnostics();
        return sendJson(res, 200, { ok: outcomes.every((o) => o.status !== "failed"), outcomes });
      }

      if (req.method === "POST" && pathname === "/api/actions/dispatch") {
        const body = await readJsonBody<{ repoDir: string; prompt: string; complexity?: TaskComplexity }>(req);
        if (!body.repoDir || !body.prompt) return sendJson(res, 400, { error: "repoDir and prompt are required" });
        const record = await hub.dispatchTask(body.repoDir, body.prompt, body.complexity ?? "normal");
        return sendJson(res, 202, { ok: true, task: record });
      }

      // Static web UI serving (from web/dist)
      const distRoot = resolve(ctx.webDistDir);
      const safeRel = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
      const candidate = resolve(distRoot, safeRel);
      const filePath =
        candidate.startsWith(distRoot) && existsSync(candidate) && statSync(candidate).isFile()
          ? candidate
          : join(distRoot, "index.html");

      if (existsSync(filePath)) {
        const ext = extname(filePath);
        res.writeHead(200, { "content-type": MIME_TYPES[ext] ?? "application/octet-stream" });
        res.end(readFileSync(filePath));
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><h1>The Forge API</h1><p>Build the web UI in <code>the-forge/web</code> (<code>npm run build</code>).</p>");
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}
