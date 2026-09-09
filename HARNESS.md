# CrabPaw Harness Engineering 规范 v2.6.0

> **Harness = Tools + Knowledge + Observation + Action + Permissions**
>
> 为 LLM 提供手、眼、记忆与安全边界的工程框架。

---

## 〇、单一事实源（自动生成）

> 2026-09-03 起，正文中的数量性断言一律以下方生成块为准（`npm run facts:write` 更新 / `npm run facts:check` 校验，接入 CI 与 precommit）。手改正文数字视为漂移。

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

## 一、Tool Contract 规范

### 1.1 原则
每个工具必须定义 JSON Schema 输入验证契约。契约与工具描述互补：描述告诉模型"何时用"，契约告诉模型"怎么用对"。

### 1.2 契约结构

```json
{
  "description": "工具用途的一句话描述",
  "whenNotToUse": ["不要用于……", "不要用于……"],
  "schema": { /* JSON Schema，定义输入参数类型、必填项、约束 */ },
  "maxTimeout": 30000,
  "riskLevel": "low | medium | high"
}
```

### 1.3 风险分级

| 级别 | 含义 | 示例 |
|------|------|------|
| `low` | 只读操作，无副作用 | Read, list_files, search_file, search_content, WebSearch |
| `medium` | 写入操作，可逆 | Write, Edit, apply_patch |
| `high` | 执行外部命令，不可逆 | Bash |

### 1.4 修改流程
1. 先在 `src/core/tool-contract.js` 中的 `TOOL_CONTRACTS` 添加/修改契约
2. 在 `evals/test-cases/tool-contracts.js` 添加对应测试用例
3. 运行 `npm run eval` 确保 100% 通过

---

## 二、Hooks 规范

### 2.1 生命周期

```
用户输入 → [PreToolUse Hooks] → 工具执行 → [PostToolUse Hooks] → 返回结果
```

### 2.2 内置钩子类型

| 钩子 | 类型 | 职责 |
|------|------|------|
| Safety Hooks | PreToolUse | 拦截危险命令（rm -rf /、mkfs、dd if=等） |
| PathPermission Hooks | PreToolUse | 文件路径读/写/执行权限检查 |
| 轨迹记录 | 不经 HookManager | 工具调用轨迹由 core/trajectory.js 的 TrajectorySaver 流式记录（ai.js 三处调用）；技能维度由 skill-metrics 记录（2026-08-30 删除从未注册的轨迹钩子死代码——审查另证实 harness-lifecycle 的 TrajectoryRecorder 亦为零接线纸面组件） |

### 2.3 钩子修改原则
- Hook 内部发生异常时静默降级（`console.warn` 记录），不得中断主流程
- PreToolUse hook 返回 `{ allowed: false }` 阻止工具执行
- PreToolUse hook 可通过 `modifiedParams` 修改工具参数

---

## 三、Task Mode 规范

### 3.1 检测策略

采用多因子负向优先启发式：
1. **负向过滤**：快速翻译、简短问候、简单查询 → 直接走普通对话
2. **正向信号**：任务关键词 + 结构模式 + 长度 + 多行输入 + 引用
3. **阈值**：综合得分 ≥ 0.25 判定为任务模式（常量 `TASK_THRESHOLD` 在 `src/core/task-mode-detector.js`，ai.js 消费同一常量；S6 已统一三处此前不一致的 0.25/0.35/0.45）

### 3.2 任务流程

```
检测到任务 → 匹配工作流模板 → 创建项目实体 → 异步执行阶段 → 进度回传
```

### 3.3 进度报告
- 每个阶段完成后推送 `progress` 事件
- 包含当前阶段名称、完成状态、主动建议
- 通过 ConversationIntegration 桥接到对话层

---

## 四、Eval 规范

### 4.1 评估维度

> 2026-09-03 更新：套件/用例数量以 §〇 生成块为准（`npm run facts:check` 强制校验），实际分类见下方。

