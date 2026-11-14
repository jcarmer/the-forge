import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanContext, describeMcp, parseFrontmatter, findImports } from "../src/context/inventory.js";

let base: string;
let home: string;
let proj: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ctx-"));
  home = join(base, "home");
  proj = join(base, "projects", "app");
  mkdirSync(join(proj, ".claude", "skills", "local-skill"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "global-skill"), { recursive: true });
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  writeFileSync(join(proj, "CLAUDE.md"), "@docs/GUIDE.md\n@docs/missing.md\n# hi\n");
  mkdirSync(join(proj, "docs"));
  writeFileSync(join(proj, "docs", "GUIDE.md"), "guide text");
  writeFileSync(join(proj, ".claude", "skills", "local-skill", "SKILL.md"), "---\nname: dup\ndescription: local one\n---\nbody");
  writeFileSync(join(home, ".claude", "skills", "global-skill", "SKILL.md"), "---\nname: dup\ndescription: global one\n---\nbody");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["srv", "--token", "ghp_SECRET123"], env: { API_KEY: "topsecret" } } }, projects: { [proj]: { mcpServers: { gh: { url: "https://u:p@example.com/mcp?key=abc" } } } } }));
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { allow: ["Bash(ls)"] } }));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("context inventory", () => {
  it("finds guidance, follows @imports, and warns about a missing import", () => {
    const r = scanContext(proj, home);
    expect(r.items.filter((i) => i.kind === "guidance").map((i) => i.name).sort()).toEqual(["CLAUDE.md", "GUIDE.md"]);
    expect(r.warnings.some((w) => w.includes("missing.md"))).toBe(true);
  });

  it("lists skills by frontmatter name and flags duplicates across scopes", () => {
    const r = scanContext(proj, home);
    expect(r.items.filter((i) => i.kind === "skill")).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('skill "dup"'))).toBe(true);
  });

  it("never leaks MCP secrets", () => {
    const json = JSON.stringify(scanContext(proj, home));
    for (const secret of ["ghp_SECRET123", "topsecret", "u:p@", "key=abc"]) expect(json).not.toContain(secret);
    expect(json).toContain("API_KEY");
  });

  it("reports settings summaries and the same MCP name in two places", () => {
    const r = scanContext(proj, home);
    expect(r.items.find((i) => i.kind === "setting")?.detail).toContain("hooks: PreToolUse");
    expect(r.warnings.some((w) => w.includes('MCP server "gh"'))).toBe(true);
  });

  it("helpers", () => {
    expect(parseFrontmatter("---\nname: x\ndescription: \"d\"\n---\n")).toEqual({ name: "x", description: "d" });
    expect(findImports("@a/b.md\ntext\n", "/x/CLAUDE.md")).toEqual(["/x/a/b.md"]);
    expect(describeMcp({ command: "c", args: ["--api-key=zzz", "ok"] })).toBe("c --api-key=*** ok");
  });
});
