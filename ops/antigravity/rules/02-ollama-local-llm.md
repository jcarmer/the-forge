---
trigger: always_on
description: Architecture distinction and token optimization guidelines for local Ollama on RTX 3080.
---
<!-- Managed by the-forge: edit ops/antigravity/rules/02-ollama-local-llm.md in the repo and run `the-forge up`. Edits made directly in the meta folder are overwritten. -->
# Local GPU LLM Architecture: Antigravity Tooling vs. Buddy Application

## CRITICAL ARCHITECTURAL DISTINCTION
In this development environment, Ollama (`http://localhost:11434` on RTX 3080) serves two completely separate purposes. You must never confuse them:

1. **Buddy Application Runtime (The App Under Development)**:
   - The Buddy service (`/projects/buddy`) contains application code (`src/llm/local.ts`, `src/tasks/evaluator.ts`) and configuration notes (`/projects/buddy-memory/Configuration/Local Model.md`) that call Ollama during its own runtime.
   - These application files define how the Buddy bot behaves for end users. When you edit Buddy code, you are acting as an external software engineer modifying an application.

2. **Antigravity Assistant Tooling (YOU, the AI Coding Agent)**:
   - YOU have direct access to local Ollama on the RTX 3080 via your dedicated `ollama-helper` MCP server.
   - You have dedicated tools: `local_code_search_and_scan`, `local_summarize_files`, `ask_local_helper`, and `local_draft_code`.
   - **MANDATORY**: Whenever the user asks you to search, query, or inspect local data—specifically including the Obsidian Vault (`/projects/buddy-memory`), code repositories, or log dumps—YOU MUST use `local_code_search_and_scan(path="/projects/buddy-memory", query="...")` or `ask_local_helper`.
   - **NEVER** tell the user that Ollama is only for Buddy or that Antigravity operates purely through the cloud. Ollama on the RTX 3080 is YOUR local acceleration engine to query local data with 0 cloud tokens.

---

## Available Local Model & Hardware
- **Model**: `qwen2.5-coder:7b` (specialized coding model running at ~80+ tokens/sec on GPU VRAM).
- **Context Windows**:
  - `fast_32k` (32,768 tokens): Fits entirely on the RTX 3080 with Flash Attention for instantaneous answers.
  - `deep_128k` (131,072 tokens): Takes advantage of 64 GB host RAM + GPU acceleration for massive logs and multi-file codebases.

## Available Local MCP Tools (via `ollama-helper`)
1. `local_code_search_and_scan(query, path="/projects", file_patterns=[], max_files=10)`
   - **MANDATORY FOR SEARCHING CODE & VAULT NOTES**: Instead of calling `grep_search` and subsequently reading files with `view_file`, use this tool.
   - For searching the Obsidian memory vault, pass `path="/projects/buddy-memory"`.
   - It finds relevant code and notes directly on disk, passes snippets to local `qwen2.5-coder` on RTX 3080, and returns a distilled summary with file paths and citations.
   - Defers 95%+ of search tokens.
   - **RELIABILITY LIMIT**: Use it to LOCATE candidate files, not to conclude how code behaves. It ranks files by keyword relevance and does not follow call chains, so it can point at the wrong files, miss the key one, or hedge ("likely"). Its line numbers and behavioural claims are unverified: open the cited files yourself before acting on or quoting them, and tell the user when something comes only from the helper.
2. `local_summarize_files(file_paths, task_instruction, mode="auto")`
   - **MANDATORY FOR MULTI-FILE INSPECTIONS**: Reads multiple files or notes directly from container disk and extracts interface definitions, configurations, or logic using the local model.
3. `ask_local_helper(prompt, file_path="", system_prompt="", mode="auto")`
   - Use for single-file deep dives (notes, logs, large classes > 100 lines) by passing `file_path`.
   - The file is read from disk with 0 cloud tokens consumed.
4. `local_draft_code(task, reference_files=[])`
   - Generates repetitive boilerplate, unit test scaffolding, mock data, or syntax translations locally.

## Token Conservation Mandate
- **NEVER** use `view_file` on large files (>100 lines), build dumps, or trace logs when `ask_local_helper` or `local_summarize_files` can digest them on disk.
- **NEVER** dump entire directories or multiple vault notes into primary context.
- Reserve primary cloud context for high-level architectural decisions, planning, and user pair-programming.
