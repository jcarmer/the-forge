import { defineManifest } from "./src/schema.js";

export default defineManifest({
  projectName: "ai-sandbox",
  // Distinct from the legacy `ai_dev_sandbox` so both can coexist until cutover.
  containerName: "the_forge",

  network: {
    tailscaleHostname: "ai-sandbox",
    tailscaleTag: "tag:ai-sandbox",
  },

  paths: {
    forgeDir: "C:/projects/local-only/the-forge",
    metaDir: "C:/projects/local-only/meta",
    buddyEnvFile: "C:/projects/local-only/buddy.env",
    legacySandboxDir: "C:/projects/sandbox",
    ignoredLegacyDirs: ["art-created", "comfyui", "dnd-content", "pixelover", "prototype-art"],
  },

  previews: [
    { name: "tbe", port: 5174, command: "pnpm dev" },
    { name: "script-model", port: 5201, command: "pnpm dev:host -- --port 5201" },
  ],

  repos: [
    { name: "buddy", url: "https://github.com/jcarmer/buddy" },
    { name: "buddy-memory", url: "https://github.com/jcarmer/buddy-memory" },
    { name: "last-days-campaign", url: "https://github.com/jcarmer/last-days-campaign" },
    { name: "obsidian-plugin", url: "https://github.com/jcarmer/obsidian-plugin" },
    { name: "script-model", url: "https://github.com/jcarmer/script-model" },
    { name: "tbe", url: "https://github.com/jcarmer/tbe" },
  ],

  services: [
    { name: "t3", port: 3773, description: "T3 Code orchestration UI", start: "t3 serve --host 0.0.0.0" },
    { name: "comfyui", port: 8188, description: "ComfyUI (accepts POST /prompt API calls)", start: "python main.py --listen 0.0.0.0 --port 8188" },
    { name: "ollama", port: 11434, description: "Ollama API (qwen-coder)", start: "ollama serve" },
    { name: "preview", port: 5173, description: "Always-on ai-work preview (behind Caddy)", caddyPath: "/", start: "sandboxctl preview" },
  ],

  volumes: {
    repos: { mount: "/projects", description: "All git repos and worktrees (Linux filesystem, not a Windows mount)" },
    ollama_models: { mount: "/root/.ollama", description: "Ollama model cache" },
    nuget_cache: { mount: "/root/.nuget", description: "NuGet package cache" },
    claude_config: { mount: "/root/.claude", description: "Claude Code credentials" },
    t3_config: { mount: "/root/.t3", description: "T3 Code configuration" },
    comfyui_data: { mount: "/root/comfyui", description: "ComfyUI install, venv, nodes, models" },
    vscode_cli: { mount: "/root/.vscode", description: "VS Code tunnel login and server" },
  },

  ollama: {
    primaryModel: "qwen2.5-coder:7b",
    extraModels: ["qwen2.5:7b"],
  },

  toolchain: {
    cudaImage: "nvidia/cuda:12.4.1-runtime-ubuntu22.04",
    dotnetChannel: "10.0",
    nodeMajor: 20,
    godotVersion: "4.8-dev7",
    pythonVersion: "3.12",
  },

  git: {},

  providers: [
    { name: "ollama", priority: 0 },
    { name: "antigravity", priority: 1, usageCommand: 'agy -p "/usage"' },
    { name: "claude", priority: 2, usageCommand: 'env -u ANTHROPIC_API_KEY claude -p "/usage"' },
  ],
});
