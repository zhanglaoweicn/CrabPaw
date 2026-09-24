# bossagent 系统测评方案 v1.0

> 2026-09-03 · 基于 Runtime 差距分析实施轮（HARNESS v2.5.0）后的系统现状制定
>
> 定位：这是**系统级测评方案**，回答"bossagent 作为一套多渠道 AI 助手平台，现在到底行不行、稳不稳、贵不贵、能不能放心给用户用"。它与逐提交的 CI 门禁互补：CI 回答"这次改动有没有破坏既有行为"，本方案回答"系统整体处于什么水位"。

---

## 1. 测评目标与范围

**四个目标：**

1. **能力**——Agent 真能干活吗（工具调用、任务编排、知识检索、文档产出、语音交互）；
2. **可靠**——长任务、崩溃、断网、重启、并发下行为是否可预期（Run 生命周期、恢复、取消）；
3. **安全**——危险操作是否被正确拦住，权限体系故障时是否安全失败；
4. **成本**——一次交互烧多少 Token/钱，预算治理是否真的生效。

**测评对象（五个面）：**

| 面 | 范围 | 主要载体 |
|---|---|---|
| Runtime 内核 | ai.js 执行循环、RunStore、run-usage、request-interrupt、sse-broadcast | L3 演练 |
| Harness 工具层 | tool-contract（208 工具/233 契约键）、registry、权限、审批、MCP | L1+L2+L3 |
| 智能能力域 | memory（46 模块）、skill（68+22 目录）、RAG、subagent、taskflow、workflow | L2+L5 |
| GUI/语音 | Electron 前端、VoiceShell、TTS/ASR、审批卡、面板体系 | L4 |
| 治理与可观测 | audit-log-v2（43 事件）、metrics-pipeline、dashboard、HARNESS.md 合规 | L1+L3 |

**不在本方案范围：** 多租户隔离（产品为单用户桌面定位）、模型本身的能力评测（属供应商选型）。

---

## 2. 分层测评体系总览（L0–L5）

| 层 | 名称 | 测什么 | 载体 | 节奏 | 当前状态 |
|---|---|---|---|---|---|
| L0 | 静态基线 | lint / 类型 / 契约覆盖 / 插件门禁 | eslint、tsc、plugin:verify | 每次提交（CI） | ✅ 已有 |
| L1 | 单元回归 | 2207 个 jest 用例 + 729 个 GUI 用例 | `npx jest --forceExit`、`gui: vitest run` | 每次提交（CI） | ✅ 已有 |
| L2 | 行为能力 | Agent 决策/工具选择/输出契约是否合预期 | `npm run eval`（53 套件 429 用例） | 每次提交（CI） | ✅ 已有，能力域覆盖见 §4 |
| L3 | Runtime 演练 | 崩溃/断连/取消/审批/预算/故障下的真实行为 | 10 个 Drill（§5，脚本化中） | 每晚 + 发版 | 🚧 本方案新建 |
| L4 | 端到端场景 | 真实 GUI 操作路径、语音全链路 | web-gui-tester 脚本（§6） | 每周 + 发版 | 🚧 本方案新建 |
| L5 | 真实任务浸泡 | 连续多天真实使用下的退化与漂移 | soak 运行 + 日报（§7） | 每周审阅 | 🚧 本方案新建 |

**基线数字（2026-09-03 实测）：** jest 185 套件/2207 用例 · eval 53 套件/429 用例 100% · GUI vitest 76 文件/729 用例 · typecheck 干净 · CI = lint → test → gui-test → eval（Node 18/20/22 矩阵）。

---

## 3. L0/L1：工程质量基线

全部命令化，任何一项红灯即本次测评终止：

```bash
npm run lint            # 0 error
npm run typecheck       # tsc 干净
npm test -- --forceExit # jest 100%（185 套件 / 2207 用例，数字随代码演进刷新）
cd gui && npx vitest run # GUI 100%（排除已知 WIP 项须在报告注明）
npm run plugin:verify   # 插件门禁 exit 0
npm run precommit       # 提交前检查
```

