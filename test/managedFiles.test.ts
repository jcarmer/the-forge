import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFile, installRules, isFileCurrent, isRulesCurrent } from "../src/provision/steps.js";

describe("repo-managed file provisioning", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "helper-script-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs when the destination is missing, then reports current", () => {
    const src = join(dir, "src.py");
    const dest = join(dir, "nested", "dest.py");
    writeFileSync(src, "v1");
    expect(isFileCurrent(src, dest)).toBe(false);
    installFile(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("v1");
    expect(isFileCurrent(src, dest)).toBe(true);
  });

  it("detects a changed repo copy and overwrites the installed one", () => {
    const src = join(dir, "src.py");
    const dest = join(dir, "dest.py");
    writeFileSync(src, "v1");
    installFile(src, dest);
    writeFileSync(src, "v2");
    expect(isFileCurrent(src, dest)).toBe(false);
    installFile(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("v2");
  });

  it("treats a missing repo copy as nothing to do", () => {
    expect(isFileCurrent(join(dir, "absent.py"), join(dir, "dest.py"))).toBe(true);
  });

  it("installs only the rules the repo ships and leaves other rules untouched", () => {
    const src = join(dir, "repo-rules");
    const dest = join(dir, "meta-rules");
    mkdirSync(src);
    mkdirSync(dest);
    writeFileSync(join(src, "02-ollama.md"), "new");
    writeFileSync(join(src, "notes.txt"), "not a rule");
    writeFileSync(join(dest, "02-ollama.md"), "old hand edit");
    writeFileSync(join(dest, "01-common.md"), "user's own rule");
    expect(isRulesCurrent(src, dest)).toBe(false);
    installRules(src, dest);
    expect(readFileSync(join(dest, "02-ollama.md"), "utf8")).toBe("new");
    expect(readFileSync(join(dest, "01-common.md"), "utf8")).toBe("user's own rule");
    expect(existsSync(join(dest, "notes.txt"))).toBe(false);
    expect(isRulesCurrent(src, dest)).toBe(true);
  });

  it("recreates a missing rules directory (fresh machine)", () => {
    const src = join(dir, "repo-rules");
    mkdirSync(src);
    writeFileSync(join(src, "02-ollama.md"), "x");
    const dest = join(dir, "does", "not", "exist");
    expect(isRulesCurrent(src, dest)).toBe(false);
    installRules(src, dest);
    expect(readFileSync(join(dest, "02-ollama.md"), "utf8")).toBe("x");
  });
});
