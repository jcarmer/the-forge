---
name: forge-orchestrate
description: Plan a larger piece of work inside T3 and hand the pieces to sub-agents on the right provider/model based on task complexity and live quota. Use when the user asks to break down, parallelize, delegate or "orchestrate" a multi-step job, or says to spread work across Claude / Antigravity / local models. Not for small single-file edits.
---

# forge-orchestrate

You are the **orchestrator**. You plan, delegate, and verify. You do not do the bulk of the implementation yourself. Everything runs inside T3 using its own tools (not the Forge dashboard's Tasks view).

## 1. Plan first
1. Read just enough code to understand the goal (use `Explore` or the `ollama-helper` MCP for broad scans).
2. Split the goal into tasks. Each task needs: a one-line goal, the files/areas it owns, acceptance checks (tests/commands), and a complexity label.
3. Mark which tasks are **independent** (can run in parallel) and which depend on others. Tasks that touch the same files must not run in parallel.
4. Show the user the plan as a short table (task, complexity, provider/model, depends on) and **wait for approval** before delegating. Skip the wait only if the user already said to proceed.

Complexity labels:
- **trivial**: mechanical, one file, obvious (renames, boilerplate, docs, log summaries).
- **normal**: a contained feature or fix across a few files with clear tests.
- **hard**: design decisions, cross-cutting refactors, security-sensitive, or tricky debugging.

## 2. Check quota and pick providers
- Run `npx tsx src/cli.ts usage` (from `/opt/the-forge`) for live Claude and Antigravity quotas, and `npx tsx src/cli.ts route <trivial|normal|hard>` to see what the Forge router would pick. Use `route <complexity> <provider>` to exclude a provider that is blocked or just failed.
- Call `orchestrator_capabilities` (once per thread) to see which T3 providers/models are actually enabled. Only enabled providers can be used. If a provider you wanted is disabled or missing, say so and pick the next best; never silently substitute.
- Defaults (adjust to the router and the live quota):
  - trivial: do it locally with `ollama-helper` (`local_draft_code`, review output) or a Haiku/Flash-class model. Ollama is not a T3 provider, so it cannot run a `delegate_task`.
  - normal: Sonnet-class on Claude, or a Gemini Flash model on Antigravity, whichever has more quota burning down before reset.
  - hard: Opus/Fable-class on Claude or the strongest Antigravity model, whichever the router ranks higher. Use higher effort only for hard tasks.
- Prefer spending the provider whose weekly quota is about to reset. Do not pick a provider the router reports as blocked.

## 3. Delegate
- Use `delegate_task` (load it with `ToolSearch` first). Put the provider/model/effort in `target.options`. Give each child a self-contained brief: goal, owned files, constraints, acceptance checks, and what to report back. Children do not see this conversation.
- Use `isolation: "worktree"` for every task that edits files, so parallel children never collide. Never create worktrees by hand in the shell.
- Launch independent tasks in the same turn. Launch dependent tasks only after their prerequisites have finished and you have checked the result.
- Follow each delegate's `next` instruction. Do not poll with `task_status`, sleep, or loops; you are re-invoked when children finish.
- Use `task_cancel` for runs that are replaced or no longer needed.

## 4. Verify and integrate
- When a child finishes, read its result, inspect its diff in the worktree (`t3_worktree_status`), and run the acceptance checks yourself.
- If a task failed or is low quality: re-brief once with the specific problem. If it fails again, **escalate**: re-run the router excluding that provider and use a stronger model. Do not loop.
- Review is a new `delegate_task`, not a message to an old child. Fix small review findings yourself.
- Integrate in dependency order. Resolve conflicts yourself. Follow the repo's branch rules: work lands on `ai-work`, and `npx tsx src/cli.ts promote <repo>` opens the PR into `main` for the user to merge.

## 5. Report
End with a short summary: what each task did, which provider/model ran it, what was verified, what is left, and any quota concerns. Link child threads by the `link` the tools return.

## Rules
- Never print or edit `generated/.env` or `buddy.env`.
- Ask before destructive actions (deleting branches, pruning volumes, force operations).
- For small jobs, skip all of this and just do the work; orchestration overhead is not worth it under roughly three tasks.
