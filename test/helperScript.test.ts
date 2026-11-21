import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHelperScript, isHelperScriptCurrent } from "../src/provision/steps.js";

describe("ollama-helper script provisioning", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "helper-script-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs when the destination is missing, then reports current", () => {
    const src = join(dir, "src.py");
    const dest = join(dir, "nested", "dest.py");
    writeFileSync(src, "v1");
    expect(isHelperScriptCurrent(src, dest)).toBe(false);
    installHelperScript(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("v1");
    expect(isHelperScriptCurrent(src, dest)).toBe(true);
  });

  it("detects a changed repo copy and overwrites the installed one", () => {
    const src = join(dir, "src.py");
    const dest = join(dir, "dest.py");
    writeFileSync(src, "v1");
    installHelperScript(src, dest);
    writeFileSync(src, "v2");
    expect(isHelperScriptCurrent(src, dest)).toBe(false);
    installHelperScript(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("v2");
  });

  it("treats a missing repo copy as nothing to do", () => {
    expect(isHelperScriptCurrent(join(dir, "absent.py"), join(dir, "dest.py"))).toBe(true);
  });
});
