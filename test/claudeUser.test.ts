import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installClaudeUserConfig, isClaudeUserConfigCurrent, mergeHookSettings, mergeManagedBlock } from "../src/provision/claudeUser.js";
import { checkBashCommand, MAX_CAT_BYTES } from "../ops/claude-user/bash-guard.mjs";

let root: string;
let repoDir: string;
let claudeDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cu-"));
  repoDir = join(root, "repo");
  claudeDir = join(root, "claude");
  mkdirSync(join(repoDir, "ops/claude-user"), { recursive: true });
  writeFileSync(join(repoDir, "ops/claude-user/CLAUDE.md"), "# Rules\nbe brief\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("managed CLAUDE.md block", () => {
  it("appends to existing content and replaces itself on re-run", () => {
    const once = mergeManagedBlock("# mine\n", "v1");
    expect(once).toContain("# mine");
    expect(once).toContain("v1");
    const twice = mergeManagedBlock(once, "v2");
    expect(twice).toContain("# mine");
    expect(twice).toContain("v2");
    expect(twice).not.toContain("v1");
    expect(mergeManagedBlock(twice, "v2")).toBe(twice);
  });
});

describe("settings merge", () => {
  it("keeps other settings and hooks, and does not duplicate ours", () => {
    const existing = { model: "x", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "mine.sh" }] }], Stop: [] } };
    const a = mergeHookSettings(existing, "node /r/ops/claude-user/bash-guard.mjs");
    const b = mergeHookSettings(a, "node /r/ops/claude-user/bash-guard.mjs");
    expect(b).toEqual(a);
    expect(a.model).toBe("x");
    const pre = (a.hooks as any).PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0].hooks[0].command).toBe("mine.sh");
    expect((a.hooks as any).Stop).toEqual([]);
  });
});

describe("install step", () => {
  it("installs, then reports current; re-installs after the volume is wiped", () => {
    const p = { repoDir, claudeDir };
    expect(isClaudeUserConfigCurrent(p)).toBe(false);
    installClaudeUserConfig(p);
    expect(isClaudeUserConfigCurrent(p)).toBe(true);
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toContain("be brief");
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toContain("bash-guard.mjs");
    rmSync(claudeDir, { recursive: true, force: true });
    expect(isClaudeUserConfigCurrent(p)).toBe(false);
    installClaudeUserConfig(p);
    expect(isClaudeUserConfigCurrent(p)).toBe(true);
  });

  it("refuses to overwrite a settings.json it cannot parse", () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{ not json");
    expect(() => installClaudeUserConfig({ repoDir, claudeDir })).toThrow();
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe("{ not json");
  });

  it("picks up a changed guidance file", () => {
    const p = { repoDir, claudeDir };
    installClaudeUserConfig(p);
    writeFileSync(join(repoDir, "ops/claude-user/CLAUDE.md"), "# Rules\nnew rule\n");
    expect(isClaudeUserConfigCurrent(p)).toBe(false);
  });
});

describe("bash guard", () => {
  it("blocks unbounded recursive grep but allows bounded ones", () => {
    expect(checkBashCommand("grep -rn foo src")).toMatch(/Blocked/);
    expect(checkBashCommand("cd x && grep -R foo .")).toMatch(/Blocked/);
    expect(checkBashCommand("grep -rn foo src | head -20")).toBeNull();
    expect(checkBashCommand("grep -rl foo src")).toBeNull();
    expect(checkBashCommand("grep -rn foo src -m 3")).toBeNull();
    expect(checkBashCommand("grep foo file.txt")).toBeNull();
    expect(checkBashCommand("grep -rn foo src # allow-unbounded")).toBeNull();
  });

  it("blocks cat of large files only, and ignores heredocs and pipes", () => {
    const big = join(root, "big.log");
    const small = join(root, "small.txt");
    writeFileSync(big, "x".repeat(MAX_CAT_BYTES + 10));
    writeFileSync(small, "hi");
    expect(checkBashCommand(`cat ${big}`)).toMatch(/Blocked/);
    expect(checkBashCommand("cat big.log", root)).toMatch(/Blocked/);
    expect(checkBashCommand(`cat ${small}`)).toBeNull();
    expect(checkBashCommand(`cat ${big} | head -5`)).toBeNull();
    expect(checkBashCommand(`cat > ${join(root, "out.txt")} <<'EOF'\nhello\nEOF`)).toBeNull();
    expect(checkBashCommand("cat does-not-exist.txt", root)).toBeNull();
    expect(checkBashCommand(`cat ${big}`, root, { FORGE_BASH_GUARD: "off" })).toBeNull();
  });

  it("works as a real hook process: exit 2 with a reason, exit 0 otherwise or on bad input", () => {
    const script = join(process.cwd(), "ops/claude-user/bash-guard.mjs");
    const hook = (stdin: string) => spawnSync("node", [script], { input: stdin, encoding: "utf8" });
    const blocked = hook(JSON.stringify({ tool_input: { command: "grep -rn foo ." }, cwd: root }));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/Blocked/);
    expect(hook(JSON.stringify({ tool_input: { command: "ls" }, cwd: root })).status).toBe(0);
    expect(hook("garbage").status).toBe(0);
  });
});
