# CrabPaw HARNESS 架构逻辑完整性审计报告

- **项目**：CrabPaw (v2.2.0)
- **审计对象**：HARNESS 框架 8 维度（工具契约 / 提示分层 / 上下文预算 / 循环纪律 / 子代理契约 / 评估驱动 / 可观测性 / 治理）；**并并入前端页面深度扫描（前后端对齐 + 业务逻辑，见 §八）**
- **审计日期**：2026-08-28
- **审计性质**：只读核验（未修改任何代码；所有引用为「文件:行号」实读所得）
- **基准口径**：以当前工作区源码为准；文档声明取自 AGENTS.md / HARNESS.md v2.4.0 / README.md / CLAUDE.md / DEVELOPMENT_MANUAL.md

---

## 一、执行摘要

**总评定：框架完备、闭环裂开。**

HARNESS 8 个维度在**实现层**都有真实、可运行、被消费的零件，没有任何「整模块不存在」或「CI 彻底失效」的空壳。但存在两类实质问题：

1. **两个逻辑实体断裂**（逻辑完整性的最实质缺口）：
   - **子代理契约「名字错位型弱接线」**——校验器被调用，但因契约名与实际 spawn 类型对不上，对真实委派类型的"强制校验"实际退化、不生效。
   - **评估门禁当前为红**——实跑 99.8%（417/418），唯一失败 `collab_009`；HARNESS §1.4/§4.3「合并前 Eval 100%」门禁此刻被打破，CI eval 检查会同红阻塞合并。

2. **治理文档系统性失真**——HARNESS.md / AGENTS.md / README.md / DEVELOPMENT_MANUAL.md 在**数字口径、方法名、行号、CI 阶段数、路径层级、版本序列**上互相矛盾且与代码脱节（详见 §四）。

此外存在若干**空转/死代码组件**（定义了但无消费方），以及评估实跑暴露出的**运行期真实 bug**。

---

## 二、各维度核验结论

> 状态图例：🟢 完整可用 · 🟡 部分可用（存在依赖/数字失真）· 🔴 逻辑断裂（实质缺口）

### 维度 1｜工具即契约 🟡
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| TOOL_CONTRACTS 键数 | **231** | HARNESS §11：235 | ✗ |
| PascalCase 合规键 | **207** | AGENTS：205 | ✗ |
| 去重（引用相等）契约对象 | **209** | HARNESS §11：208 | ✗ |
| 引用别名数 | **22** | HARNESS §11：27 | ✗ |
| 字段完整性 | description/schema/whenNotToUse/riskLevel **缺失均为 0** | 四字段必含 | ✅ 齐全 |

- 契约经**两条独立路径**被消费，非「未接线」：① `tool-orchestrator.js:561-575` 直接 `getToolContract/validateToolInput`；② `registerIntoRegistry`（`tool-contract.js:1219`）挂 `addPreExecuteHook`，在 `ai.js:289/292` 调用。
- **命名规范例外**：24 个非 PascalCase 键，其中 22 个 snake_case 属 `LEGACY_SNAKE_ALIASES`（`tool-contract.js:1174`）的有意向后兼容别名；**`html-presentation`、`presentation-builder`（:693/:699）是真正的命名违规**（kebab-case，且不在别名表）。
- 别名不构成重复：`Taskflow/taskflow`、`Todo/todo` 为同一对象引用。

**结论**：契约体系完整且已接线；唯一问题是文档数字全面过期 + 2 处真命名违规。

### 维度 2｜提示即代码 🟢
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| PROMPT_VERSION | **'3.0.0'**（system-prompt.js:2） | 3.0.0 | ✅ |
| 分层 | **4 层**：stable/extended/context/volatile（`buildLayeredSystemPrompt` :1430） | 4 层 | ✅ |

- 注意：文件内另有 `buildCompactPrompt`（:1342，3 段结构），**仅 :1747 导出、全 src 无消费方**（空转组件）。
- `PROMPT_LAST_MODIFIED='2026-07-14'`（:3）与文档宣称的更新时间（2026-08-05）不一致。

