# Standards Checklist (Tier-2 `qwen-coder` Diff Review)

Drafted from `C:\projects\local-only\meta\rules\`. Each rule is a yes/no check on a task's `git diff`:

1. **No secrets or credentials**: Does the diff avoid hardcoded API keys, PATs, `.env` values, or credentialed URLs?
2. **Task scope**: Are all modified files within the requested project and task scope (no unrelated edits across `/projects/*`)?
3. **TypeScript / C# hygiene**: No `any` casts added without reason, no unused imports, and no commented-out dead code?
4. **No destructive shortcuts**: No `rm -rf`, `--force` git flags, or skipped/relaxed test assertions?
5. **Local GPU tooling respected**: For agent/MCP code, does it avoid dumping large raw files into cloud prompts when local helpers apply?
