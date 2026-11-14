import { z } from "zod";

export const ProviderNameSchema = z.enum(["ollama", "antigravity", "claude"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const UsageScopeSchema = z.enum(["5h", "weekly", "model_weekly"]);
export type UsageScope = z.infer<typeof UsageScopeSchema>;

export const UsageEntrySchema = z.object({
  provider: ProviderNameSchema,
  scope: UsageScopeSchema,
  /** Optional bucket or model name (e.g. "Fable", "Gemini Models", "Claude and GPT models"). */
  model: z.string().optional(),
  /** Percentage remaining (0..100). */
  remainingPct: z.number().min(0).max(100),
  /** ISO-8601 UTC timestamp when this quota window resets. */
  resetsAt: z.string().datetime(),
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const UsageSnapshotSchema = z.object({
  collectedAt: z.string().datetime(),
  entries: z.array(UsageEntrySchema),
  sources: z.record(z.string(), z.enum(["deterministic", "ollama", "haiku", "manual", "error"])),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