**结论**：主路径 4 层属实；存在一处未接线构建器 + 一处常量未同步。

### 维度 3｜上下文预算 🟢（含 1 处文档失实）
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| 降级级别 | **NONE/LIGHT/MODERATE/HEAVY/BLOCKED** 5 级（budget-enforcer.js:6-47） | 5 级降级 | ✅ |
| 分类预算 | **8 类 CATEGORY_BUDGETS**（reasoning/tool_call/memory/streaming/tool_validation/observability/internal/evolution，:633-650） | 通过 `checkRequest({category})` 强执法 | ✅ |
| 触发阈值 | ratio ≥ 0.8 / 0.95 / 1.0（:390-409） | HARNESS §9.2「watermark>0.7」 | ❌ **失实**（无 watermark 字段/0.7 阈值） |
| 强制调用 | ai.js:1447/1466/3296、budgeted-evolution-client.js:52 | — | ✅ |

- `checkRequest` 存在 2 个可控绕过：`advisoryMode` 全局开关（:93,195-236 恒放行只警告）；`internal` 分类 `dailyLimit: Infinity`（:646，属有意「只统计不拦截」）。
- `getBudgetEnforcer()` 单例使用硬编码默认限额（:84-88），非配置文件驱动。

**结论**：5 级降级 + 分类预算真实强制；仅 HARNESS §9.2 的 `watermark>0.7` 表述失实。

### 维度 4｜循环纪律 🟢
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| 检测策略 | **3 级**（RepeatFailureGuard：Hard Reject / Same Signature / No Progress，:151-211） | 3 策略 | ✅ |
| 熔断 | 语义由 RepeatFailureGuard 阈值（3/5/8）+ `ai.js` 结果标志 `{circuitBreaker:true}`（:533 等）承担 | circuit breaker | 🟡（无同名组件） |
| 调用路径 | `ai.js` 手动 `_detectLoop`（:1841/:3623）；`consecutiveFailures>=5` 兜底（:1894/:1911） | ai.js loop guard | ✅ |
| HARNESS §9.2 兜底 | `MAX_CONSECUTIVE_FAILURES=5`（:1894），`shouldForceStop()||consecutiveFailures>=5`（:2251） | consecutiveFailures>=5 | ✅ |

- 注意：`LoopDetectionMiddleware` 虽注册进 `createDefaultMiddlewareChain`（middleware/index.js:125），但该链**全仓无消费方**；`beforeModel/afterModel` 不被链触发，检测实际走 ai.js 手动路径。

**结论**：3 级检测 + 熔断语义 + 兜底均落地；仅「circuit breaker 无同名组件」「中间件链未被消费」属命名/形态与文档设想有别。

### 维度 5｜子代理契约 🔴（逻辑断裂）
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| 文件/导出 | agent-contract-validator.js（273 行）+ `globalAgentContractValidator` 单例 | src/core/agent-contract-validator.js | ✅ |
| 被调用 | subagent.js:404 `validateSpawn`、subagent-enhanced.js:824 `enforceSpawn` | — | ✅（有调用） |
| 生效性 | **契约名 coder/researcher/planner/analyst/communicator ≠ 实际 spawn 类型 research/implement/verify/analyze/coordinator/worker**（subagent-enhanced.js:30-37） | — | ❌ **名不对位** |

- 后果：`subagent.js` 对 research/implement 等返回 `{valid:true, warnings:["No contract…"]}`（**永不 throw**）；`subagent-enhanced.js` 对 research/worker/analyze 直接 `skipping validation`。
- 即对**真实委派类型**，"强制校验"退化为无契约 warning 或跳过，**实际基本不生效**。

**结论**：已接线但「名字错位型弱接线」，是维度 5 最实质的逻辑洞。

