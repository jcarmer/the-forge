import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJsonAtomic } from "../schedule/store.js";

/** Chrome match pattern, e.g. https://example.com/account/*  (scheme://host/path, `*` wildcards). */
export const MATCH_PATTERN = /^(https?|\*):\/\/(\*|\*\.[^/*]+|[^/*]+)\/.*$/;
export const COLLECTED_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_RESULT_BYTES = 5 * 1024 * 1024;

const regexString = z.string().max(500).refine((s) => {
  try { new RegExp(s); return true; } catch { return false; }
}, "not a valid regular expression");

/**
 * A configuration-only action. The extension does exactly these steps and nothing else:
 *   1. a tab finishes loading a URL matching `matchUrl`
 *   2. (optional) the page text must match the regex `contains`
 *   3. fetch `request.path` on that same site, with the user's logged-in cookies
 *   4. send the raw response to the Forge, saved under `storeAs`
 */
export const ExtActionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(100).default(""),
  enabled: z.boolean().default(true),
  matchUrl: z.string().regex(MATCH_PATTERN, "use a pattern like https://example.com/account/*"),
  contains: regexString.optional(),
  request: z.object({
    /** Path (and query) on the page's own origin. Never a full URL, so a request can only go to the site the user is on. */
    path: z.string().regex(/^\/(?!\/)/, "must start with a single /").max(2000),
    method: z.enum(["GET", "POST"]).default("GET"),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().max(100_000).optional(),
  }),
  storeAs: z.string().regex(COLLECTED_NAME, "lowercase letters, digits, . _ - (max 64)"),
  /** Do not run this action again for the same browser within this many minutes. */
  minIntervalMinutes: z.number().int().min(1).max(525_600).default(60),
});
export type ExtAction = z.infer<typeof ExtActionSchema>;

export const ResultSchema = z.object({
  actionId: z.string().max(64),
  name: z.string().regex(COLLECTED_NAME),
  url: z.string().max(2100),
  status: z.number().int(),
  contentType: z.string().max(200).default(""),
  body: z.string(),
});

export interface CollectedMeta {
  name: string;
  actionId: string;
  url: string;
  status: number;
  contentType: string;
  bytes: number;
  receivedAt: string;
}

export class ExtensionStore {
  constructor(private stateDir: string) {}

  private get actionsFile() { return join(this.stateDir, "ext-actions.json"); }
  private get tokenFile() { return join(this.stateDir, "ext-token"); }
  private get collectedDir() { return join(this.stateDir, "collected"); }

  actions(): ExtAction[] {
    try { return z.array(ExtActionSchema).parse(JSON.parse(readFileSync(this.actionsFile, "utf8"))); } catch { return []; }
  }

  saveActions(raw: unknown): { ok: true; actions: ExtAction[] } | { ok: false; error: string } {
    const r = z.array(ExtActionSchema).max(100).safeParse(raw);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    writeJsonAtomic(this.actionsFile, r.data);
    return { ok: true, actions: r.data };
  }

  hasToken(): boolean { return existsSync(this.tokenFile); }

  /** Makes a new token (invalidating the old one). It is shown once; the extension keeps its own copy. */
  rotateToken(): string {
    const token = randomBytes(24).toString("base64url");
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.tokenFile, token, { mode: 0o600 });
    chmodSync(this.tokenFile, 0o600);
    return token;
  }

  checkToken(header: string | undefined): boolean {
    if (!header?.startsWith("Bearer ") || !this.hasToken()) return false;
    const given = Buffer.from(header.slice(7));
    const real = Buffer.from(readFileSync(this.tokenFile, "utf8"));
    return given.length === real.length && timingSafeEqual(given, real);
  }

  saveResult(raw: unknown): { ok: true; meta: CollectedMeta } | { ok: false; error: string } {
    const r = ResultSchema.safeParse(raw);
    if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    const bytes = Buffer.byteLength(r.data.body);
    if (bytes > MAX_RESULT_BYTES) return { ok: false, error: `result is ${bytes} bytes; limit is ${MAX_RESULT_BYTES}` };
    const meta: CollectedMeta = { name: r.data.name, actionId: r.data.actionId, url: r.data.url, status: r.data.status, contentType: r.data.contentType, bytes, receivedAt: new Date().toISOString() };
    mkdirSync(this.collectedDir, { recursive: true });
    // The raw body is stored exactly as received; the name is validated above, so it cannot escape this directory.
    writeFileSync(join(this.collectedDir, `${meta.name}.body`), r.data.body);
    writeJsonAtomic(join(this.collectedDir, `${meta.name}.meta.json`), meta);
    return { ok: true, meta };
  }

  collected(): CollectedMeta[] {
    if (!existsSync(this.collectedDir)) return [];
    return readdirSync(this.collectedDir)
      .filter((f) => f.endsWith(".meta.json"))
      .flatMap((f) => { try { return [JSON.parse(readFileSync(join(this.collectedDir, f), "utf8")) as CollectedMeta]; } catch { return []; } })
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  readCollected(name: string): { meta: CollectedMeta; body: string } | null {
    if (!COLLECTED_NAME.test(name)) return null;
    try {
      return {
        meta: JSON.parse(readFileSync(join(this.collectedDir, `${name}.meta.json`), "utf8")) as CollectedMeta,
        body: readFileSync(join(this.collectedDir, `${name}.body`), "utf8"),
      };
    } catch { return null; }
  }
}