**附加静态检查（每季度）：**
- 契约覆盖率报告：`getCoverageReport()`（tool-contract）——目标覆盖 ≥ 95%，未覆盖工具逐个列因；
- 审计事件覆盖：43 类事件每类最近 30 天至少出现一次真实样本（防"定义了从未发生"的死事件）；
- wiring 反证：`evals` 的 wiring 套件 + 全库 grep 确认无新增"零调用死代码"（本轮已删 run/manager.js ×2，防复发）。

---

## 4. L2：行为能力测评（eval 体系）

### 4.1 现有 53 套件 → 六大能力域映射

| 能力域 | 套件 | 测评问题 |
|---|---|---|
| 工具治理 | toolContracts、hooks、toolOrchestrator、pluginSystem、mcpSecurity、wiring | 模型选对工具了吗？危险输入被拦了吗？契约漂移会被发现吗？ |
| 上下文与记忆 | memorySystem、budgetEnforcer、embeddingPipeline、bossProfile、topicIndex、personalization | 记忆写入/召回对吗？预算降级链条对吗？ |
| 任务编排 | taskOrchestration、workflowParallel、condition、loop、templateConditionLoop、expertCollab、analysisPipeline | 多步任务结构对吗？并行/条件/循环语义对吗？专家委派正确吗？ |
| 语音与多模态 | voiceSession、voiceEvolution、ttsChunk、interrupt、echoHints、entertainmentTools、trainTools、typhoon、stockVoice | 打断/分块/会话续接语义对吗？ |
| 业务面板 | nl2sql、dataImport、businessData、riskAlert、stock 相关、scenarioReminders、trainTools | 领域输出契约对吗？ |
| 治理与审计 | harnessMetrics、harnessContracts、harnessLifecycle、eventBus、dryRunInspector、profileSystem、tagReinforcement、runStore、checkpointStore、capabilityMap、siteKnowledge | 治理组件行为契约对吗？ |

### 4.2 能力域补齐清单（本方案要求新增的 eval 用例）

| 优先级 | 新增用例 | 验证什么 | 验收 |
|---|---|---|---|
| P0 | run 生命周期 eval（已建 run_007–run_011） | 取消/断连/崩溃恢复/用量落盘 | 11/11 ✅ |
| P0 | capability_map eval（已建） | 子代理能力派生 + 契约漂移拦截 | 5/5 ✅ |
| P1 | disconnect-strategy eval | 断连 continue / cancelRequested → cancelled 的分类逻辑 | 纯函数级可测 |
| P1 | run-usage 边界 eval | 并发 run 隔离、收集器上限 200 淘汰 | 数值断言 |
| P1 | skill-version eval | frontmatter/metadata 命名空间版本读取优先级 | 数值断言 |
| P2 | cost-routing eval | auxiliary-client 12 类任务廉价模型映射 | 映射断言 |
| P2 | Plan 能力（当前缺失） | 待 Plan 实体落地后补"计划状态与执行状态投影"用例 | 依赖功能 |

**纪律（沿用 HARNESS.md 4.3）：** eval 100% 是合并门禁；新功能必须带新用例；用例数变化须同步 `eval:save-baseline` 防回归漂移。

---

## 5. L3：Runtime 可靠性演练（10 个 Drill）——本方案核心新增

每个 Drill 固定格式：**目的 / 步骤 / 通过标准 / 对应代码**。P0 五个先手工执行并留证（截图/日志），P1 脚本化为 `scripts/assessment/drill-*.js`。

### D1 崩溃恢复演练
- **目的**：验证"服务重启后正在运行的任务能不能恢复"（成熟度十问 #2）。
- **步骤**：发起一个会调用多个工具的长任务 → 任务执行中 `taskkill /F /PID <backend>` → 重启后端 → 打开 GUI。
- **通过**：恢复横幅出现且标注 interrupted；`data/.crabpaw/checkpoints/runrec_<runId>.json` status=interrupted、recoveredAt 存在；会话历史完整可续聊。
- **代码**：`run-store.js recoverInterruptedOnBoot()`、chat-handler finishRun。

### D2 断连续跑演练
- **目的**：验证"刷新页面 Run 会不会消失"（十问 #1，本循环的主修复）。
- **步骤**：发起长任务 → 任务中途刷新 GUI（Ctrl+R）→ 10 秒后回到页面。
- **通过**：后端日志出现"断连但 run 继续"；任务正常完成并落库；回到页面后 /events 按 seq 补发，最终回复完整可见；run 记录 detached=true、终态 finished。
- **代码**：chat-handler cleanup()、run-store.markRunDetached、sse-broadcast 持久化。