### 维度 6｜评估驱动 🔴（门禁当前为红）
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| 套件数 | **52**（evals/test-cases/，全注册、无孤儿、无跳过） | 53（AGENTS）/22（HARNESS）/15（README） | ❌ 全不符 |
| 用例数 | **418** | 424/194 | ❌ 全不符 |
| 实跑结果 | **99.8% (417/418)，退出码 1** | 100% | ❌ **当前非 100%** |
| 唯一失败 | `[collab_009] auto-trigger is idempotent per session and intent-gated`（expert-collaboration.js） | 应全过（§12.4） | ❌ |

- 实跑暴露运行期 bug/噪音：`config.js:1289 yaml.load is not a function`（yaml@2.8.3 无 `.load`，**疑似真实 bug**）；`self-awareness Cannot find module '../../tools/registry'` 反复报错；`weighted=100%` 与 99.8% 不一致（指标诚实性存疑）；模块加载期 tool-contract 「自动对齐 62 个契约」副作用。
- CI eval 步骤无 continue-on-error，`npm run eval` 任一失败即退出码 1 → 阻塞合并（若分支保护设为 required）。**当前 417/418，该检查为红。**

**结论**：基础设施真实、覆盖充分；但数字全错、门禁当前被打破、运行期高噪音。

### 维度 7｜可观测性 🟡
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| 审计事件 | **43**（audit-log-v2.js AUDIT_EVENTS） | AGENTS：42 | ✗ 差 1（漏数 SKILL_CREATE） |
| 审计消费 | 真实消费（directive-manager:122/152/174、tools/index:84/91/100/112、mcp-manager writeAuditEntry 等） | 隐含"是活的" | ✅ |
| 指标/仪表盘/轨迹/健康 | metrics-pipeline/dashboard/trajectory/health-monitor 均存在；`bindDashboardToMetrics`/`getGlobalHealthMonitor`/`globalMetricsPipeline` 绑定真实 | §9.1/§9.3 | ✅ |
| 四类指标 | 延迟✓ 吞吐✓ 错误✓ **成本✗**（core 版 metrics-pipeline 无 cost 字段；成本在 usage-stats/cost-sensor/perception 模块） | §6.2 四类 | 🟡 口径错位 |
| 轨迹 30 天保留 | `cleanup(maxAgeDays=30)` **从未被调度**；流式方法也是死代码；实际路径 `data/.crabpaw/.crabpaw/trajectories`（**多一层 .crabpaw**） | §6.1 存 DATA_DIR/.crabpaw/trajectories，保留 30 天 | 🟡 保留未生效 |

**结论**：功能件齐全且多数真实消费；但 30 天保留名存实亡、成本指标错位、第 43 事件与文档 42 不符。

### 维度 8｜治理 🟡
| 项 | 实际 | 文档声明 | 结论 |
|---|---|---|---|
| CI 流水线 | **lint(18/20/22) → test(needs lint, 矩阵, coverage) → eval(needs test, node20, + regression v3)** | §5.1 只画 lint→eval | ❌ 漏写 test 阶段 |
| CI 可执行 | YAML 语法有效、依赖链完整、脚本齐全，非空壳 | — | ✅ |
| 版本 | 文件头/§11/AGENTS.md 三处 v2.4.0 | v2.4.0 | ✅ 一致 |
| 版本表 | §8 在 2.4.0(08-15) 之后又列「3.0.0(08-05)」，日期更早却排在后 | — | ❌ **乱序**，且与正文 v2.4.0 矛盾 |

**结论**：CI 真实可执行且比文档更完善；但 §5 描述漏阶段、§8 版本表乱序。

---

## 三、空转 / 死代码组件清单

