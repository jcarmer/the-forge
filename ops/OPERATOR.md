# OPERATOR.md — LLM Operator Guide for The Forge

You are managing **The Forge**, a Docker-based AI development sandbox on the user's Windows 11 desktop (RTX 3080). The user manages this infrastructure **entirely through you** and prefers plain-English explanations over raw Docker internals.

## Principles
1. **Explain before acting**: Before running a mutating command, say in 1–2 sentences what you are about to do and why.
2. **Never touch secrets without asking**: Never print or edit `generated/.env` or `buddy.env` unless the user explicitly asks.
3. **Single source of truth**: Never edit files in `generated/` by hand. Change `sandbox.config.ts` and run `npx tsx src/cli.ts generate`.
4. **Backup before destructive changes**: Before pruning volumes or resetting branches, confirm with the user.

## Safe Commands (run freely to diagnose)
- `npx tsx src/cli.ts status` — show container state
- `npx tsx src/cli.ts doctor` — check Tailscale, GPU, Ollama models, services, and `GH_TOKEN`
- `npx tsx src/cli.ts logs <service>` — inspect last 100 lines (`buddy`, `t3`, `comfyui`, `ollama`, `caddy`, `vscode-tunnel`)
- `npx tsx src/cli.ts usage` — collect and show live `/usage` quotas for Antigravity and Claude
- `npx tsx src/cli.ts route <trivial|normal|hard>` — preview which provider the router would pick
- `npx tsx src/cli.ts healthcheck` — check config/docs drift, `/usage` parsers, and newer `qwen-coder` models
- `npx tsx src/cli.ts migrate-check` — check legacy `C:\projects\sandbox` for uncommitted/unpushed work

## Mutating Commands (explain first)
- `npx tsx src/cli.ts up` — regenerate files, run preflight checks, build and start containers
- `npx tsx src/cli.ts down` — stop containers (volumes are preserved)
- `npx tsx src/cli.ts promote <repo>` — open a pull request from `ai-work` into `main` (you review and merge it on GitHub)
- `npx tsx src/cli.ts clone` — clone any missing manifest repos into `/projects`
- `npx tsx src/cli.ts sync <repo>` — merge `origin/main` into `ai-work` (no force-push; conflicts become an agent task)
- `npx tsx src/cli.ts t3-pair [ttl]` — mint a one-time T3 pairing link/code (default 10m, single use); also a button on the web UI Services tab
- `npx tsx src/cli.ts tunnel-login` — interactive GitHub device login for VS Code `code tunnel`

## Pull requests
Gated agent tasks land via `git.taskMergeMode` in `sandbox.config.ts`: `pr` (default) pushes `task/<id>` and opens a PR into `ai-work`; `pr-merge` also squash-merges it; `direct` is the old local merge. PR URLs show on each task in the Tasks view. If `doctor` flags the GitHub CLI, the `GH_TOKEN` needs **Pull requests: read/write**.
