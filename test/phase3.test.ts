import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import manifest from "../sandbox.config.js";
import { loadProjectConfig } from "../src/gate/standards.js";
import { discoverPreviews } from "../src/preview/supervisor.js";
import { checkCoderModelUpdates } from "../src/healthcheck/models.js";

const dirs: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "forge-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("project gate config & preview discovery", () => {
  it("loads .agents/project.yml commands", () => {
    const d = tempDir();
    mkdirSync(join(d, ".agents"));
    writeFileSync(join(d, ".agents", "project.yml"), "typecheck: npm run tc\ntest: vitest run\npreview: vite --host\n");
    expect(loadProjectConfig(d)).toEqual({ typecheck: "npm run tc", test: "vitest run", preview: "vite --host" });
  });

  it("falls back to package.json scripts when .agents/project.yml is absent", () => {
    const d = tempDir();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest", dev: "vite" } }));
    const cfg = loadProjectConfig(d);
    expect(cfg.build).toBe("npm run build");
    expect(cfg.test).toBe("npm test");
    expect(cfg.preview).toContain("--host 0.0.0.0");
  });

  it("discovers previewable projects and allocates sequential ports", () => {
    const root = tempDir();
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "alpha", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    writeFileSync(join(root, "beta", "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const previews = discoverPreviews(root, 5200);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ name: "alpha", branch: "ai-work", port: 5200 });
  });

  it("recommends 14B Q4 upgrade when running qwen2.5-coder:7b", async () => {
    const rec = await checkCoderModelUpdates(manifest);
    expect(rec.candidates.some((c) => c.tag.includes("14b"))).toBe(true);
  });
});