| 组件 | 位置 | 问题 |
|---|---|---|
| `createTrajectoryHooks` | harness-hooks.js:359 | 定义了**从未注册**（§2.2 声称已挂 Pre/PostToolUse；实际轨迹走 harness-lifecycle/skill-metrics 的 TrajectoryRecorder） |
| `buildCompactPrompt` | system-prompt.js:1342 | 仅导出、无消费方 |
| `createDefaultMiddlewareChain` | middleware/index.js:125 | 无消费方；循环检测走 ai.js 手动路径 |
| 轨迹流式方法 / `cleanup(30)` | trajectory.js | 从未被调度；保留策略实际未生效 |
| `AgentContractValidator`（对真实类型） | agent-contract-validator.js | 契约名与实际 spawn 类型错位 → 强校验失效 |

---

## 四、文档 − 实现失效点汇总（建议订正）

| 声明（文件: 口径） | 实际值 | 问题 |
|---|---|---|
| 契约 205 (AGENTS) / 208·235·27 (HARNESS) | 231 / 209 / 22 别名 / 207 Pascal | 全部过期且互相矛盾 |
| 评估 53/424 (AGENTS) / 22·194 (HARNESS) / 15 套 (README, DEV_MANUAL) | **52 / 418** | 全部过期 |
| 技能 68 (AGENTS/README) / 257 (HARNESS) | `skills/`57 + `data/skills/`20（有重叠） | 口径矛盾、两目录重复 |
| 审计 42 事件 (AGENTS) | **43** | 差 1 |
| §9.2 `budgetCheck.watermark>0.7` | 无 watermark；ratio≥0.8/0.95/1.0 | **失实** |
| §9.4 `globalMetricsPipeline.getStats()` | 不存在，实为 `getSnapshot()` | **方法名错误** |
| §5.1 CI「lint→eval」 | 实际 lint→test→eval | 漏 test 阶段 |
| §9.1 行号 | 偏移 80–130 行（L1512→1593 等） | 过期 |
| §11 行数 232L/177L | 实际 320/198 | 陈旧 |
| §6.1 轨迹路径 | 实际 `data/.crabpaw/.crabpaw/trajectories`（双嵌套） | 多一层 |
| §8 版本表 | 3.0.0 排在 2.4.0 后且日期更早 | 乱序 |
| §6.2 四类指标 | core 版 metrics-pipeline 缺「成本」 | 口径错位 |
| PROMPT_LAST_MODIFIED='2026-07-14' | 文档宣称 2026-08-05 更新 | 常量未同步 |
| PascalCase 规范 | `html-presentation`、`presentation-builder` 真违规 | 命名规范例外 |
| HARNESS §4.1 逐套件通过标准 | tool-contracts 6/6→实 9、hooks 28/28→实 34；列出已不存在的 autopilot/workflow/regression 套件 | 陈旧 |

---

## 五、结构与接线完整性（无空壳）

经核验，以下组件均**真实存在且被消费**，不构成「只定义不执行」：
- 工具契约（两条消费路径）、提示 4 层、预算 5 级、循环 3 级检测与兜底
- 子代理校验器（被导入调用，但因名字错位对真实类型失效——功能性存在）
- 任务模式（`detectTaskMode` ai.js:1298，阈值 0.25）、dry-run inspector（ai.js:1266）
- 审计日志（43 事件真实落库）、指标/仪表盘/轨迹/健康监控及绑定关系
- CI 三阶段（lint→test→eval）可执行并可阻塞合并

---

## 六、优先级修复建议

| 优先级 | 事项 | 说明 |
|---|---|---|
| 🔴 P0 | **维度5 子代理契约名字错位** | 补注册 research/implement/verify/analyze/coordinator/worker 契约，或对齐契约名 |
| 🔴 P0 | **让评估门禁转绿** | 修 `collab_009` + 实跑暴露的 `config.js:1289 yaml.load is not a function`、`self-awareness Cannot find module '../../tools/registry'`，回到 418/418 |
| 🟡 P1 | **订正 HARNESS.md/README/AGENTS 数字** | 契约 231/207/209/22、评估 52/418、技能口径、审计 43、§9.2/§9.4/§5/§8/§11/§6.1/§9.1 |
| 🟡 P1 | **接线/清理死代码** | Trajectory Hooks 注册、buildCompactPrompt 消费或删除、轨迹 cleanup(30) 调度、中间件链消费方 |
| 🟢 P2 | 其余 | checkRequest 绕过口评估、`html-presentation/presentation-builder` 命名、`PROMPT_LAST_MODIFIED` 同步、双 `.crabpaw` 路径归并 |