| 维度 | 测试文件 | 通过标准 |
|------|---------|---------|
| Tool Contract | `evals/test-cases/tool-contracts.js` | 6/6 |
| Hooks | `evals/test-cases/hooks.js` | 28/28 |
| Task Mode | `evals/test-cases/task-mode.js` | 5/5 |
| Loop Detection | `evals/test-cases/loop-detection.js` | 26/26 |
| Memory System | `evals/test-cases/memory-system.js` | 10/10 |
| Multi-Format/Skills | `evals/test-cases/multi-format-output.js` | 13/13 |
| 其余套件 | sandbox/personalization/harness-metrics/harness-contracts/harness-lifecycle/workflow/evolution/budget-enforcer/tool-orchestrator/event-bus/dry-run-inspector/profile-system/tag-reinforcement/condition/loop/template-condition-loop/regression | 全部 100% |

### 4.2 运行方式

```bash
npm run eval          # 运行全部评估
node evals/index.js   # 等价命令
```

### 4.3 评估纪律
- **合并前**：所有 Eval 测试必须通过 (100%)
- **新功能**：新增功能必须同步新增测试用例
- **回归**：任何 Eval 失败阻塞 PR 合并

---

## 五、CI/CD 规范

### 5.1 流水线

```yaml
push / pull_request →
  lint (npm run lint, Node 18/20/22 矩阵) →
  test (npm test -- --coverage) 与 gui-test (tsc --noEmit + gui vitest) 并行 →
  eval (node evals/index.js + eval:regression 基线对比)

四个 job（lint/test/gui-test/eval，以 .github/workflows/ci.yml 实测为准）
```

### 5.2 阻塞规则
- `lint` 失败 → 阻塞后续阶段
- `eval` 有任何测试失败 → 返回非零退出码，阻塞合并

---

## 六、可观测性规范

### 6.1 轨迹记录
- 每次对话请求记录完整轨迹（输入、工具调用序列、LLM 响应、输出、耗时）
- 轨迹存储于 `data/.crabpaw/trajectories/` 目录（2026-09-03 Runtime 加固轮已归并：历史代码以 DATA_DIR 拼 `.crabpaw/trajectories` 形成的双嵌套 `data/.crabpaw/.crabpaw/` 已由 config.js `_migrateNestedDataDir()` 启动迁移归并为单层，全库 26 文件 40+ 处 `path.join(DATA_DIR, '.crabpaw', ...)` 已改单层，以实测目录为准）
- 保留时间：30 天

### 6.2 指标收集
- **延迟指标**：LLM 调用延迟、工具调用延迟、总量
- **吞吐指标**：请求数/周期、Token 数/周期
- **错误指标**：错误率、错误类型分布
- **成本指标**：Token 消耗、API 调用成本估算

### 6.3 Dry-Run 模式
```javascript
// 部署前安全预览，不执行模型或工具
chat(message, session, { dryRun: true })
```
检查项：工具契约覆盖率、钩子注册状态、路径规则初始化、CI/CD 配置存在性。

---

## 七、架构集成点

### ai.js 接入清单

| 组件 | 接入点 | 行号范围 |
|------|--------|---------|
| Tool Contract | 工具注册阶段，通过 `registerIntoRegistry()` | ~223 |
| Hooks | 工具注册阶段，通过 `registerIntoRegistry()` | ~224 |
| Task Mode Detector | `chat()` 函数开头，在工具构建之前 | ~1032 |
| ConversationIntegration | Task Mode 检测后，任务流程启动 | ~1037-1044 |
| Progress Reporter | 绑定到 ConversationIntegration | ~1041 |
| Dry-Run Inspector | `chat()` 第一个条件分支 | ~1024 |

### 注册模式
所有 Harness 组件采用统一的 `registerIntoRegistry(toolRegistry)` 模式接入：
- 不修改 ai.js 核心逻辑流程
- 不引入并行系统
- 使用现有的 `toolRegistry.addPreExecuteHook()` 通道

---

