import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspaces, mergeTiles, parseConfig, presetTiles } from "../src/dashboard/store.js";

describe("dashboard store", () => {
  it("discovers git repos and code-workspace files", () => {
    const root = mkdtempSync(join(tmpdir(), "dash-"));
    mkdirSync(join(root, "a/.git"), { recursive: true });
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "b/x.code-workspace"), "{}");
    const ids = discoverWorkspaces(root).map((t) => t.id);
    expect(ids).toEqual(["ws:a", "ws:b/x.code-workspace"]);
  });

  it("builds presets from the manifest", () => {
    const tiles = presetTiles({
      services: [{ name: "t3", port: 1, description: "d", start: "x" }, { name: "preview", port: 2, description: "", start: "x" }],
      previews: [{ name: "tbe", port: 5174, command: "pnpm dev" }],
    } as never);
    expect(tiles.map((t) => t.label)).toEqual(["T3", "TBE platform"]);
  });

  it("merges order and hidden, appends new tiles, drops unknown ids", () => {
    const mk = (id: string) => ({ id, label: id, kind: "service" as const, hidden: false });
    const out = mergeTiles([mk("a"), mk("b"), mk("c")], { order: ["c", "gone", "a"], hidden: ["a"], custom: [] });
    expect(out.map((t) => [t.id, t.hidden])).toEqual([["c", false], ["a", true], ["b", false]]);
  });

  it("rejects bad configs", () => {
    expect(parseConfig({ order: [1] })).toBeNull();
    expect(parseConfig({ custom: [{ id: "x", label: "l", url: "u" }] })).toBeNull();
    expect(parseConfig({ custom: [{ id: "custom:1", label: "l" }] })).toBeNull();
    expect(parseConfig({ custom: [{ id: "custom:1", label: "l", command: "ls" }] })?.custom).toHaveLength(1);
  });
});