---

## 七、审计方法

- 直接静态核验：读取 `HARNESS.md`/`AGENTS.md`/`CLAUDE.md`/`README.md` 与核心源码（`src/core/`），统计契约/事件/指标/套件数，grep 接线与引用。
- 实跑验证：`node evals/index.js`（120s 内完成，得 99.8% 417/418）、`npm run typecheck`（GUI）等。
- 并行委派：按 8 维度拆分 4 个只读子代理核对各自实现与文档声明；结论互相印证。
- 未修改任何源码；审计仅报告事实与证据。

---

## 八、前端页面深度扫描：前后端对齐与业务逻辑审计

> 本章节由前端深度扫描（仅前端 `gui/` 与后端 `src/` 交叉核验）并入；日期 2026-08-28，只读。方法：① 运行 `src/test/frontend-routes.contract.test.js`（端点存在性）；② 运行时实测加载 GUI + 管理舱记录网络响应；③ 按区域拆分 4 个只读子代理核验载荷/SSE/业务逻辑。

### 8.1 对齐健康度（确认）

| 检查面 | 结论 |
|---|---|
| 端点存在性 | ✅ 契约测试 **5/5 通过**；运行时加载 GUI + 管理舱 **38 请求全 200**（无 404/500） |
| WS/SSE 端点 | ✅ `/voice/cloud`、`/scene`、`/events` 均有后端支撑（voice-cloud-ws.js / scene-server / handleSSEEndpoint） |
| SSE 事件名 | ✅ 全部一致（activity / turn_complete / heartbeat / scene:change / voice_play / task:update / filegen:* / meeting:* / collab:* / skill:* / approval_* / workflow:* / schedule:updated / wecom_message / file_generated + 12 个 AG-UI 名，两侧 AGUI 枚举一致） |
| 载荷对齐 | ✅ `/chat`、`/voice/cloud`、TTS、`/config`、`/config/user`、`/api/profiles*`、`/api/fallback/*`、`/api/backup/*`、`/api/security/config`、`/api/cockpit/overview`、`/api/memory/*`、`/api/kb/*`、`/api/meetings/*`、`/api/filegen/*`、`/api/usage`、`/skills*`、`/api/experts*`、`/api/experts/collab/*`、`/api/security/approval`、`/api/scene/*` 字段/类型/必填/响应读取一致 |

### 8.2 发现的问题（按严重度）

**🔴 P0 崩溃级**
- **CommodityPanel 响应结构读取错位 → 直接崩/历史恒空**
  - 前端 `gui/src/components/CommodityPanel/index.tsx:60-69` 成功路径 `setResult(res)` 后读顶层 `result.items/stage/note/screenshot/source`、`(res as any).rows`；后端 `src/handlers/local-handlers/commodity.js:17/27` 返回**扁平** `{success,...result}` / `{success,rows}`。
  - 根因：`gui/src/lib/api.ts:263-274` `requestFetch` 把「无 `data` 字段的成功响应」剩余字段整体装进 `res.data` → 实际数据在 `res.data.items/rows`，前端却读 `res.items`（undefined）。
  - 后果：`sortItems(undefined)` 执行 `[...undefined]` 抛 **TypeError → 组件崩溃**（ErrorBoundary 拦截）；查询历史 `res.rows`=undefined → 历史永远为空。
  - 修复：前端改读 `res.data.items/...`（或 `extractApiData(res)`），或后端归一化 `{success,data:{...}}`，二选一。

