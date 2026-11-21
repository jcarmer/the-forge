# OPERATOR.md — LLM Operator Guide for The Forge

You are managing **The Forge**, a Docker-based AI development sandbox on the user's Windows 11 desktop (RTX 3080). The user manages this infrastructure **entirely through you** and prefers plain-English explanations over raw Docker internals.

## Principles
1. **Explain before acting**: Before running a mutating command, say in 1–2 sentences what you are about to do and why.
2. **Never touch secrets without asking**: Never print or edit `generated/.env` or `buddy.env` unless the user explicitly asks.
3. **Single source of truth**: Never edit files in `generated/` by hand. Change `sandbox.config.ts` and run `npx tsx src/cli.ts generate`.
4. **Backup before destructive changes**: Before pruning volumes or resetting branches, confirm with the user.

## Agent tooling guidance (all projects)
Rules for tool choice and the `ollama-helper` local-model MCP (it must be loaded with `ToolSearch` first) live in `ops/claude-user/CLAUDE.md`. `the-forge up` installs them into `/root/.claude/CLAUDE.md` so they apply to every project, together with a Bash guard hook (`ops/claude-user/bash-guard.mjs`) that blocks bare `cat` of large files and unbounded recursive `grep`. Skills in `ops/claude-user/skills/` (e.g. `forge-orchestrate`, which plans work in T3 and delegates it to sub-agents by complexity and quota) are installed into `/root/.claude/skills/` the same way. Edit those files in the repo, never in the container, then run `npx tsx src/cli.ts up`.


## Safe Commands (run freely to diagnose)
- `npx tsx src/cli.ts status` — show container state
- `npx tsx src/cli.ts doctor` — check Tailscale, GPU, Ollama models, services, and `GH_TOKEN`
- `npx tsx src/cli.ts logs <service>` — inspect last 100 lines (`buddy`, `t3`, `comfyui`, `ollama`, `caddy`, `vscode-tunnel`)
- `npx tsx src/cli.ts usage` — collect and show live `/usage` quotas for Antigravity and Claude
- `npx tsx src/cli.ts context [dir]` — list the guidance, rules, skills, MCP servers and settings in effect for a project (secrets are never shown); also the web UI's AI Context tab
- `npx tsx src/cli.ts sessions [id] [--ollama]` — token use and MCP calls per T3/Claude conversation, with costly-step findings; `--ollama` adds one-line explanations (only counts and tool names are sent)
- `npx tsx src/cli.ts sessions story <id> [--redact]` — narrative of one conversation: turns, time split (model vs tools vs you), cost, parallel calls, sub-agents, skills/MCP used, and findings
- `npx tsx src/cli.ts sessions digest [--days 7] [--redact] [--out file.md]` — measured markdown brief of recent conversations for an LLM to review (workflow, missing skills/MCPs, model choice); `--redact` strips prompts, commands and paths. Also the "Copy advisor brief" button on the web UI Sessions tab
- `npx tsx src/cli.ts schedule` — list registered jobs, schedule entries (with next run) and the last run; `schedule run <entryId>` runs one entry now and prints its log. Entries are created in the web UI **Schedules** tab
- `npx tsx src/cli.ts route <trivial|normal|hard>` — preview which provider the router would pick
- `npx tsx src/cli.ts healthcheck` — check config/docs drift, `/usage` parsers, and newer `qwen-coder` models
- `npx tsx src/cli.ts migrate-check` — check legacy `C:\projects\sandbox` for uncommitted/unpushed work

## Mutating Commands (explain first)
- `npx tsx src/cli.ts up` — regenerate files, run preflight checks, build and start containers
- `npx tsx src/cli.ts down` — stop containers (volumes are preserved)
- `npx tsx src/cli.ts promote <repo>` — open a pull request from `ai-work` into `main` (you review and merge it on GitHub). It first predicts whether the PR would conflict and prints the files and the steps to resolve them
- `npx tsx src/cli.ts clone` — clone any missing manifest repos into `/projects`
- `npx tsx src/cli.ts sync <repo>` — merge `origin/main` into `ai-work` (no force-push). On a conflict nothing is changed: it prints the conflicting files and the steps to resolve them in your own clone (or hand it to an agent task)
- `npx tsx src/cli.ts t3-pair [ttl]` — mint a one-time T3 pairing link/code (default 10m, single use); also a button on the web UI Services tab
- `npx tsx src/cli.ts tunnel-login` — interactive GitHub device login for VS Code `code tunnel`