## 八、版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.0.0 | 2026-06-24 | 初始 HARNESS.md：Tool Contract + Hooks + Task Mode + Eval + CI/CD + Observability |
| 2.1.0 | 2026-06-25 | Delivery Pipeline + GUI TaskFlow + ToolOrchestrator wiring + CATEGORY_BUDGETS + real-time trajectory + 46/46 evals |
| 2.2.0 | 2026-07-28 | TTS 真流式(MSE MediaSource)、双WS统一、SceneShell KIND_REGISTRY、打断检测ZCR、面板体系、语音-媒体协调、依赖漏洞修复 |
| 3.0.0 | 2026-08-05 | S1: skill-router 自动触发接入 ai.js 双路径; S2: WorkflowEngine 补齐 9 个管理方法(/api/workflows 不再崩); S5: 子代理假回答改真实 LLM 调用+显式失败; S6: task 阈值统一(0.25) + PARALLEL branches 修复 + ask 权限走人工审批 |
| 2.3.0 | 2026-08-07 | 商用化冲刺：语音链路5修复(voice_play/voice-evolution/语音审批/DocReader+MediaStage语音/TTS排序)、B站直链解析、专家协作编排(CollabWizard+CollabOrbit+SSE)、8技能executor补全、Cmd+K命令面板、会话历史API、音频设备管理、Gateway启停、eval 231用例 |
| 2.4.0 | 2026-08-15 | 全面修复轮：专家协作接线（意图自动触发+SSE 每任务进度+看门狗）、工具命名 snake_case→PascalCase 收敛、全库空 catch 清理、wiring 反证测试套件、文档数字实测刷新 |
| 2.5.0 | 2026-09-03 | Runtime 差距分析实施轮：Run 生命周期（RunStore runId 级注册表+waiting_approval/cancelled+崩溃恢复横幅）、断连解耦（continue 策略，刷新不再杀 run；停止按钮走显式取消 API）、run 级取消（/api/request/cancel 带 runId）、per-run usage 采集（run-usage.js）、契约 maxTimeout 接线、riskLevel=high 强制审批（selfApproval 豁免）、权限 fail-closed、审批等待可配置（APPROVAL_WAIT_MS，默认 10min）、SSE 事件流落盘（events/stream.jsonl，跨重启断线补发+seq 连续）、audit 自动关联 runId/traceId（AsyncLocalStorage）、子代理 requiredCapabilities 回填（capability-map 派生）、Skill version 字段、数据目录双嵌套归并迁移、死代码 RunManager×2 删除 |
| 2.5.1 | 2026-09-03 | Runtime 优化轮（Harness/Runtime 分层治理）：P0——状态登记册（docs/状态登记册.md，认知/执行状态全盘点）、工具大结果迁移 tmpdir→DATA_DIR/tool-results（7 天 TTL 清理接线+旧路径兜底读）、并发 Run 闸门（CRABPAW_MAX_ACTIVE_RUNS 默认 2，超限抢占最旧）、TTFT 埋点（run-usage.recordTtft→run 记录）；P1——审批语义 checkpoint 落盘验证（approval-pending.json 启动恢复，链路 server.js:177→approval.initialize 确认已有）、SLO 基线报告脚本（scripts/assessment/slo-report.js，按 runrec 聚合 TTFT/时延/Token p50/p95，对应测评方案 §8） |
| 2.6.0 | 2026-09-03 | Plan 实体 + Artifact 深化轮：Plan——plan-store.js（计划对象化：planId/steps 状态机/revision，落盘 checkpoints/plan_*.json，plan:updated SSE 广播）+ PlanCreate/PlanUpdate 工具与契约 + system-prompt execute 模式引导 + 前端 PlanSection（Agent 右板进度投影，plan:updated 实时刷新）；Artifact——注册表 v2（version/status/runId/versions 血缘，同名同格式再生成版本+1 且旧物理文件归档 .versions/，同路径同大小防虚增）+ artifact:updated 广播 + FileGenPanel 历史产物版本徽章/状态点/实时刷新 |