**🟠 P1 业务逻辑**
- **会议转写分段排序乱序**：`useMeetingTranscription.ts:128` 用字典序（未加 `numeric:true`），ASR 段号 >9 时乱序（对比 `usePushToTalk.ts:282` 已正确用 `numeric:true`）；且 `:383 getFullTranscript` 恒返回 `''`（`fullTranscriptRef` 从不 push，死逻辑）。
- **CollabOrbit 超时 → 永久 running 卡**：`CollabOrbit/index.tsx:74-83` `collab:progress` 仅 done/error→end、其余→start；后端 `collaboration.js:285` 看门狗超时广播 status=`'timeout'` 落入 else → 新开 researcher 卡**永不 end**，`allDone` 恒 false → 不自动收球/不聚合评价/不触发结论播报。
- **TaskPanelHost 订阅名与广播名错位**：`TaskPanelHost/index.tsx:147-152` 监听 `activity` 且判 `data.type==='tool_call'`，但 `activity-stream.js` TYPE 枚举**无 TOOL_CALL**（工具只记 `tool_preparing/tool_executing/tool_result/error`）→ 「执行中」条目不注入，面板不渲染。
- **schedule/knowledge 面板打开不写 panel-state `'open'`**（中危）：`SceneSet` data=对象分支（scene-tools.js:143）只 upsert surface 不写 open（仅 data=null 分支 :129-133 写 closed）；前端 open 路径也只重置显隐→ `getPanelState()` 恒 null，关闭却写 `'closed'`，重开后上下文误报「已关闭」。
- **TyphoonPanel panel-state 键 `'typhoon'` 未注册**（低危）：`panel-registry.js:20-30` DEFAULT_PANELS 无此键 → `setPanelState` 静默 no-op，台风面板 open/closed 对 AI 上下文整链不可见。

**🟡 P2 低危 / 观察项**
- `GET /panels/{stock,typhoon}` 直开路径（语音自取数据）绕过 `/api/scene/upsert` 的 open 同步，不写 panel-state（panel-close-chain.test.js 未覆盖）。
- TTS：前端发 `_refined`、后端流式端点读 `body.refine`（`voice-tts.js:12,83,225`）——字段名错位但默认值恰好一致，不失效。
- `task-panel-store.ts:177` `workflow_step` 按 `s.name===evt.name` 匹配忽略 `stepId`（后端 `workflow:progress` 带有 stepId），步骤名重复/为空时命中错位。
- `useChatStream`：done 全量覆盖 + 流中未剥离工具标签、route 类型 `isMultiAgent` vs 实际 `useMultiAgent`、error 分支不 `cancel` reader；`useVoiceReply.ts:312` GET 流式 `audio.duration` NaN 误判空音频。
- SetupWizard（`SetupWizard/index.tsx:415`）自定义端点 apiKey 缺省写 `'none'`，后端 config-handler 只保留 `'***'`/空 → `'none'` 被落盘并可能发 `Authorization: Bearer none`（边角）。
- BusinessReportPanel（`index.tsx:14,30-31`）：`_setTableInfo` 从未调用 → `tableInfo` 恒 null，经营数据表计数卡恒 '—'；`/api/plugin-manager/list` 被 `void res2` 丢弃（骨架未闭环，非错配）。
- skill GitHub/market 安装（`SkillsManagement/index.tsx:218,259-262`）不预检 `security.remoteInstall.enabled`，一律收到 generic 403（2026-08-28 安全门控 UX 观察项；ZIP 导入 `handleSkillsInstallZip` 不受影响）。

### 8.3 前端对接总结

绝大多数前端/后端链路（config / profiles / fallback / backup / cockpit / memory / kb / meetings / filegen / usage / skills / experts / collab / approval / scene 的载荷与 SSE 事件名）均对齐、自洽。唯一确定缺陷是 **CommodityPanel 成功路径按错误层级读取响应（`res.items` vs `res.data.items`）导致崩溃 + 历史不加载**；其余为 P1 业务逻辑缺陷与低危观察项。

---

*本报告由 CrabPaw HARNESS 逻辑完整性审计 + 前端深度扫描生成；所有数字以当前工作区源码为准。*
