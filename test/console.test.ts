import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/console/run.js";
import { localChips, normalizeLine, ollamaIdeas, parseFlags, parseIdeas } from "../src/console/suggest.js";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "con-"));
  mkdirSync(join(root, "alpha/inner"), { recursive: true });
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "file.txt"), "x");
  return root;
}

describe("console suggestions", () => {
  it("expands cd shorthand", () => {
    expect(normalizeLine("cd..")).toBe("cd ..");
    expect(normalizeLine("cd...")).toBe("cd ../..");
    expect(normalizeLine("cd..../x")).toBe("cd ../../../x");
    expect(normalizeLine("cd src")).toBe("cd src");
  });

  it("lists only subdirectories for cd, with a way up first", async () => {
    const root = tree();
    const chips = await localChips({ cwd: root, line: "cd " });
    expect(chips[0].label).toBe("..");
    const labels = chips.map((c) => c.label);
    expect(labels).toContain("alpha/");
    expect(labels).not.toContain("file.txt");
    expect(labels).not.toContain(".hidden/");
    expect(chips.find((c) => c.label === "beta/")?.line).toBe("cd beta/");
  });

  it("filters by prefix and descends into subdirectories", async () => {
    const root = tree();
    expect((await localChips({ cwd: root, line: "cd al" })).map((c) => c.label)).toEqual(["alpha/"]);
    expect((await localChips({ cwd: root, line: "cd alpha/" })).map((c) => c.label)).toContain("inner/");
  });

  it("offers files for path commands", async () => {
    const root = tree();
    const chips = await localChips({ cwd: root, line: "cat f" });
    expect(chips.map((c) => c.line)).toEqual(["cat file.txt"]);
  });

  it("parses flags from help text", () => {
    const flags = parseFlags("  -a, --all   do not ignore entries\n  -l            long listing\n      --color[=WHEN]  colorize\nnot a flag line");
    expect(flags.map((f) => f.flag)).toEqual(["--all", "-l", "--color"]);
  });

  it("drops malformed and destructive model ideas", () => {
    const raw = JSON.stringify({ ideas: [{ command: "ls -la", why: "list" }, { command: "sudo rm -rf /" }, { command: "a\nb" }, { command: 5 }, { command: "ls -la" }] });
    expect(parseIdeas(raw).map((c) => c.line)).toEqual(["ls -la"]);
    expect(parseIdeas("not json")).toEqual([]);
  });

  it("reports Ollama failures without throwing", async () => {
    const r = await ollamaIdeas({ cwd: "/", line: "gi" }, { model: "m", fetchImpl: async () => { throw new Error("down"); } });
    expect(r).toMatchObject({ ok: false, chips: [] });
  });
});

describe("console run", () => {
  it("keeps cd between calls and expands shorthand", async () => {
    const root = tree();
    const a = await runCommand(root, "cd alpha/inner");
    expect(a.cwd).toBe(join(root, "alpha/inner"));
    const b = await runCommand(a.cwd, "cd..");
    expect(b.cwd).toBe(join(root, "alpha"));
    expect((await runCommand(b.cwd, "ls")).output).toBe("inner");
  });

  it("reports failures and kills runaways", async () => {
    const r = await runCommand("/", "exit 3");
    expect(r).toMatchObject({ ok: false, exitCode: 3 });
    const slow = await runCommand("/", "sleep 5", 300);
    expect(slow.ok).toBe(false);
    expect(slow.output).toContain("stopped");
  });
});
