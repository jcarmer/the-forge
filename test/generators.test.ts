import { describe, it, expect } from "vitest";
import manifest from "../sandbox.config.js";
import { renderAll } from "../src/generators/index.js";
import { renderCompose } from "../src/generators/compose.js";
import { factsHash } from "../src/generators/setupMd.js";
import { defineManifest } from "../src/schema.js";

describe("generators", () => {
  const files = renderAll(manifest);

  it("never publishes host ports", () => {
    expect(files["docker-compose.yml"]).not.toMatch(/^\s+ports:/m);
  });

  it("puts the dev container on the tailscale network namespace", () => {
    expect(files["docker-compose.yml"]).toContain("network_mode: service:tailscale");
    expect(files["docker-compose.yml"]).toContain("--advertise-tags=tag:ai-sandbox");
  });

  it("keeps repos on a named volume rather than a Windows bind mount", () => {
    expect(files["docker-compose.yml"]).toContain("ai_sandbox_repos:/projects");
    expect(files["docker-compose.yml"]).not.toContain("C:/projects/sandbox");
  });

  it("installs godot headless and pins its version from the manifest", () => {
    expect(files["Dockerfile"]).toContain(`GODOT_VERSION=${manifest.toolchain.godotVersion}`);
  });

  it("exposes ComfyUI on all interfaces inside the tailnet node", () => {
    expect(files["entrypoint.sh"]).toContain("--listen 0.0.0.0 --port 8188");
  });

  it("runs the dev container under an init so orphaned children are reaped (no zombie buildup)", () => {
    expect(files["docker-compose.yml"]).toMatch(/^\s+init: true$/m);
  });

  it("invokes entrypoint.sh via /bin/bash so Windows bind mounts do not require +x", () => {
    expect(files["Dockerfile"]).toContain('ENTRYPOINT ["/bin/bash", "/usr/local/bin/entrypoint.sh"]');
    expect(files["docker-compose.yml"]).toContain('entrypoint: ["/bin/bash", "/usr/local/bin/entrypoint.sh"]');
    expect(files["docker-compose.yml"]).toContain('command: ["sleep", "infinity"]');
  });

  it("documents every service in SETUP.md", () => {
    for (const s of manifest.services) expect(files["SETUP.md"]).toContain(`| ${s.name} | ${s.port} |`);
  });

  it("changes the facts hash when a service is added", () => {
    const before = factsHash(manifest);
    const added = defineManifest({ ...manifest, services: [...manifest.services, { name: "x", port: 9999, description: "new" }] });
    expect(factsHash(added)).not.toBe(before);
  });

  it("rejects a tailscale tag without the tag: prefix", () => {
    expect(() => defineManifest({ ...manifest, network: { ...manifest.network, tailscaleTag: "ai-sandbox" } })).toThrow();
  });

  it("is deterministic", () => {
    expect(renderCompose(manifest)).toBe(renderCompose(manifest));
  });
});
