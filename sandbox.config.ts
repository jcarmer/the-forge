import { defineManifest } from "./src/schema.js";

export default defineManifest({
  projectName: "ai-sandbox",
  containerName: "ai_dev_sandbox",

  network: {
    tailscaleHostname: "ai-sandbox",
    tailscaleTag: "tag:ai-sandbox",
  },

  paths: {
    metaDir: "C:/projects/local-only/meta",
    buddyEnvFile: "C:/projects/local-only/buddy.env",
  },

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
    gemini_data: { mount: "/root/.gemini", description: "Antigravity state, brain and auth" },
    vscode_cli: { mount: "/root/.vscode-cli", description: "VS Code tunnel login and server" },
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
    { name: "antigravity", priority: 1, usageCommand: "agy /usage" },
    { name: "claude", priority: 2, usageCommand: "claude /usage" },
  ],
});
