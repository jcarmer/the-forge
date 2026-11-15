import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Manifest } from "../schema.js";
import { run } from "../ops.js";

const GH_CRED_HELPER =
  '!f() { [ "$1" = get ] && [ -n "$GH_TOKEN" ] && echo username=x-access-token && echo password=$GH_TOKEN; }; f';

export interface ProvisionStep {
  name: string;
  check: () => boolean;
  apply: () => void;
}

export interface ProvisionOutcome {
  name: string;
  status: "already-ok" | "applied" | "failed";
  detail?: string;
}

function writeJsonIfMissingOrChanged(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Builds the idempotent startup steps for inside the Linux container. */
export function buildProvisionSteps(manifest: Manifest): ProvisionStep[] {
  const vscodeSettings = {
    "npm.packageManager": "pnpm",
    "remote.extensionKind": { "local.tbe-vscode": ["workspace"] },
  };
  const mcpConfig = {
    mcpServers: {
      "ollama-helper": {
        command: "python3",
        args: ["-u", "/root/.gemini/config/tools/ollama_helper_mcp.py"],
        env: { PYTHONUNBUFFERED: "1" },
      },
    },
  };

  return [
    {
      name: "git-defaults",
      check: () => run("git", ["config", "--global", "--get", "worktree.useRelativePaths"]).out.trim() === "true",
      apply: () => {
        run("git", ["config", "--global", "--add", "safe.directory", "*"]);
        run("git", ["config", "--global", "worktree.useRelativePaths", "true"]);
      },
    },
    {
      // Credential helper reads $GH_TOKEN at call time: no secret is written to disk and rotation just works.
      name: "git-github-auth",
      check: () => run("git", ["config", "--global", "--get", "credential.https://github.com.helper"]).out.trim() === GH_CRED_HELPER,
      apply: () => {
        run("bash", ["-c", `git config --global --name-only --get-regexp '^url\\..*x-access-token' | while read -r k; do git config --global --unset-all "$k"; done`]);
        run("git", ["config", "--global", "--replace-all", "credential.https://github.com.helper", GH_CRED_HELPER]);
      },
    },
    {
      name: "vscode-workspace-settings",
      check: () =>
        existsSync("/root/.vscode-server/data/Machine/settings.json") &&
        existsSync("/projects/.vscode/settings.json") &&
        existsSync("/projects/.vscode/extensions.json"),
      apply: () => {
        writeJsonIfMissingOrChanged("/root/.vscode-server/data/Machine/settings.json", vscodeSettings);
        writeJsonIfMissingOrChanged("/projects/.vscode/settings.json", vscodeSettings);
        writeJsonIfMissingOrChanged("/projects/.vscode/extensions.json", { recommendations: ["local.tbe-vscode"] });
      },
    },
    {
      name: "antigravity-mcp",
      check: () => existsSync("/root/.gemini/config/mcp_config.json"),
      apply: () => {
        writeJsonIfMissingOrChanged("/root/.gemini/config/mcp_config.json", mcpConfig);
      },
    },
    {
      // Separate from antigravity-mcp: that step's check passes once mcp_config.json exists, which used to skip this registration.
      name: "claude-ollama-helper-mcp",
      check: () => run("bash", ["-lc", "command -v claude >/dev/null 2>&1 || exit 0; claude mcp get ollama-helper >/dev/null 2>&1"]).code === 0,
      apply: () => {
        run("bash", ["-lc", "claude mcp add -s user ollama-helper -- python3 /root/.gemini/config/tools/ollama_helper_mcp.py"]);
      },
    },
    {
      name: "claude-config-persist",
      check: () => run("bash", ["-lc", '[ -L /root/.claude.json ] && [ "$(readlink /root/.claude.json)" = "/root/.claude/.claude.json" ]']).code === 0,
      apply: () => {
        run("bash", ["-lc", 'mkdir -p /root/.claude; if [ -f /root/.claude.json ] && [ ! -L /root/.claude.json ] && [ ! -f /root/.claude/.claude.json ]; then mv /root/.claude.json /root/.claude/.claude.json; fi; [ -f /root/.claude/.claude.json ] || echo "{}" > /root/.claude/.claude.json; ln -sf /root/.claude/.claude.json /root/.claude.json']);
      },
    },
    {
      name: "forge-cli-link",
      check: () => run("bash", ["-lc", '[ -L /usr/local/bin/the-forge ] && [ -L /projects/the-forge ]']).code === 0,
      apply: () => {
        run("bash", ["-lc", 'chmod +x /opt/the-forge/dist/src/cli.js && ln -sf /opt/the-forge/dist/src/cli.js /usr/local/bin/the-forge && ln -sfn /opt/the-forge /projects/the-forge']);
      },
    },
    {
      name: "t3-runtime-link",
      check: () => run("bash", ["-lc", "command -v t3 >/dev/null 2>&1"]).code === 0,
      apply: () => {
        run("bash", ["-lc", 'T3=$(ls -1 /root/.t3/runtime/versions/*/t3 2>/dev/null | tail -n 1); if [ -n "$T3" ]; then ln -sf "$T3" /usr/local/bin/t3; else curl -fsSL https://t3.codes/install.sh | bash; fi']);
      },
    },
  ];
}

/** Runs all provision steps idempotently (checks first, applies only if needed). */
export function runProvision(steps: ProvisionStep[]): ProvisionOutcome[] {
  const results: ProvisionOutcome[] = [];
  for (const s of steps) {
    try {
      if (s.check()) {
        results.push({ name: s.name, status: "already-ok" });
      } else {
        s.apply();
        results.push({ name: s.name, status: "applied" });
      }
    } catch (e) {
      results.push({ name: s.name, status: "failed", detail: String(e) });
    }
  }
  return results;
}

/** Checks all auth states inside the container and returns exact 1-line fixes for anything missing. */
export function checkAuthStatus(m: Manifest): { service: string; ok: boolean; fix?: string }[] {
  const inContainer = existsSync("/.dockerenv");
  const exec = (cmd: string) => (inContainer ? run("bash", ["-lc", cmd]) : run("docker", ["exec", m.containerName, "bash", "-lc", cmd]));
  return [
    {
      service: "Claude (subscription or CLAUDE_CODE_OAUTH_TOKEN)",
      ok: exec('[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -f /root/.claude/.credentials.json ]').code === 0,
      fix: `Run: docker exec -it ${m.containerName} claude auth login (or set CLAUDE_CODE_OAUTH_TOKEN in .env)`,
    },
    {
      service: "Antigravity (agy)",
      ok: exec("ls -A /root/.gemini 2>/dev/null | grep -q .").code === 0,
      fix: `Run: docker exec -it ${m.containerName} agy`,
    },
    {
      service: "VS Code Tunnel",
      ok: exec('[ -n "$(ls -A /root/.vscode/cli 2>/dev/null)" ]').code === 0,
      fix: "Run: npx tsx src/cli.ts tunnel-login",
    },
    {
      service: "GitHub (GH_TOKEN)",
      ok: exec('[ -n "$GH_TOKEN" ]').code === 0,
      fix: "Set GH_TOKEN in generated/.env and run: npx tsx src/cli.ts up",
    },
  ];
}