### D3 显式取消演练
- **目的**：停止按钮真停服务端且终态语义正确。
- **步骤**：长任务中点停止按钮。
- **通过**：2 秒内 LLM 流终止（后端日志中断断点）；run 终态 = cancelled（非 interrupted）；GUI 状态固化无幽灵生成中。
- **代码**：requests.js handleRequestCancel(runId)、useChatStream abort()。

### D4 新消息抢占演练
- **目的**：连发消息不产生双写/错轮次。
- **步骤**：任务执行中立即发送第二条消息。
- **通过**：旧 run interrupted、新 run running；旧 run 的工具事件仍锚定旧 roundId（activity-stream 无串轮）；unregister 所有权校验后新 run 仍可被取消。
- **代码**：request-interrupt.js、chat-handler roundId 锚定。

### D5 审批挂起与恢复演练
- **目的**：HITL 全链路（十问 #4）。
- **步骤**：触发高风险工具（如 email）→ 审批卡出现 → (a) 批准 (b) 拒绝 (c) 挂起 11 分钟 (d) 审批出现后刷新 GUI 再恢复。
- **通过**：run 状态经 waiting_approval → running；批准后原位继续执行；拒绝时工具失败回灌不崩轮次；APPROVAL_WAIT_MS 默认 10 分钟生效；刷新后审批卡经 GET /api/security/approval 恢复。
- **代码**：registry._requestToolApproval、approval.js、ApprovalHost 挂载恢复。

### D6 事件日志重放演练
- **目的**：跨重启断线补发（十问 #7）。
- **步骤**：产生 ≥1000 帧事件 → 记下客户端 lastSeq → 重启后端 → 客户端以 `?since=lastSeq` 重连。
- **通过**：补发遗漏帧、connected 帧 seq 接续不归零、重放序与直播序一致。
- **代码**：sse-broadcast.js `_persistEvent/_restoreFromEventLog`。

### D7 预算降级链演练
- **目的**：五级降级真实生效（十问 #6 的成本面）。
- **步骤**：构造 daily 花费跨过 0.6/0.8/0.95/1.0 阈值（测试环境注入 usage）。
- **通过**：LIGHT→窗口缩、MODERATE→禁贵模型换廉价、HEAVY→禁工具/禁流式+触发压缩、BLOCKED→硬阻断；budget 状态落盘。
- **代码**：budget-enforcer.js、two-phase-compaction.js。
- **已知偏差须在报告标注**：contextWindowSize 缩窗比例无消费者、压缩实际由窗口压力驱动（差距分析已记录）。

### D8 风险门与 fail-closed 演练
- **目的**：安全决策点在故障下安全失败。
- **步骤**：(a) 无人应答触发高风险工具；(b) 人为抛错权限系统。
- **通过**：(a) blocked + waiting_approval 记录；(b) 工具被拒、原因含"权限策略系统异常"、不崩进程。
- **代码**：registry.js C1、permissions.js A2。

### D9 工具故障治理演练
- **目的**：超时→熔断→护栏→反思链路。
- **步骤**：注册一个必超时/必失败的工具注入循环。
- **通过**：契约 maxTimeout 生效、连续失败 ≥5 硬停、circuit breaker 打开、失败反思注入下一轮。
- **代码**：tool-contract A1、tool-circuit-breaker、tool-guardrails。

### D10 长任务浸泡演练（周级）
- **目的**：内存泄漏、句柄泄漏、日志膨胀。
- **步骤**：连续 72h 运行（心跳/巡逻/定时任务开着），每小时采样 RSS、句柄数、data/ 增量、事件日志大小。
- **通过**：RSS 增长 < 20%/24h 且 GC 后回落；events/stream.jsonl 轮转正常（≤20MB×2）；无未捕获异常累积。

---

## 6. L4：端到端场景测评（GUI/语音）

用 ZCode 的 web-gui-tester/browser-use 能力驱动 Electron 渲染层（或手动脚本），每周跑一轮，每条场景记录视频/截图：

