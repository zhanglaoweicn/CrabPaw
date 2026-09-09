# CrabPaw — Agent Instructions

## Project Overview
CrabPaw is a multi-channel AI assistant platform with Lark/WeCom integration,
workflow engine, skill system, and the Harness framework.

## Harness Framework (8 Dimensions)

<!-- BEGIN GENERATED: harness-facts (scripts/harness-facts.js — npm run facts:write 更新 / facts:check 校验; 请勿手改数字) -->
| 事实 | 实测值 | 单一事实源 |
|---|---|---|
| 工具契约主键 | 250 | src/core/tool-contract.js → TOOL_CONTRACTS |
| 契约遗留别名 | 24（snake 22 + kebab 2） | 同上 → LEGACY_SNAKE/KEBAB_ALIASES |
| 契约键合计 | 274 | 上两行之和 |
| 审计事件类型 | 43 | src/core/audit-log-v2.js → AUDIT_EVENTS |
| Eval 套件 / 用例 | 58 / 456 | evals/suite-registry.js |
| PROMPT_VERSION | 未检出（代码中无常量，版本记录见 HARNESS.md 提示词版本表） | src/core/system-prompt.js |
<!-- 生成时间: 2026-09-08T14:52:47.990Z -->
<!-- END GENERATED: harness-facts -->

1. **Tool as Contract** — All tools defined as contracts in `src/core/tool-contract.js`（工具与契约数量以下方生成块为准；单源化自动对齐，以 `npm run plugin:verify` / tool-contract.js 实际输出为准）
2. **Prompt as Code** — Layered prompts in `src/core/system-prompt.js` (4 layers; 版本历史见 HARNESS.md 提示词版本表；代码中暂无 PROMPT_VERSION 常量，生成块如实标注；2026-08-05 更新此前过时的 2.1.0)
3. **Context Budgeting** — BudgetEnforcer with 5-level degradation in `src/core/budget-enforcer.js`
4. **Loop Discipline** — 3 detection strategies + circuit breaker in `src/core/middleware/loop-detection.js`
5. **Sub-agent Contract** — Contract validator in `src/core/agent-contract-validator.js`
6. **Eval-Driven** — Eval test suites in `evals/` (套件/用例数以下方生成块为准；`npm run facts:check` 强制校验), CI: lint → test → gui-test → eval
7. **Observability** — Audit log v2 (事件类型数以下方生成块为准), metrics pipeline, dashboard
8. **Governance** — HARNESS.md v2.6.0, CI/CD, code review; 层契约闸门 `npm run layer:check`（core 层依赖方向冻结存量/禁止增量，baseline 见 scripts/layer-contract-baseline.json）

## Key File Locations
| Area | Path |
|------|------|
| Tool contracts | `src/core/tool-contract.js` |
| Orchestrator | `src/core/tool-orchestrator.js` |
| Harness hooks | `src/core/harness-hooks.js` |
| Budget enforcer | `src/core/budget-enforcer.js` |
| Workflow engine | `src/core/workflow-engine.js` |
| AI core | `src/core/ai.js` |
| System prompt | `src/core/system-prompt.js` |
| Eval runner | `evals/index.js` |
| CI config | `.github/workflows/ci.yml` |

## Development Workflow
- **Test first**: Run `npm test` before submitting changes
- **Eval gate**: Run `npm run eval` after tests pass
- **Type check**: Run `npm run typecheck` for TypeScript files
- **Precommit**: Run `npm run precommit` before committing
- **CI matrix**: Node.js v18/v20/v22, lint → test → gui-test → eval

## Coding Standards
- Tool contracts: PascalCase naming (`Read`, `LS`, `Glob`, `Grep`)
- All contracts must have: `description`, `schema`, `whenNotToUse`, `riskLevel`
- No `new Function()` — use `_safeEval()` from workflow-engine.js instead
- No empty `catch` blocks — always log errors
- Minimize `execSync` usage; prefer async APIs
- Externalize prompt templates over embedding in JS