---

*本规范是 CrabPaw Harness 工程的治理文件。所有 Harness 相关的设计决策、实现方案、测试标准均以本文档为权威参考。*

---

## 九、Operations Runbook (运维手册)

### 9.1 Hook Points Reference (接入点速查)

> **注意**: 行号为参考值，以函数名搜索为准。所有调用均包裹在 try/catch 中，不影响主流程。

| Hook Point | Module | Location | Purpose |
|------------|--------|----------|---------|
| `globalHarnessLifecycle.initialize()` | `ai.js` | 延迟 500ms 启动 | 一次性初始化 SelfHealing + RecoveryChain + FeedbackLoop + Metrics |
| `globalHarnessLifecycle.onLlmCallStart(model)` | `ai.js` | `chat()` LLM fetch 前 (≈L1512) | LLM 延迟测量起点 + metrics.increment |
| `globalHarnessLifecycle.onLlmCallSuccess(model, usage)` | `ai.js` | `recordUsage()` 后 (≈L1681) | LLM 成功记录 with token usage |
| `globalHarnessLifecycle.onLlmCallFailure(error, ctx)` | `ai.js` | LLM fetch catch 块 (≈L1555) | LLM 失败 + RecoveryChain trigger |
| `globalHarnessLifecycle.onToolCallStart(name)` | `ai.js` | `executeToolCall()` registry.execute 前 (≈L558) | 工具延迟测量 + metrics.increment |
| `globalHarnessLifecycle.onToolCallSuccess(name)` | `ai.js` | `execResult.success` 分支 (≈L593) | 工具成功记录 |
| `globalHarnessLifecycle.onToolCallFailure(name, err)` | `ai.js` | exec catch + success=false (≈L560, L573) | 工具失败 + SelfHealing trigger |
| `Dashboard` ↔ `MetricsPipeline` | `init.js` | `initialize()` 完成前 (≈L145) | 运行时指标仪表盘 HTML/JSON/OTel 导出 |
| `EventBus.publish(...)` | `events.js` → `harness-lifecycle.js` | 所有 on* 方法内 | 类型化事件发布 (tool:*, llm:*, session:*, system:*) |

### 9.2 Recovery Procedures (恢复流程)

| Failure Mode | Detection | Recovery Action | Responsible Module |
|-------------|-----------|-----------------|-------------------|
| Tool execution loop | `consecutiveFailures >= 5` | Halt loop, generate degraded reply | ai.js loop guard |
| Tool execution error | `!execResult.success` | Self-healing engine `attemptHeal` | self-healing-engine.js |
| LLM API error (rate limit) | HTTP 429 | Rate-limit guard wait + retry | rate-limit-guard.js |
| LLM API error (key exhaustion) | All keys failed | Fallback provider failover | fallback-provider.js |
| LLM API error (general) | classifyApiError | RecoveryChainOrchestrator | recovery-chain.js |
| Context window overflow | `globalContextWindowGuard.isNearLimit()` | Context compactor trigger | context-compactor.js |
| Budget exceeded | `ratio ≥ 0.8 / 0.95 / 1.0`（warning/critical/hardBlock 三档阈值，以 budget-enforcer.js 实测为准） | 中度降级 → 重度降级 → 硬阻断 + 自动压缩 | budget-enforcer.js |
| Session anomaly | `healthMonitor.checkIn()` | Health history audit | health-monitor.js |

### 9.3 Observability Integration Guide

**Metrics Pipeline (metrics-pipeline.js)**:
- Latency histograms: LLM calls (p50/p95/p99), tool calls
- Token trends: prompt_tokens, completion_tokens, cache hits
- Error categorization: by provider, model, error type
- Export: OpenTelemetry format

**Dashboard (dashboard.js)**:
- HTML dashboard with metric cards
- JSON API for external monitoring
- Bound to MetricsPipeline via `bindDashboardToMetrics()`