| # | 场景 | 关键断言 |
|---|---|---|
| E1 | 文本对话全链路 | chunk 流式渲染、工具卡状态机、done 固化、历史可回放 |
| E2 | 文档生成 | 上传→DocReader→生成 Word/PDF→file_generated→Artifact 工作区可见可下载 |
| E3 | 语音对话 | 语音输入→ASR→回复→TTS 播放；打断（ZCR）后 TTS 停止且会话不串 |
| E4 | 专家协作 | 意图触发或向导发起 → CollabOrbit 进度 → 聚合结果 |
| E5 | 审批双形态 | overlay 卡 + inline 接管（输入区禁用/恢复）双实例防重 |
| E6 | 设置与配置 | 模型配置改 Key→即时生效；MCP server 增删→工具发现 |
| E7 | 面板矩阵 | 股票/台风/日程卡投影出现与自动移除，无幽灵遮盖（回归 cd0ef00） |
| E8 | 空态与降级 | 无 API Key/断网时用户可见的明确降级提示（不允许白屏/静默失败） |

**通过标准：** 每场景核心断言 100%；发现 UI 层"假成功"（后端失败但 UI 显示完成）计为 P0 缺陷。

---

## 7. L5：真实任务浸泡与日报

- **场景集（每周 10 个固定任务 + 5 个随机任务）**：投标文件分析、周报生成、多文件重构、数据问答、邮件草拟、语音日程查询……统一记录：任务是否完成、轮次数、工具调用数、Token/费用（run-usage 自动采集）、人工修正次数。
- **日报内容**：任务成功率、平均轮次、成本分布、失败任务 Top 原因分类、memory/skill 误用样本（供 prompt 迭代）。
- **数据源**：`run-usage`（per-run）+ `metrics-pipeline`（延迟直方图/错误分类）+ `dashboard` JSON API + audit.jsonl（runId 已贯通，可直接按 run 聚合）。

---

## 8. 性能与成本基准

| 指标 | 定义 | 采集点 | 基准目标（首期建立，此后对比漂移） |
|---|---|---|---|
| TTFT | 发送→首 chunk | chat-handler 时间戳 | 本地记录分布 p50/p95 |
| 回合时延 | 发送→done | run 记录 startedAt→finishedAt | 简单问答 p95 < 15s；工具任务不设硬线只记录 |
| 工具成功率 | success/total | registry._logExecution | ≥ 95%（排除故意失败注入） |
| Token/回合 | prompt+completion | run-usage | 简单问答中位数 ≤ 3k；工具任务 ≤ 30k |
| 成本/回合 | 估算费用 | run-usage.costUsd | 日报呈现，月环比不增（同任务集） |
| 事件吞吐 | 帧数/回合 | events log seq 差值 | 记录基线；>10 万帧仍可恢复（D6 加强） |
| 启动时间 | 进程起→/events 可连 | server 日志 | p95 < 10s |

---

## 9. 安全测评

| 项 | 方法 | 通过标准 |
|---|---|---|
| 权限规则矩阵 | deny/ask/allow × 工具集遍历（eval 已有基础） | 每条规则行为与声明一致；ask 必出审批卡 |
| 高风险门 | D8 演练 | high 未豁免工具 100% 审批 |
| 沙箱写保护 | validateWrite 恶意路径样本集 | blockedPaths 全拦 |
| Prompt 注入 | mcp_security 套件 + cron 注入扫描器（CronPromptInjectionScanner）样本 | 100% 拦截已知样本 |
| 凭据治理 | credential-manager 落盘加密抽查；audit.jsonl 脱敏抽查 | 明文密钥零出现（含日志/事件/审计） |
| fail-open 清查 | grep 全库 catch 后返回 allowed/放行模式 | 安全决策点零 fail-open（本轮已清权限点） |

---

## 10. 评分卡（报告输出模板）

| 维度 | 权重 | 0 分锚点 | 3 分锚点 | 当前自评（2026-09-03） |
|---|---|---|---|---|
| 工程质量 | 15% | 套件红 | L0/L1 全绿 + 无死代码 | **3**（2207+729 用例全绿；SysInfoCard WIP 例外已注明） |
| 行为能力 | 25% | eval < 90% | eval 100% + 六能力域无空洞 | **2.5**（429/429；Plan 域空缺） |
| Runtime 可靠性 | 20% | 断连即杀/重启即丢 | D1–D6 全过 | **2.5→待实测**（能力已落地，演练未跑） |
| 安全 | 15% | 存在 fail-open | §9 全过 | **2.5→待实测**（fail-closed/风险门已落地） |
| 性能与成本 | 10% | 无数据 | 基线建立 + 漂移受控 | **1**（采集已具备，基线未建立） |
| 端到端体验 | 10% | 假成功频出 | E1–E8 全过 | **2→待实测** |
| 可观测 | 5% | 出问题黑盒 | run↔audit↔trace↔cost 贯通 | **2.5**（关联键已通，缺 span 树/OTLP 外发） |

