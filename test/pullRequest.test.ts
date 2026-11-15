import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPullRequest, openPullRequestAsync, squashMergePullRequest, squashMergePullRequestAsync } from "../src/git/pullRequest.js";

// A fake `gh` on PATH: `pr list` prints $FAKE_EXISTING, `pr create` prints a URL, `pr merge` obeys $FAKE_MERGE_FAIL.
// `repo edit` records to $FAKE_EDIT_LOG and exits 1 (must never be called).
let dir: string;
let oldPath: string | undefined;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const script = `#!/bin/bash
case "$1 $2" in
  "repo edit") echo "$*" >> "\${FAKE_EDIT_LOG:-/dev/null}"; echo "Must have admin rights"; exit 1;;
  "pr list") [ -n "$FAKE_EXISTING" ] && echo "$FAKE_EXISTING"; exit 0;;
  "pr create")
    [ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
    if [ -n "$FAKE_REQUIRE_NOPROMPT" ] && { [ "$GH_PROMPT_DISABLED" != 1 ] || [ "$GIT_TERMINAL_PROMPT" != 0 ]; }; then echo "would prompt"; exit 1; fi
    echo "https://github.com/o/r/pull/7"; exit 0;;
  "pr merge")
    echo "$*" >> "\${FAKE_MERGE_LOG:-/dev/null}"
    [ -n "$FAKE_MERGE_FAIL" ] && { echo "blocked by branch protection"; exit 1; }
    echo "https://github.com/o/r/pull/7"; exit 0;;
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

  it("never calls `gh repo edit` (no Administration permission needed on GH_TOKEN)", async () => {
    const log = join(dir, "edit.log");
    process.env.FAKE_EDIT_LOG = log;
    delete process.env.FAKE_EXISTING;
    try {
      expect(openPullRequest(tmpdir(), opts)).toMatchObject({ ok: true, detail: "pull request opened" });
      expect(await openPullRequestAsync(tmpdir(), opts)).toMatchObject({ ok: true, detail: "pull request opened" });
      expect(existsSync(log)).toBe(false);
    } finally {
      delete process.env.FAKE_EDIT_LOG;
    }
  });

  it("squash-merges and deletes branch both synchronously and asynchronously", async () => {
    const mergeLog = join(dir, "merge.log");
    process.env.FAKE_MERGE_LOG = mergeLog;
    try {
      process.env.FAKE_MERGE_FAIL = "1";
      expect(squashMergePullRequest(tmpdir(), "https://github.com/o/r/pull/7")).toMatchObject({ ok: false, merged: false });
      expect(await squashMergePullRequestAsync(tmpdir(), "7")).toMatchObject({ ok: false, merged: false });
      delete process.env.FAKE_MERGE_FAIL;
      expect(squashMergePullRequest(tmpdir(), "https://github.com/o/r/pull/7")).toMatchObject({ ok: true, merged: true });
      expect(await squashMergePullRequestAsync(tmpdir(), "7")).toMatchObject({
        ok: true,
        merged: true,
        url: "https://github.com/o/r/pull/7",
      });
      const lines = readFileSync(mergeLog, "utf8").trim().split("\n");
      expect(lines.at(-1)).toBe("pr merge 7 --squash --delete-branch");
    } finally {
      delete process.env.FAKE_MERGE_LOG;
      delete process.env.FAKE_MERGE_FAIL;
    }
  });
});

describe("openPullRequestAsync (web server path)", () => {
  it("opens a PR without prompting and reuses an open one", async () => {
    delete process.env.FAKE_EXISTING;
    const r = await openPullRequestAsync(tmpdir(), opts);
    expect(r).toMatchObject({ ok: true, url: "https://github.com/o/r/pull/7", detail: "pull request opened" });
    process.env.FAKE_EXISTING = "https://github.com/o/r/pull/3";
    expect(await openPullRequestAsync(tmpdir(), opts)).toMatchObject({ ok: true, url: "https://github.com/o/r/pull/3" });
    delete process.env.FAKE_EXISTING;
  });

  it("passes GH_PROMPT_DISABLED=1 and GIT_TERMINAL_PROMPT=0 to gh", async () => {
    process.env.FAKE_REQUIRE_NOPROMPT = "1";
    try {
      expect(await openPullRequestAsync(tmpdir(), opts)).toMatchObject({ ok: true });
    } finally {
      delete process.env.FAKE_REQUIRE_NOPROMPT;
    }
  });

  it("times out instead of hanging, without blocking the event loop", async () => {
    process.env.FAKE_SLEEP = "5";
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      const r = await openPullRequestAsync(tmpdir(), opts, { timeoutMs: 400 });
      expect(r).toMatchObject({ ok: false });
      expect(r.detail).toMatch(/timed out/);
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
      delete process.env.FAKE_SLEEP;
    }
  });
});