**Trajectory (trajectory.js)**:
- Full conversation trace saved at session end
- Timestamp, model, token usage per turn
- Compressed/stripped for storage efficiency

**Health Monitor (health-monitor.js)**:
- Session-level checkIn at start + end
- Anomaly detection on consecutive failures
- History stored at `data/.crabpaw/health/`

### 9.4 Debugging Checklist

1. Verify imports: `node -e "require('./src/core/ai')"` — should load without error
2. Check metrics: `globalMetricsPipeline.getSnapshot()` from within running process（以 metrics-pipeline.js 实测为准）
3. Inspect health: `getGlobalHealthMonitor().getHistory()` for session anomalies
4. Trace tool failures: search logs for `[harness] Self-healing`
5. Memory retrieval: check if `getUnifiedMemories` is returning results vs flat-file fallback

---

## 十、Multi-Format Output Capability (v2.3.0 更新)

### 10.1 多格式输出矩阵

| 格式 | Skill | 状态 | 说明 |
|------|-------|------|------|
| PDF | pdf-generator | ✅ 已有 | weasyprint/pandoc/reportlab |
| Word | word-docx | ✅ 已有 | MD→DOCX, 中国公文规范 |
| PPT | powerpoint-pptx | ✅ 已有 | 布局映射, 模板保真 |
| Markdown | markdown-converter | ✅ 已有 | 多格式→MD, markitdown |
| 文档互转 | doc-processor | ✅ 已有 | Word/PDF/Excel互转 |
| 图片编辑 | image-editor | ✅ 已有 | 裁剪/水印/格式转换 |
| **图表/架构图** | **diagram-generator** | ✅ **v2.2.0新增** | Mermaid/PlantUML, 前端MermaidBlock渲染 |
| **独立HTML报告** | **html-generator** | ✅ **v2.2.0新增** | 单文件独立HTML, 离线可打开 |
| **数据图表** | **chart-generator** | ✅ **v2.2.0新增** | ECharts/Chart.js服务端渲染PNG |
| **B站视频解析** | **bilibili-playurl** | ✅ **v2.3.0新增** | B站视频/音频直链解析，多清晰度降级 |
| **语音转录** | **voice-transcribe** | ✅ **v2.3.0新增** | ASR 语音→文本，4 家云端 Provider |

### 10.2 前端MermaidBlock集成
- GUI 已有 MermaidBlock 组件 (gui/src/components/MarkdownRenderers/index.tsx)
- diagram-generator 输出 Mermaid 代码块即可在前端渲染
- 需要独立文件时使用 mermaid-cli (mmdc) 导出 PNG/SVG

### 10.3 依赖要求
`ash
# diagram-generator (可选 - 仅导出PNG时需要)
npm install @mermaid-js/mermaid-cli puppeteer

# html-generator
npm install marked highlight.js

# chart-generator
npm install echarts canvas
`

---

## 十一、Harness 完整性状态 (v2.4.0)

| 层 | 组件 | 状态 |
|----|------|------|
| Layer 4: 治理层 | HARNESS.md | ✅ v2.4.0 |
| | Eval Framework | ✅ 套件/用例数以 §〇 生成块为准（`npm run facts:check` 校验） |
| | Tool Contracts | ✅ 完整覆盖（契约数量口径以 §〇 生成块为准；单源化自动对齐，以 `npm run plugin:verify` / tool-contract.js 实际输出为准） |
| | Eval Suites | ✅ 用例数以 §〇 生成块为准（`npm run facts:check` 校验） |
| Layer 3: 可观测层 | Dashboard | ✅ JSON+HTML+OTel |
| | Metrics Pipeline | ✅ 319L（2026-08-30 实测，以 wc -l 输出为准） |
| | Trajectory | ✅ 198L（2026-08-30 实测，以 wc -l 输出为准） |
| Layer 2: 任务层 | TaskFlow Bridge | ✅ 230L（2026-08-30 实测，以 wc -l 输出为准） |
| | ConversationIntegration | ✅ 与Runtime绑定 (v2.2.0修复) |
| | Progress Reporter | ✅ 120L（2026-08-30 实测，以 wc -l 输出为准） |
| Layer 1: 基础层 | Tool Registry | ✅（工具数以 §〇 生成块为准，`npm run plugin:verify` / registry 实际输出为准） |
| | Skill System | ✅ skills/ 68 个目录（含 58 个 SKILL.md）+ data/skills/ 22 个目录（含 20 个 SKILL.md，其中 2 个与 skills/ 重名）——两目录口径并列、不合并为单一数字（2026-08-30 实测，以 ls 实际输出为准） |
| | Context Budget | ✅ |
| | Sub-agent Contract | ✅ |