**红线（任一触发即整体不通过，与分数无关）：** eval < 100%；安全决策点 fail-open；重启丢 run；审计出现明文凭据。

**结论分级：** ≥2.5 且无红线 = 可对外交付；2.0–2.5 = 内部使用；<2.0 = 停止对外演示。

---

## 11. 执行节奏与门禁

| 节奏 | 内容 | 产物 |
|---|---|---|
| 每次提交 | CI：L0→L1→L2 | CI 绿标（已有） |
| 每晚 | eval 全量 + 回归基线对比（eval:regression）+ D1/D3/D6 三个快演练 | 夜间报告 |
| 每周 | L4 八场景 + D2/D4/D5/D7/D8/D9 + 性能基准采样 + soak 日报审阅 | 周报（评分卡草稿） |
| 发版 | 全部 L0–L5 + 十问对照（附录 A）+ 红线检查 | 正式测评报告（评分卡定稿） |

---

## 12. 落地路线

**P0（本周，纯手工可执行）：** 按 §5 顺序执行 D1–D5 并留证；跑一次性能基准建立首期数字；把评分卡"待实测"项填掉。

**P1（1–2 周）：** `scripts/assessment/` 下脚本化 D1–D9（drill runner：起停后端、注入故障、断言日志与 runrec 终态、输出 JSON 结果）；L4 场景固化为 browser-use 脚本；周报生成器（读 runrec_/run-usage/metrics 聚合）。

**P2（按需）：** D10 浸泡自动化 + 告警；评分卡全自动出报告；Plan/RAG-rerank/复杂度路由三个功能差距落地后补对应 eval。

---

## 附录 A：成熟度十一问对照（文章《深入理解 Agent Runtime》第 23 节）

| # | 问题 | 2026-09-03 答案 |
|---|---|---|
| 1 | 刷新页面后 Run 会不会消失？ | **不会**（D2 验证） |
| 2 | 服务重启后任务能不能恢复？ | **恢复可见+可续聊**；断点续跑仍无（D1 验证边界） |
| 3 | 重复工具执行有无副作用保护？ | 只读缓存 15min；无幂等键（已知缺口） |
| 4 | 高风险操作能否暂停等审批？ | **能**，默认 10 分钟可配（D5 验证） |
| 5 | Subagent 能否独立取消/重试？ | 取消能；重试无 |
| 6 | 模型 API 超时怎么处理？ | rate-limit-guard + recovery-chain + 120s 预算 |
| 7 | 十万条流式事件后怎么恢复？ | **能补发**（落盘+seq 接续，D6 验证上限） |
| 8 | 并发 Run 有没有上限？ | 主对话无显式上限（已知缺口） |
| 9 | 租户隔离？ | 不适用（单用户桌面定位） |
| 10 | 一次 Run 多少 Token/钱？ | **能答**（run-usage per-run 汇总） |
| 11 | 出问题能否 Trace 定位？ | run↔audit↔trace↔cost 已贯通；缺 span 树 |

## 附录 B：命令速查

```bash
# 基线
npm run lint && npm run typecheck && npm test -- --forceExit && npm run eval
(cd gui && npx vitest run)

# Runtime 状态探针
curl localhost:38767/api/runs/active?userId=gui_user      # 最近 run 终态
tail -5 data/.crabpaw/events/stream.jsonl                  # 事件日志
cat data/.crabpaw/checkpoints/runrec_*.json | jq .status   # run 记录
tail -3 data/.crabpaw/audit/audit.jsonl | jq '{event,runId,traceId}'

# 演练辅助
taskkill /F /PID <pid>            # D1 崩溃注入
curl -X POST localhost:38767/api/request/cancel -d '{"userId":"gui_user"}'  # D3
curl "localhost:38767/events?since=<lastSeq>"               # D6 重放
```
