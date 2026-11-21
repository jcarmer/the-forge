---
name: fast-explore
description: Fast, low-token codebase exploration using ollama-helper and batched parallel Read/Grep calls. Use at the start of any multi-file investigation or search-heavy turn.
---

# fast-explore

## 1. Load local search tools on Step 1
- Call `ToolSearch` with query `select:mcp__ollama-helper__local_code_search_and_scan,mcp__ollama-helper__local_summarize_files` alongside your initial `Glob` or `Grep` calls.
- Never chain 5+ single-call steps one after another when independent lookups can run in the same turn.

## 2. Sweep with GPU, verify with bounded Read
- Use `mcp__ollama-helper__local_code_search_and_scan` to scan directories or answer broad "where is X handled?" questions without adding raw files to Claude context.
- Use `mcp__ollama-helper__local_summarize_files` to digest long files or logs (>200 lines).
- Treat helper output as **leads, not facts**: it finds candidate files but can misattribute behaviour or miss the key file. Before concluding how code works, read the cited files (or follow the call chain with `Grep`) yourself.
- Once you know the exact file and line range, call `Read` with `offset` and `limit` (<= 200 lines) in a single batched step.
