import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPullRequest, squashMergePullRequest } from "../src/git/pullRequest.js";

// A fake `gh` on PATH: `pr list` prints $FAKE_EXISTING, `pr create` prints a URL, `pr merge` obeys $FAKE_MERGE_FAIL.
let dir: string;
let oldPath: string | undefined;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const script = `#!/bin/bash
case "$1 $2" in
  "pr list") [ -n "$FAKE_EXISTING" ] && echo "$FAKE_EXISTING"; exit 0;;
  "pr create") echo "https://github.com/o/r/pull/7"; exit 0;;
  "pr merge") [ -n "$FAKE_MERGE_FAIL" ] && { echo "blocked by branch protection"; exit 1; }; exit 0;;
esac
exit 1
`;
  writeFileSync(join(dir, "gh"), script);
  chmodSync(join(dir, "gh"), 0o755);
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
});
afterAll(() => {
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_EXISTING;
  delete process.env.FAKE_MERGE_FAIL;
});

const opts = { head: "task/x", base: "ai-work", title: "t", body: "b" };

describe("pull requests via gh", () => {
  it("opens a new PR and returns its URL", () => {
    delete process.env.FAKE_EXISTING;
    expect(openPullRequest(tmpdir(), opts)).toMatchObject({ ok: true, url: "https://github.com/o/r/pull/7" });
  });

  it("is idempotent: reuses an already-open PR", () => {
    process.env.FAKE_EXISTING = "https://github.com/o/r/pull/3";
    const r = openPullRequest(tmpdir(), opts);
    expect(r).toMatchObject({ ok: true, url: "https://github.com/o/r/pull/3" });
    delete process.env.FAKE_EXISTING;
  });

  it("reports merge failures instead of throwing", () => {
    process.env.FAKE_MERGE_FAIL = "1";
    expect(squashMergePullRequest(tmpdir(), "https://github.com/o/r/pull/7")).toMatchObject({ ok: false, merged: false });
    delete process.env.FAKE_MERGE_FAIL;
    expect(squashMergePullRequest(tmpdir(), "https://github.com/o/r/pull/7")).toMatchObject({ ok: true, merged: true });
  });
});
