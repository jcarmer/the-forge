import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveSummaryCounts, isPackageUpdateAvailable, type ForgeState } from "../src/state/forgeState.js";
import { readPackageApiDts, scanPackages, togglePackageLink } from "../src/packages/hub.js";

describe("forgeState pure functions", () => {
  it("detects package update availability without false positives on local/range specs", () => {
    expect(isPackageUpdateAvailable("0.2.0", "^0.1.0")).toBe(true);
    expect(isPackageUpdateAvailable("0.1.0", "^0.1.0")).toBe(false);
    expect(isPackageUpdateAvailable("0.2.0", "github:jcarmer/tbe-ui#v0.1.0")).toBe(true);
    expect(isPackageUpdateAvailable("0.1.0", "github:jcarmer/tbe-ui#v0.1.0")).toBe(false);
    expect(isPackageUpdateAvailable("0.2.0", "file:../tbe-ui")).toBe(false);
    expect(isPackageUpdateAvailable("0.2.0", "*")).toBe(false);
  });

  it("derives summary counts from ForgeState", () => {
    const state: ForgeState = {
      version: 1,
      updatedAt: new Date().toISOString(),
      hostname: "ai-sandbox",
      integrationBranch: "ai-work",
      services: [
        { id: "tbe", name: "tbe", kind: "preview", port: 5174, state: "running" },
        { id: "t3", name: "t3", kind: "core", port: 3773, state: "unknown" },
      ],
      diagnostics: {
        checkedAt: new Date().toISOString(),
        checks: [
          { name: "gpu", ok: true, detail: "ok" },
          { name: "tailnet", ok: false, detail: "down" },
        ],
      },
      auth: {
        checkedAt: new Date().toISOString(),
        items: [{ name: "claude", ok: false, detail: "missing" }],
      },
      usage: null,
      repos: [],
      packages: [
        { name: "@tbe/ui", version: "0.1.0", repoName: "tbe-ui", repoPath: "/projects/tbe-ui", dirty: true, unpushed: false, hasApiDts: true, consumers: [] },
      ],
      tasks: [
        { id: "t1", repoDir: "/projects/tbe", prompt: "fix", complexity: "normal", status: "running", startedAt: new Date().toISOString(), merged: false, attempts: [] },
      ],
    };

    expect(deriveSummaryCounts(state)).toEqual({
      failingChecks: 1,
      failingAuth: 1,
      dirtyPackages: 1,
      runningTasks: 1,
      runningServices: 1,
    });
  });
});

describe("package hub", () => {
  it("discovers @tbe/* packages, links/unlinks consumers, and reads API.d.ts", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-hub-"));
    try {
      const pkgDir = join(root, "tbe-ui");
      const consumerDir = join(root, "game-a");
      mkdirSync(join(pkgDir, "dist"), { recursive: true });
      mkdirSync(consumerDir, { recursive: true });

      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@tbe/ui", version: "0.2.0" }));
      writeFileSync(join(pkgDir, "dist", "API.d.ts"), "// @tbe/ui API\nexport declare const UI: {};\n");
      writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "game-a", dependencies: { "@tbe/ui": "^0.1.0" } }));

      let pkgs = scanPackages(root, []);
      expect(pkgs).toHaveLength(1);
      expect(pkgs[0]!.hasApiDts).toBe(true);
      expect(pkgs[0]!.consumers[0]!.linked).toBe(false);
      expect(pkgs[0]!.consumers[0]!.updateAvailable).toBe(true);

      const linked = await togglePackageLink(root, "@tbe/ui", "game-a", true);
      expect(linked.ok).toBe(true);
      pkgs = scanPackages(root, []);
      expect(pkgs[0]!.consumers[0]!.linked).toBe(true);

      const unlinked = await togglePackageLink(root, "@tbe/ui", "game-a", false);
      expect(unlinked.ok).toBe(true);
      pkgs = scanPackages(root, []);
      expect(pkgs[0]!.consumers[0]!.linked).toBe(false);

      expect(readPackageApiDts(root, "@tbe/ui")).toContain("export declare const UI");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
