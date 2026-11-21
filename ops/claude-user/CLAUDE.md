# Forge agent guidance (all projects)

Installed into `/root/.claude/CLAUDE.md` by `the-forge up` from `ops/claude-user/CLAUDE.md` in the-forge repo. Edit it there, not in the container.

## Hard rules
- 3 or more read-only lookups (read, grep, ls, find) in one turn: send them together in ONE message, or hand the question to `ollama-helper`. Never chain them one per step.
- Do not start an `Explore` sub-agent (it runs on a paid Claude model). Use `ollama-helper` for broad search instead; only fall back to Explore if it is unavailable.

## Choose the cheapest tool that answers the question
- Use the dedicated Read and Grep tools, not `cat` or `grep -r` in Bash. Read with an offset/limit, and Grep with a result limit, so only what you need enters the conversation.
- If you must use Bash for search, bound the output (`| head -50`, `grep -l`, `grep -c`, `-m N`). A Bash guard blocks bare `cat` on large files and unbounded recursive `grep`; add `# allow-unbounded` to the command only when you really need all of it.
- Make independent tool calls in the same turn instead of one at a time.
- For broad exploration (sweeping many files or directories to answer one question), use `local_code_search_and_scan` or `local_summarize_files` from `ollama-helper` and ask for a conclusion. The file reads stay out of your context and cost no Claude tokens.

## Local helper (`ollama-helper` MCP)
A local-model MCP server runs on the user's GPU. Its tools are **deferred**: they appear only as names until you load them with `ToolSearch` (query `select:mcp__ollama-helper__local_code_search_and_scan,mcp__ollama-helper__local_summarize_files`, or `ollama-helper`), so load them yourself before first use.
- **Use it first** for broad, read-only legwork: searching or scanning many files (`local_code_search_and_scan`), summarizing several files or long logs (`local_summarize_files`), and quick questions that need no repo context (`ask_local_helper`).
- `local_draft_code` is for first drafts of boilerplate only. Review its output before applying it.
- **Do not rely on it** for decisions, security-sensitive judgment, exact line-level facts, or conclusions about how code behaves (call chains, which function does what). It ranks files by keyword relevance and its prose often hedges ("likely") or misattributes. Use it to **locate candidate files**, then read them yourself and verify anything you will act on or quote. If you report what it said, say it is unverified.
- If a tool call fails or the server is not connected, say so briefly and continue without it. Do not retry in a loop.

## Shell read & search guardrails
- Never run unbounded `rg`, `grep -r`, `find`, or `head`/`tail` over 200 lines in Bash; use `Grep` (with `head_limit`) and `Read` (with `offset`/`limit`).

## Fast exploration (`fast-explore` skill)
- On turn 1 of any multi-file investigation, call `ToolSearch` (`select:mcp__ollama-helper__local_code_search_and_scan,mcp__ollama-helper__local_summarize_files`) alongside your initial batched `Read`/`Grep`/`Glob` calls.
- Use `fast-explore` to sweep directories with `ollama-helper` and batch follow-up file reads into a single step.

## Model & effort tiering
- Offload quick read-only questions and boilerplate drafts to `ollama-helper` (`ask_local_helper`, `local_draft_code`).
- Use Sonnet or Flash with medium effort for standard implementation turns, and reserve Opus / high effort for cross-cutting architecture or subtle bugs.

## Context hygiene & cache discipline
- Do not re-read a file that is already in context unless an external command modified it; after `Edit`, read only the changed line range if needed.
- Compact context (`/compact`) or delegate the next phase to an isolated sub-agent (`forge-orchestrate`) before context exceeds ~200k tokens or before a long break.
