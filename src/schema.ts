import { z } from "zod";

/** Single source of truth for the sandbox. Everything in `generated/` derives from this. */
export const ManifestSchema = z.object({
  projectName: z.string().default("ai-sandbox"),
  containerName: z.string().default("ai_dev_sandbox"),
  /** Allow agents inside the container to edit `the-forge` and recreate the container via Docker socket. */
  selfRebuild: z.boolean().default(true),

  network: z.object({
    /** Tailscale node name; the container is its own tailnet node. */
    tailscaleHostname: z.string(),
    tailscaleTag: z.string().regex(/^tag:/),
    /** Env var (in .env) that holds the Tailscale auth key. */
    authKeyEnv: z.string().default("TS_AUTHKEY"),
  }),

  paths: z.object({
    /** Windows path of this `the-forge` repo (mounted at /opt/the-forge). */
    forgeDir: z.string(),
    /** Windows path of the meta repo (rules/skills/tools/plugins are bind-mounted live from here). */
    metaDir: z.string(),
    /** Windows path of the buddy.env secrets file (mounted read-only). */
    buddyEnvFile: z.string(),
    /** Old bind-mounted workspace on Windows; only read by `migrate-check`. */
    legacySandboxDir: z.string().optional(),
    /** Non-repo directories in legacySandboxDir that should be ignored by `migrate-check`. */
    ignoredLegacyDirs: z.array(z.string()).default([]),
  }),

  /** Web previews managed by `the-forge preview` (always-on `ai-work` dev servers). */
  previews: z
    .array(
      z.object({
        name: z.string(),
        port: z.number().int().positive(),
        command: z.string(),
      }),
    )
    .default([]),

  /** Repos cloned into the repos volume by `clone`. URLs must NOT contain credentials. */
  repos: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().regex(/^https:\/\/github\.com\/[^@/]+\/[^@]+$/, "use a plain https://github.com/... URL with no credentials"),
      }),
    )
    .default([]),

  /** Web services reachable on the tailnet. `caddyPath` exposes them via the preview proxy. */
  services: z.array(
    z.object({
      name: z.string(),
      port: z.number().int().positive(),
      description: z.string(),
      caddyPath: z.string().optional(),
      /** Command run by the entrypoint to start it (informational for SETUP.md). */
      start: z.string().optional(),
    }),
  ),

  volumes: z.record(z.string(), z.object({ mount: z.string(), description: z.string() })),

  ollama: z.object({
    primaryModel: z.string(),
    extraModels: z.array(z.string()).default([]),
    keepAlive: z.string().default("24h"),
    flashAttention: z.boolean().default(true),
    kvCacheType: z.string().default("q8_0"),
    numParallel: z.number().int().default(1),
  }),

  toolchain: z.object({
    cudaImage: z.string(),
    dotnetChannel: z.string(),
    nodeMajor: z.number().int(),
    godotVersion: z.string(),
    pythonVersion: z.string(),
  }),

  git: z.object({
    mainBranch: z.string().default("main"),
    integrationBranch: z.string().default("ai-work"),
    taskBranchPrefix: z.string().default("task/"),
    reposVolume: z.string().default("repos"),
  }),

  providers: z.array(
    z.object({
      name: z.enum(["ollama", "antigravity", "claude"]),
      /** Lower = preferred when all else is equal. */
      priority: z.number().int(),
      usageCommand: z.string().optional(),
    }),
  ),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function defineManifest(input: z.input<typeof ManifestSchema>): Manifest {
  return ManifestSchema.parse(input);
}
