import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../schema.js";
import { renderCompose } from "./compose.js";
import { renderDockerfile } from "./dockerfile.js";
import { renderCaddyfile } from "./caddy.js";
import { renderEntrypoint } from "./entrypoint.js";
import { renderSetupMd } from "./setupMd.js";

export function renderAll(m: Manifest): Record<string, string> {
  return {
    "docker-compose.yml": renderCompose(m),
    Dockerfile: renderDockerfile(m),
    Caddyfile: renderCaddyfile(m),
    "entrypoint.sh": renderEntrypoint(m),
    "SETUP.md": renderSetupMd(m),
    ".env.example": [
      `${m.network.authKeyEnv}=tskey-auth-xxxxxxxx   # reusable key tagged ${m.network.tailscaleTag}`,
      "GH_TOKEN=github_pat_xxxxxxxx           # fine-grained, Contents read/write on selected repos",
      "ANTHROPIC_API_KEY=                      # optional",
      "",
    ].join("\n"),
  };
}

export function writeAll(m: Manifest, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(renderAll(m))) {
    const path = join(outDir, name);
    // LF endings: these run inside Linux.
    writeFileSync(path, content.replace(/\r\n/g, "\n"), { encoding: "utf8" });
    written.push(path);
  }
  return written;
}

export const envExists = (dir: string) => existsSync(join(dir, ".env"));
