# Forge agent guidance (all projects)

Installed into `/root/.claude/CLAUDE.md` by `the-forge up` from `ops/claude-user/CLAUDE.md` in the-forge repo. Edit it there, not in the container.

## Choose the cheapest tool that answers the question
- Use the dedicated Read and Grep tools, not `cat` or `grep -r` in Bash. Read with an offset/limit, and Grep with a result limit, so only what you need enters the conversation.
- If you must use Bash for search, bound the output (`| head -50`, `grep -l`, `grep -c`, `-m N`). A Bash guard blocks bare `cat` on large files and unbounded recursive `grep`; add `# allow-unbounded` to the command only when you really need all of it.
- Make independent tool calls in the same turn instead of one at a time.
- For broad exploration (sweeping many files or directories to answer one question), start an `Explore` sub-agent and ask for a conclusion. Its file reads stay out of your context.

## Local helper (`ollama-helper` MCP)
A local-model MCP server runs on the user's GPU. Its tools are **deferred**: they appear only as names until you load them with `ToolSearch` (query `select:mcp__ollama-helper__local_code_search_and_scan,mcp__ollama-helper__local_summarize_files`, or `ollama-helper`), so load them yourself before first use.
- **Use it first** for broad, read-only legwork: searching or scanning many files (`local_code_search_and_scan`), summarizing several files or long logs (`local_summarize_files`), and quick questions that need no repo context (`ask_local_helper`).
- `local_draft_code` is for first drafts of boilerplate only. Review its output before applying it.
- **Do not rely on it** for decisions, security-sensitive judgment, or exact line-level facts. Verify anything you will act on or quote by reading the file yourself.
- If a tool call fails or the server is not connected, say so briefly and continue without it. Do not retry in a loop.