---

## 十二、专家协作编排 (v2.3.0 新增, v2.4.0 修正)

### 12.1 架构

专家协作编排系统允许一个主代理将子任务委派给多个领域专家代理并行执行，并聚合结果。

```
用户请求 → 意图分析(intent-analyzer) → 双入口：
                │                      ├─ 意图命中多专家协作 → auto-collab 自动触发
                │                      └─ GUI 手动向导(CollabWizard) → POST /api/experts/collab/start
                ▼
   collaboration.startCollaboration（同会话 running 幂等去重）
                ▼
   runCollab：delegateTasks 并行委派（并发 3，整体看门狗 10 分钟）
                │
        ┌───────┴───────┐
        ▼               ▼
  collab:progress    collab:completed / collab:error
  (每任务完成即广播)   (汇总终态，按任务 id 聚合)
```

### 12.2 核心组件

| 组件 | 位置 | 职责 |
|------|------|------|
| Collaboration API | `src/core/experts/collaboration.js` | `startCollaboration` / `getCollabStatus` / `listCollaborations` / `recordActivity` / `getActivities` / `runCollab` |
| 自动触发 | `src/core/experts/auto-collab.js` | 意图命中多专家协作时自动发起（幂等：同会话 running 去重） |
| CollabWizard | `gui/src/components/ExpertsPanel/CollabWizard.tsx` | GUI 手动协作向导（1.5s 轮询状态） |
| CollabOrbit | `gui/src/components/CollabOrbit/index.tsx` | 专家协作轨道可视化（消费 collab:* SSE） |
| Expert API | `gui/src/components/ExpertsPanel/api.ts` | 前端-后端协作通信 |
| SSE 推送 | `src/core/experts/collaboration.js` | `collab:started/progress/completed/error` 实时推送到前端 |

### 12.3 工作流（意图自动触发 + GUI 手动向导双入口）

1. 聊天路径：intent-analyzer 命中「多专家协作」（技能提示 agent-team-orchestration 或消息多专家/协作语义）→ `auto-collab.maybeAutoStartCollab` 自动发起；同会话存在 running 协作则跳过（幂等，防与手动路径重复执行）
2. GUI 路径：CollabWizard 手动选择 2-4 个专家与各自子任务 → `POST /api/experts/collab/start`
3. `startCollaboration` 校验专家、组装任务定义（注入专家 systemPrompt），异步执行不阻塞请求
4. `runCollab` 经 `delegateTasks` 并行委派（并发 3），每任务开始/完成即广播 `collab:progress`（running/done/error 态实时可见）
5. 整体看门狗（默认 10 分钟）超时：中止未完成子任务并标记 `timeout`，汇总不挂死
6. 全部完成后按任务 id 聚合结果，广播 `collab:completed`（全失败时 `collab:error`）；汇总为拼接各专家产出，无 LLM 二次调用

### 12.4 测试覆盖

- `evals/test-cases/expert-collaboration.js` — 9 个用例（启动校验、专家校验、成功完成、混合失败、活动读写、SSE 每任务进度、重复 expertId 聚合、看门狗超时、自动触发幂等）

### 12.5 部门化组织（2026-09-04 P1-P3，专家协作的组织层扩展）