## Git workflow and conflicts
GitHub is the only shared truth. Agents write `task/<id>` and `ai-work`; you (e.g. with GitComet on the Windows desktop, from a clone of the GitHub repo) resolve conflicts in your own clone and push the result. Never push to the Forge's `/projects` checkouts directly.
- **Conflict preview.** The web UI repo page has **Check for conflicts** (`POST /api/git/repo/<name>/sync-preview`): a read-only dry run (fetch, then a throwaway three-way merge; the working tree, index and refs are untouched) that lists the files that would conflict. Repo tiles show a "would conflict with main" chip and a "N behind main" chip from the same prediction (cached per commit pair).
- **Conflicted `sync-main`** is aborted, changes nothing and returns `conflictFiles` plus copy-able `resolveSteps` (the page also has a **Copy resolve steps** button).
- **Agent busy guard.** While an agent task is running in a repo (a `running` record newer than 6 hours in `tasks.json`), `push`, `commit-push` and `sync-main` on the integration branch are refused with HTTP 409, because the task merges into that branch itself. The Sync tool has an "sync anyway" checkbox; the API accepts `allowWhileBusy: true`. Other branches are never blocked.
- **Scheduled drift check.** The `git-drift-check` job (Schedules tab) compares `origin/ai-work` with `origin/main` in every repo and reports drift and conflicting files. It never merges or pushes. Repos without `origin/ai-work` are skipped, and a run where nothing was compared says so instead of reporting "no conflicts".
- **Line endings.** `up` sets the container's global `core.autocrlf=input` only if you have not set a value, so agent commits keep LF. A per-repo `.gitattributes` is deliberately not added automatically (it would show up as an uncommitted change in your repos); add `* text=auto` yourself if you want it enforced. On Windows, keep your own `core.autocrlf` consistent across clones.
- Requires only plain `git` (the preview uses `read-tree` and `merge-file`, so it works on the container's git 2.34).

## Pull requests
Gated agent tasks land via `git.taskMergeMode` in `sandbox.config.ts`: `pr` (default) pushes `task/<id>` and opens a PR into `ai-work`; `pr-merge` also squash-merges it; `direct` is the old local merge. PR URLs show on each task in the Tasks view. If `doctor` flags the GitHub CLI, the `GH_TOKEN` needs **Pull requests: read/write**.

## Scheduled functions and the browser extension
- **Jobs** are TypeScript functions defined with `defineJob` (`src/schedule/registry.ts`) and listed in `src/jobs/index.ts`. A zod schema describes their parameters; the web UI draws the form from it. Add a job by adding a module and listing it; no UI change needed.
- **Schedules** (web UI Schedules tab) are entries of `job + when + timezone + params`. One job can have many entries. `when` is daily / weekly / monthly / every N hours or minutes / raw cron, evaluated by `croner`. State is in `/var/lib/the-forge` (the `forge_state` volume): `schedules.json`, `schedule-runs.json`, `scan-cache/`, `collected/`. A restart catches up a missed run once, never repeatedly.
- **`scan-node-modules`** hashes JS/JSON/script/binary files in every `node_modules` under `roots` and checks `name@version` against OSV `MAL-*` advisories. Unchanged files are re-hashed on a 1, 2, 4... day backoff (cap `maxRecheckDays`); changed files at once. Optional `iocHashFile` lists known-bad SHA-256s and applies to cached hashes immediately.
- **Browser extension** (`extension/`, read its README): config-only actions edited in the web UI Extension tab; results land in `/var/lib/the-forge/collected/<name>.body` (raw) with a `.meta.json`. The extension authenticates with a token (`ext-token`, rotate from the UI). After the first `up` on this change, run it so the new `forge_state` volume is created.
