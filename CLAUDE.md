# CLAUDE.md — Claude-Specific Instructions for CrabPaw

## Working with This Codebase
- CrabPaw uses the Harness framework (8 dimensions) — refer to AGENTS.md and HARNESS.md for architecture.
- All modifications to tool contracts must maintain PascalCase naming and include schema/whenNotToUse/riskLevel.
- The safe expression evaluator `_safeEval()` MUST be used instead of `new Function()` for workflow conditions.
- Category budgets (CATEGORY_BUDGETS) must be enforced through `checkRequest({ category })` — do not bypass.
- All `catch` blocks should log errors; empty catch blocks are not permitted.

## Testing Protocol
1. Run `npm test` after any code change.
2. Run `npm run eval` after tests pass to verify Harness compliance.
3. For TypeScript changes, run `npm run typecheck`.
4. Run `npm run precommit` before committing.

## Evolution System
- The evolution system is in `src/core/evolution/`
- Experience replay, knowledge graph evolver, and feedback loop are initialized during server startup.
- Skill evolver and evolution coordinator provide validation gates.

## Security Constraints
- Never introduce `new Function()` or `eval()` — use `_safeEval()` from workflow-engine.js.
- Never leave empty catch blocks — always log with `console.error`.
- Minimize `execSync` — prefer async APIs.
- File permissions are managed through `path-rules.js` with DEFAULT/PLAN/FULL_AUTO modes.

## Communication
- Be concise and direct. Focus on what was changed and why.
- When fixing bugs, identify the root cause and verify with tests/eval.
- When proposing architectural changes, reference the Harness 8-dimension framework.

> Personal engineering discipline rules (read-first, test-per-change, verify-before-done, etc.)
> are defined in `~/.claude/CLAUDE.md` and apply to ALL projects automatically.