专家库按"部门 → 岗位"组织（判据：老板遇到这件事会去哪个抽屉找，不按大企业组织架构）。核心语义：**岗位 = 人设 + 工具面 + 技能包三元组；部门 = 路由作用域 + 编排单元**。

| 组件 | 位置 | 职责 |
|------|------|------|
| 部门注册表 | `src/core/experts/departments.js` | 七部门（财务/营销/销售/人力行政/技术数字/法务合规/战略投资）、DIVISION_POLICY 编制政策、岗位别名、班组模板、部门工具面/技能包（jest: `departments.test.js`） |
| 导入管线 | `scripts/build-expert-org.js`（`npm run experts:org`） | agency-agents 268 位 → `data/experts-org.json`：在编 90 / 泊车 178（泊车=外部人才库，可显式召唤不参与自动路由），routingKeywords 清洗 |
| 两级路由 | `src/core/experts/index.js` `routeMessage` | 部门别名命中集 + 岗位别名强匹配（×2）+ 泊车排除 |
| 召唤解析 | 同上 `resolveSummon` + `POST /api/experts/summon` | id/岗位别名→精确激活（泊车显式可达）；部门→主管接通；多候选→消歧载荷 |
| 部门例会 | `collaboration.js` `startDepartmentMeeting` + `POST /api/experts/collab/department` | 两级树：成员并行 → 主管汇总（`opts.quietCompletion`，synthesis 任务条目） |
| 工具面 enforcement | `ai/tool-definitions.js` Level4 + `expert-context.getActiveExpertToolsets` | 激活专家时收窄工具面（+general/web 基线，20% 地板守卫）；实测财务顾问 34/102 |
| 技能面偏置 | `skill-router.js` + `getActiveExpertSkills` | 本岗位技能 ×1.3 / 非本岗位 ×0.3 降权不剔除（工具是能力边界可收窄，技能是知识包只偏置） |
| 语音召唤 | `voice-panel-commands.ts` `detectExpertSummonCommand` + VoiceShell 确认环 | 说事自动转接（L0）/点名消歧（L1）/精确指令与例会提案→应答→发车（L2）；岗位音色 `resolveExpertTtsVoice` |

验收门：`evals/test-cases/expert-org.js` 8 例（部门完整性/管线产物/两级路由/召唤四形态/班组引用/例会两级树/工具面 enforcement/技能面偏置）+ `departments.test.js` 11 例。**纪律：部门/别名/班组改动必须同步 expert-org 断言；七部门与别名表是语音体验的地基，不得静默漂移。**

---

## 十三、技能 Executor 完整性 (v2.3.0 新增)

### 13.1 统一执行引擎

`src/core/skill-executor.js` 提供统一的技能执行接口，所有技能 executor 遵循相同契约：

```javascript
// 执行契约
{
  skill: string,        // 技能名称
  action: string,       // 执行动作
  params: object,       // 输入参数
  options: object       // 执行选项（超时、重试、格式等）
}
```

### 13.2 8 个技能 Executor 清单

| Executor | 技能 | 状态 | 说明 |
|----------|------|------|------|
| pdf-generator | PDF 生成 | ✅ | weasyprint/pandoc/reportlab |
| word-docx | Word 文档 | ✅ | MD→DOCX，中国公文规范 |
| powerpoint-pptx | PPT 演示 | ✅ | 布局映射，模板保真 |
| html-generator | HTML 报告 | ✅ | 单文件独立 HTML |
| diagram-generator | 图表/架构图 | ✅ | Mermaid/PlantUML |
| chart-generator | 数据图表 | ✅ | ECharts/Chart.js |
| image-editor | 图片编辑 | ✅ | 裁剪/水印/格式转换 |
| bilibili-playurl | B站直链解析 | ✅ | 视频/音频直链，多清晰度降级 |

### 13.3 能力注册

`src/taskflow/skill-capability-registry.js` 维护技能能力注册表：
- 从 SKILL.md frontmatter 自动发现能力声明
- 运行时查询可用 executor 及其参数约束
- 支持能力组合（如"生成 PDF + 插入图表"）