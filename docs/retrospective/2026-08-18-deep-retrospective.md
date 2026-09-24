# CrabPaw 深度复盘报告（2026-08-18）

> 审计方法：6 个并行只读代理分领域排查（架构/记忆/工具/技能插件/通道/冗余），交叉验证运行时行为（209 工具注册 dump、7 类真实消息实测、数据文件实测），全程未修改任何文件。
> 覆盖：底层架构与启动链路、记忆/进化系统、工具系统、技能/插件系统、通道层（含微信监控）、项目级冗余。

---

## 一、架构与启动链路

### P1
| # | 类别 | 问题 | 位置 |
|---|------|------|------|
| 1-1 | logic-bug | process-watchdog 内嵌脚本**多字节编码损坏**（`信- ?` 吞掉换行），生成文件语法错误 → 心跳与自动重启 100% 不工作；且 L194 `process.argv[1]` 在子进程指向 runner 自身，重启目标也错 | src/core/process-watchdog.js:113-207 |
| 1-2 | wiring-gap | AgentHarness 可插拔运行时纸面：注册 'crabpaw' runtime 但 `select/attempt/classifyResult` 全链路零消费，ai.js 走自己的 chat() | src/core/agent-harness.js；harness-lifecycle.js:152-201 |
| 1-3 | logic-bug | scene-bridge `const { eventBus } = require('../event-bus')` 解构**不存在的属性**（event-bus.js 导出的是实例本身）→ 守卫静默跳过 → session:created/updated/removed 三个监听永不挂载 | src/core/scene/scene-bridge.js:62-76 |
| 1-4 | contract-mismatch | HealthMonitor 纸面：HARNESS.md §9.2-9.4 声称 checkIn/全局监控，实际每次请求 new 空实例，从不 start()，getStatus 恒 [] | src/core/health-monitor.js；handlers/local-handlers/system.js:60-76 |
| 1-5 | logic-bug | 优雅关闭不完整：risk-alert / scenario-reminder 引擎启动后无 stop 注册且 timer 未 unref → SIGINT/SIGTERM 后进程挂住 | src/core/init.js:393-413；proactive/risk-alert-service.js:77；scenario-reminder-engine.js:156 |

### P2
- **死代码**：`src/core/services.js` ServiceOrchestrator（整模块零引用，与 `src/services/registry.js` 双轨并存）；core/index.js 门面 45 个 getter 中 **26 个零消费**，其中 **7 个模块整体无生产引用**：cron-scheduler、stream-diag、kanban-board-sqlite、code-execution、native-request-registry、batch/、title/generator
- **死代码**：events.js `registerStandardSubscribers` 零调用；session:/system: 类型化事件发布后除 `session:end`（unified-memory）外无活订阅者；harness:* 事件零订阅
- **死代码**：state.js `addPendingConfirmation/resolveConfirmation/clearSession` 零消费（5 分钟 setTimeout 未纳入 lifecycle 管理）
- **wiring-gap**：`src/services/registry.js` `initializeAll()` 零调用 → `shutdownAll()` 对全部 5 个服务跳过 shutdown
- **wiring-gap**：启动期约 10 处子系统 try/catch warn 级静默跳过（Dashboard/ACI/panels/awakening/voice-evolution/MCP 等）——纸面接线复发温床
- **contract-mismatch**：HARNESS.md 漂移（`globalHelathMonitor` 拼写错误且不存在、53 suites vs 22 suites 自相矛盾）

---

## 二、记忆与进化系统

### P0
- **P0-1 经验回放引擎契约断裂**：`initExperienceReplay()` 注入 `ExperienceStore`，但回放引擎调用 `store.addExperience()`（typeof 守卫静默跳过）并读 `store._experiences`——ExperienceStore 类根本没有这两个成员 → **经验记录永不落盘、周期回放恒 `no_data`**，RAM 池中的经验从不参与回放（`getReplayBatch()` 是无调用者死方法）。src/core/perception/experience-replay.js:127-143,283-298；memory/experience-store.js
- **P0-2 记忆"进化引擎"实为原始对话转储**：`data/.crabpaw/memory-evolution.json` 实测 **1.1MB、644 条 type:conversation 全堆 workingMemory**（episodic/semantic=0）；每条消息全量重写 1.1MB JSON；`evolve()` 从未自动运行；更严重：`unified-memory.getRelevantMemories` 把增强检索结果（含原始对话）合并进主结果 → **裸对话以"相关记忆"回流 prompt**。src/core/evolution/memory-evolution.js:419-431；enhanced-memory.js:57-103；unified-memory.js:223-238

### P1
- **P1-1** `unified-memory.evolve()` 零调用者（进化引擎仅 CLI 手动触发）→ 压缩/遗忘/画像全空转
- **P1-2** KnowledgeGraphEvolver 以 `null` store 构造 → SQLite 写入全部被 typeof 跳过；访问回调全部不传 relationId → 强化永不发生、衰减反复打折、**重启一切归零**
- **P1-3** 进化协调器只有 1 个 stats-only 引擎（`improvement: 0`），每日 triggerEvolution 是汇报不是进化；真实进化走 ai.js review fork，与协调器无关
- **P1-4** `cleanLowTrust` 只清 autoMemory 一个后端，FTS/SQLite/增强后端残留 → **被删记忆仍可被检索（僵尸记忆复活）**
- **P1-5** `_syncToEnhancedMemory` 自我回写：`setEnhancedMemory(this)` 绑回自身引擎 → semanticMemory 条目自我复制，HRR/统一存储从未收到数据

### P2
- 死代码：`memory/user-model.js`（19KB 零引用）、`evolution-feedback-loop.js`（deprecated shim）、`ai/context.js`（调不存在的 `MemoryManager.search()` 恒返回 []，仅测试引用）
- logic-bug：`auto-memory.js:313` 写 mem_*.md 时 tags 用 JSON.stringify 而解析按逗号 split → 恢复后 tags 乱码；`unified-memory.js:108` 同毫秒同 role doc id 碰撞覆盖；会话结束双计数；`memory-manager.js` 重复 memoryDecay.start()
- contract-mismatch：hybrid-retrieval 期待 `extractEntities/getNodesForEntity` 而 EntityCoOccurrenceGraph 无这些方法 → 图通道恒降级且 `setEntityGraph` 零调用
- redundancy：一条 addMemory 写 6 个后端各自 try/catch 静默失败（写放大）；`storageType='unified'` 硬编码覆盖 config
- pattern-learner.json：**运行时产物，合规**（gitignore 已忽略，ACI 接线正确）

---

## 三、工具系统

**运行时基线**：注册工具 **209** 个 / 32 工具集 / 57 分类；契约表 208 键覆盖 100%；**158/209 缺 whenNotToUse**；cli 平台实测**仅 71 工具可达**。

### P0（全线能力静默丢失）
- **P0-1 工具集键断层**：CORE_TOOLSETS 缺 `system/voice/reminder/lark/wecom` 五个键，而 PLATFORM_TOOLSETS 直接引用它们 → `activateToolset()` 抛"工具集不存在" → **Bash 及 46 个 system 工具、10 个 lark 工具、14 个 wecom 工具在全部 4 渠道不可见**（wecom 渠道连 WeComSendText 都没有）。src/core/toolset-manager.js:14-114,152-173,314-321
- **P0-2 意图路由交集二次过滤**：`tools.filter(t => routedNames.has(t.name))` 路由集 ∩ 平台活跃集，实测"查动车票"无 TrainQuery、"压缩文件夹"无 ArchiveCompress、"数据库查询"无 DatabaseQuery、"看记忆"无 Memory、"打开百度"无 BrowserControl、"写代码"无 Bash。src/core/ai/tool-definitions.js:66-70；tool-router.js:224
- **P0-3 关键词误路由**：'查询'→web_search、'打开'→file_operation（"用数据库查询营收"被路由到 web 集）。src/core/ai/tool-router.js:88,51

### P1
- 契约重复赋值静默覆盖：SkillGenerate（tool-contract.js:218/397）、MusicSearch（:241/502）
- panel 工具 5 对语义重复（HotspotMode vs ShowHotspot 等 v1/v2 双入口并存）
- 工具链连续性失效：`getRecentToolNames` 不是 ToolsetManager 方法恒 []；FindTool 自身在死集从未被调用
- tool-orchestrator 管道引擎（8 模板）零调用方，且 cli 以 null registry 初始化（executeTool 必炸）
- 双注册表：src/core/tools/search.js 零消费者
- 死文件仍被 require：weather-tools.js（注册整体注释）、multimodal-tools.js（@deprecated 但从未注册）
- 非 PascalCase 工具名：html-presentation / presentation-builder（违反命名契约）
- 渠道筛选空操作（tool-router.js:343-346 注释"保留但不降低"无任何动作）
- wechat 工具集（wechat_monitor 5 工具）在 ⭕ 不可见名单中——与微信监控删除一并处理

### P2
- registry.execute 中 checkFn 调用在 try/catch 之外（:368-369）→ 抛 TypeError 击穿 execute
- tool-definitions.js:39 吞激活异常（无工具名信息）
- tool-profiles.js 含大量幽灵定义（x_search/canvas/sessions_spawn 等当前注册表不存在）
- isToolActive / getActiveToolsOpenAI/getActiveToolsClaude 零调用

---

## 四、技能与插件系统

### P0
- **P0-1 数据污染**：`data/skills/` 下 **330 个 testdraftskill-* 草稿目录**（352 中 330 个，今天仍在新增）被三套加载器同时扫描进 `/api/skills` 列表和 LLM prompt（无质量过滤），挤占真实技能展示与上下文预算。skill-generator.js:287-295 写 data/skills 根
- **P0-2 评分/生命周期/推荐全链纸面**：执行主路径 `executeSkillAdvanced`（skills.js:1576-1726，LLM 工具与 API 都走它）**不调用任何记录接口** → 实测 `skill-scores.json` 405 个技能**全部 = 0.5**、推荐器 usageStats=0 从未工作
- **P0-3** skill-router.js:686-688 未 await async 工厂 → 可选链短路静默 no-op（且 executeWithRouting 本身零调用者）

### P1
- 两套同名 SkillLifecycleManager 并行（skill-lifecycle.js vs skill/skill-lifecycle.js，API 不同、数据分叉）
- 两套 curator 同时初始化（skill-curator.js v1 经 evolution/index，skill-curator-v2.js 经 init.js）
- 死代码：skill/index.js barrel（34 个 re-export 零调用者）、src/skills/skill-executor.js（809B 玩具实现零引用）
- 双安全扫描器（skills.js scanSkillSecurity vs skill-loader-enhanced.js scanForThreats，模式集不一致）
- 热重载风暴：fs.watch 全量 reload，生成器每写一个草稿触发全量重建 420 技能
- 推荐策略同函数双标准（skillHint 无 executor 降权保留 vs 分类候选直接剔除）
- 禁用技能仍可执行 + API 恒报 success:true（skill-handler.js:329-353）

### P2
- skill-metrics.js @deprecated 仍被 require；skill-scoring.js:294-307 调不存在的 `lifecycleManager.updateSkillDetail()`（潜伏 TypeError）
- 中文技能名 normalize 碰撞（非 [a-z0-9_-] 全剔除 → 中文名互相覆盖）
- 插件系统（plugin-system → plugin-manager v3 + dashboard-plugin-scanner）：**真实运行、接线完整**，但 4 个插件基类（ModelProviderPlugin 等）零使用；skillV2/skillV3 lazy 门面零消费者

---

## 五、通道层与微信监控

### 通道总表
| 通道 | 状态 | 证据 |
|------|------|------|
| **wecom（企业微信）** | ✅ 真在用 | server.js spawn wecomBridge（5 次退避重启）；GUI 全量引用；reminder/image/file-notifier/cron 均发 wecom |
| **lark（飞书）** | ✅ 真在用 | larkBridge 子进程 + event-server；cron 推送、health larkRunning |
| wechat 桌面监控 | ⚠️ 仅手动/AI 可调 | 无自动启动（server.js:843"已改为手动启动"）；5 个 LLM 工具 + 2 个 cron（chat_analysis/wechat_send） |
| wechat 公众号（channels/wechat/index.js） | 💀 死代码 | createChannel 零调用 |
| email | 💀 死代码 | 零消费者 |
| channel-manager.js | 💀 死代码 | 零消费者（与 channel-registry 双轨制） |
| channel-adapter.js + core/adapters | 🕳 半死 | 打印"已就绪"但 parseInput/sendReply 零调用（WeChatAdapter 含于其中） |
| channel-directory.js | 🕳 死接线 | start() 从未调用，/channels search/list 恒空 |
| channel-event-bus（core/channels/） | ✅ 真在用 | 主动消息/AGUI 总线 |

### 微信监控删除影响面（E 代理核实）
- **删除 5 文件**：`src/channels/wechat-desktop-monitor.js`（2665 行主体）、`src/channels/monitor-harness.js`、`src/channels/wechat/index.js`、`src/tools/wechat-monitor-tools.js`（5 工具）、`src/core/device/vlm-layout.js`（唯一消费者是 monitor-harness）
- **改 15 文件**：tools/index.js、cli/server.js（×4 处：require/cron×2/注释）、handlers/task-handler.js（wechat_send 动作）、tool-contract.js（5 个契约）、tool-router.js（wechat_msg 意图）、core/adapters/index.js（WeChatAdapter）、channel-registry.js、system-prompt.js、local-handlers/core.js、human-delay.js、inbound-debounce.js、delivery-router.js、gui VoiceShell×2、config-set-guard.ts
- **改 1 测试**：config-set-guard.test.ts
- **配置**：config-handler.js:140-141 wechatDesktop 落盘逻辑；数据残留 ~/.crabpaw/chat_logs/wx_chat_*.jsonl 可选清理
- **⚠️ 易误删警示（必须保留）**：trending-scraper 微信热榜（热点面板在用）、platform-api-tools.js wechat_mp 公众号工具、wechat-article-search 技能、desktop-tools 的 app="wechat"、**wecom 全套**

### 通道层逻辑问题
- **P1**：CLI `channel enable/disable/test` 调用的方法在 ChannelRegistry 中**根本不存在** → 必抛 TypeError；channel list 打印字段全 undefined
- **P1**：self-awareness.js:215 `require('../channels/channel-registry')` 路径错误（真位置 src/core/channel-registry.js）→ MODULE_NOT_FOUND 被吞 → 自省系统对通道感知永久缺失
- **P2**：DeliveryRouter 死实例（ai.js:199 new 后零调用）；registry 缺 wecom 通道注册 → getChannelConfig('wecom') 返回 null

---

## 六、项目级冗余清查

### 可回收 ~2.4GB 磁盘 + ~120MB git 历史
| 条目 | 规模 | 建议 |
|------|------|------|
| gui/dist-electron/ | **1.6G** | 删除（构建输出） |
| gui/gui/node_modules/（错误嵌套） | 100M | 删除 |
| data/cloakbrowser/chromium-*/ | 537M（其中 **113MB 误 git 跟踪**） | 删目录（自动重下）+ git rm --cached 误跟踪文件（icudtl.dat/.pak/.last_update_check/.welcome_shown） |
| boss_profile_eval_*.json + .signals | **3872 个**（1548 个 22B 空壳） | 删除（8/8 评测产物） |
| data/skills/testdraftskill-* | 330 个 / 2.6M | 删除（技能测试草稿） |
| .superpowers/sdd/ | 375 文件 / 20M（6 个被跟踪） | 删除（过程产物海洋） |
| 根目录营销文档 ×20 | ~67KB | 删除（OPC/AI 报告、_decode_tmp.py、agent-intro.html 等一次性产物） |
| docs/audit/eslint-report*.json | 各 7.2M（被跟踪） | git rm |
| .trae/（IDE 残留 80K）、.opencode/（5K）、.idea/（102K）、.agents/（空） | ~190K | 删除（.trae/.opencode git rm 后删） |
| package.json 死依赖 | docx、edge-tts、pdf-lib、fontkit + @babel/preset-typescript | 删除 5 个（exceljs 3 处真实引用，**保留**——OPTIMIZATION_PLAN 中"exceljs 冗余"判断已过时） |

### 保留（确认真实资产）
- data/workspace（33M）、experts-from-agency-agents.json（3.3M）、data-sources.json、真实技能、data/.crabpaw 数据
- archive/（176K 历史审计报告）、docs/（16M，含 superpowers 工作流）
- .github/workflows/、.husky/pre-commit
- gui 侧 cronstrue/mermaid 需人工确认（无直接 import，可能动态加载）

### 代码缺陷级发现（随冗余清查暴露）
- `src/tasks/core/nlp-task-parser.js` → `../ai/http-helpers` 引用已消失的 `src/tasks/ai/`（真位置 src/core/ai/http-helpers.js），**无兜底**，_callAI 调用即抛 MODULE_NOT_FOUND
- `src/core/self-awareness.js` 三处陈旧 require（../config、../agent/agent-registry、../channels/channel-registry），try/catch 兜底静默降级
- `.claude/settings.local.json` 被 git 跟踪（应进 .gitignore）

---

## 七、建议修复优先级

### 批 1：低风险冗余清理（不动逻辑，先止血）
运行时/构建产物、评测与测试草稿（4200+ 文件）、死依赖 5 个、IDE/工具残留目录、git 误跟踪文件回滚。

### 批 2：微信监控删除（用户点名）
按第五部分影响面清单：5 删 + 15 改 + 1 测试，同步删除 wechat_monitor 工具契约与意图。

### 批 3：P0/P1 级缺陷修复（逻辑修复，建议逐项提 PR）
| 优先级 | 修复项 |
|--------|--------|
| P0 | 工具集键断层（补 system/voice/reminder/lark/wecom 键或改平台列表引用核心键 → Bash 等 47 工具复活）；意图路由交集改直取 + 修'查询'/'打开'误路由 |
| P0 | 经验回放契约（补 addExperience 或合并 RAM 池）；记忆进化改按 importance 分桶 + retrieve 过滤裸对话 |
| P0 | 330 个 testdraftskill 过滤 + 生成器改写入隔离目录 + 热重载增量 |
| P0 | executeSkillAdvanced 补 usage 记录（评分/推荐链复活） |
| P1 | scene-bridge eventBus 解构修复；watchdog 脚本重写（编码损坏 + 重启目标）；关闭链路补 stop 注册；CLI channel 命令补方法或移除；self-awareness/nlp-task-parser 路径修复；process-watchdog；cleanLowTrust 全后端清理 |

---

## 八、结论

六维审计共发现 **P0×10、P1×30+、P2×40+**。系统性病灶三类：
1. **纸面接线**（最普遍）：模块存在+导出+日志声称启动，实际零消费或契约断裂（AgentHarness、HealthMonitor、经验回放、KG evolver、进化协调器、tool-orchestrator、channel-adapter、评分推荐链）——正是历史多轮实锤的断层模式，且多以 warn 级静默吞错；
2. **双轨并存**：两套服务注册中心、两套生命周期管理器、两套 curator、双安全扫描器、门面与直连并行、channel-manager/registry 双轨——认知成本高、互相掩盖；
3. **工具可用性断层**（用户可直接感知）：工具集键缺失 + 交集过滤叠加，实测 209 注册工具仅 71 可达，Bash 全渠道不可见。

冗余清理可回收约 2.4GB 磁盘与约 120MB git 历史。微信监控确无活跃消费方（无 GUI 入口、无自动启动、无测试），删除影响面可控。

---

## 九、执行结果（2026-08-18 晚，用户已确认范围）

### 批 2 微信监控删除 — ✅ 完成
- **删 5 文件**：wechat-desktop-monitor.js、monitor-harness.js、channels/wechat/index.js、wechat-monitor-tools.js、core/device/vlm-layout.js
- **改 20 文件**（CRLF 安全，node 脚本替换）：tools/index.js、cli/server.js（require + chat_analysis/wechat_send 两 cron + 注释）、task-handler.js（REGISTERED_ACTIONS 删 wechat_send + chat_analysis）、tool-contract.js（5 契约）、tool-router.js（wechat_msg 意图）、adapters/index.js（WeChatAdapter）、channel-registry.js、system-prompt.js、local-handlers/core.js、human-delay.js、inbound-debounce.js、delivery-router.js（PLATFORMS.WECHAT）、config-handler.js、VoiceShell×2、config-set-guard.ts + .test.ts、CLAUDE.md、AGENTS.md、channel-adapter.js（docstring）
- **核验**：监控专属标识符全仓 0 残留；wecom/公众号工具/微信热榜/桌面窗口定位均保留；node --check 13 个 .js 全过；gui tsc --noEmit 0 错；config-set-guard.test 5/5

### 批 1 低风险冗余清理 — ✅ 完成
- 构建产物：gui/dist-electron 1.6G、gui/dist 7.6M、gui/test-results 113K、gui/gui/node_modules 100M
- 运行时：data/cloakbrowser 537M（含 git 误跟踪 113MB 回滚，.gitignore 已补 /data/cloakbrowser/）
- 评测产物：boss_profile_eval_*.json×3872
- 技能草稿：data/skills/testdraftskill-*×330
- 过程报告：.superpowers/sdd 20M → 移入 archive/superpowers-sdd（保留未提交修改）
- 根目录一次性产物 ×34（OPC/AI 报告/贪吃蛇/艺人等；保留 crabpaw-intro.md、产品方案、周报、活动模板 4 个待人工确认）
- 误跟踪：docs/audit/eslint-report*.json×2（14M）、.claude/settings.local.json（--cached）
- IDE 残留：.trae/ .opencode/ .idea/ .agents/
- 死依赖：edge-tts（唯一；docx/pdf-lib/fontkit 经 skills/ 验证在用而保留，@babel/preset-typescript 经 gui 配置验证保留）

### 清理引发的修复
- **skill-tier-loader.test.js 阈值 100→60**：330 个 testdraft 草稿此前被计入技能发现注册表（虚高 ~405），删除后真实 75 个 → 断言失效。已修阈值并注释根因（测试此前"碰巧通过"正是草稿污染的表现）。

### 批 3 P0/P1 缺陷修复轮 — ✅ 完成（4 代理并行 + 协调者收尾，未提交）
**工具域（T1）**：
- P0-1 键断层：PLATFORM_TOOLSETS 四平台列表改只引用核心键（system→terminal、voice/reminder 删、lark/wecom→messaging）+ CORE_TOOLSETS 补 15 缺失键（general/stock/travel/ui/email/document/trending/platform/harness/agent/network/data/filesystem/memory/observability）→ 激活零失败、聚合告警
- P0-2 交集过滤：探针实测 cli 每意图 42-108 工具（此前全渠道仅 71 可达）；TrainQuery/ArchiveCompress/DatabaseQuery/Memory/BrowserControl/Bash/Music/LarkSendText/WeComSendText 全可见
- P0-3 误路由：web_search 删'查询/帮我查'，新增 data_query 意图（required:['data']）；file_operation 删裸'打开'，新增 open_app（ui/browser/desktop/file + pairs），weather/news/stock/scene 补 pairs 压回；memory_query 补'记忆'；渠道筛选改按渠道注入 lark/wecom toolset
- getRecentToolNames 实现（读 registry 执行日志，降级活跃集）；契约去重（SkillGenerate/MusicSearch 各 2 处→1）；panel v1 五工具（hotspot_mode/person_card_mode/worldcup_mode/focus_banner/voice_retire）注销 + 契约与 LEGACY_SNAKE_ALIASES 同步删（注册表 panel 20→15）；registry.execute checkFn try/catch 防护；cli/index.js 删 getToolOrchestrator(null) 死初始化

**记忆域（T2）**：
- 经验回放契约：ExperienceStore 补 addExperience/_experiences（独立 .experiences.json 原子写）+ experience-replay 合并 RAM 池去重兜底，getReplayBatch 接入主循环
- 进化转储：saveData 批量合并（同 tick 多次 store 合 1 次写）+ store() 分桶（>0.8 semantic/>0.5 episodic/其余 working）+ 检索过滤 type='conversation' 裸消息；doc id 加随机后缀
- evolve() 挂每日心跳（heartbeat-patrol，try/catch 不阻断）；KG evolver setStore 双注入（_store + _graph._store）+ entity-graph 三处 _recordAccess 补传 relationId；协调器 evolve() 补跑真实 SkillEvolutionEngine（_runRealSkillEvolution，无递归）
- cleanLowTrust 全后端清理（FTS removeIndex + unified-store deleteMemory + enhanced）；_syncToEnhancedMemory 改绑 memory-manager 真身（addFact API）；auto-memory tags join(', ') 与 parser 双向兼容
- 探针误写生产数据（3 条）已按精确 id 外科式恢复（totalMemories 649→646，自校验零残留）；644 条既有 conversation 脏数据未动

**技能域（T3）**：
- executeSkillAdvanced 补 _recordSkillExecution（usageTracker.recordCall + lifecycleManager.recordSkillUsage，setImmediate 非阻塞，双 try/catch）→ 探针实测 usage/lifecycle 落盘，405 技能评分/推荐链复活（skill-scores 加权分下次启动刷新）
- skill-router 补 await（原 Promise.recordSkillUsage 可选链短路）；executeWithRouting 标 deprecated
- 草稿防护：generateSkill 写 data/skills/.drafts/ 隔离 + skills.js/skill-system.js 加载过滤 .*/testdraft + 热重载跳过草稿与防抖合并（顺带修防抖吞事件 bug）
- 禁用技能检查（disabled-skills.json 5s 缓存，测试驱动返工一次）；handleSkillExecute 透传 success（不再恒 true）
- skill-scoring 改写活引用（去 updateSkillDetail 死调用）；删 src/skills/skill-executor.js、src/core/skill/index.js barrel；修 skill/skill-lifecycle.js register() 二次调用 emit TypeError；双管理器合并评估后留 TODO（风险高）

**架构域（T4）**：
- scene-bridge eventBus 解构修复（session 三事件监听复活）；process-watchdog 重写（行数组+JSON.stringify 嵌入防编码损坏、入口 argv[2] 显式传、生成后 node --check、重启前存在性守卫）——真实两进程冒烟通过（崩溃→重启→restartCount=1）
- 优雅关闭：risk-alert/scenario-reminder setInterval .unref() + init.js registerCleanup(stop)；initPromise 失败重置；serviceRegistry.initializeAll() 接线
- ChannelRegistry 补 enable/disable/isEnabled/test 四方法；channel.js list 改用真实字段（label/description/isEnabled）
- self-awareness 6 处 require 路径修复 + nlp-task-parser http-helpers 路径；HealthMonitor 补 checkIn + getGlobalHealthMonitor 全局单例 + server.js 接线 + HARNESS.md 拼写/数字修正
- server.js 记忆接线：entityGraph.setStore(getUnifiedStore())
- 死代码删除 9 文件（services/stream-diag/kanban-board-sqlite/native-request-registry/code-execution/batch/title/generator/tools/search + events 死方法 + state 三方法 + trace-recorder wechat 默认值）+ core/index.js 重写懒加载（39 死 getter 删、14 保留）+ 顺手修 channelRegistry/insights 两 getter 恒 undefined bug（core.js/insights 实锤）

**协调者收尾（额外发现并修复）**：
- **_pushScene setSurface 非 scene-store API**（v2 全部 7 个面板工具 scene 格式从未真正写入 surface）→ upsertSurface
- ShowHotspot show 路径接线：原写 hotspot_<platform> 与 hide 删的 'hotspot-panel' 不对称（打开后永远关不掉）→ 固定写 hotspot-panel + panel-state open
- 指引文案 hotspot_mode→ShowHotspot(action="show", format="scene")；panel-state-guidance/panel-close-chain/panel-state 三测试跟随 v2 标准更新
- testdraftskill 残留 2 目录清理（eval se_013 走 generateSkill 已由 .drafts/ 覆盖，断言不受影响）
- 并发竞态复核：knowledge-graph-evolver setStore 唯一 + _graph._store 透传在；coordinator _runRealSkillEvolution 唯一

### 最终验证
- `npm test`：**1232/1232 通过**（84 suites；较清理轮 1242 少 10 个，差异为统计口径/条件用例，无被删测试文件，两次均全绿）
- `npm run eval`：**62/62 通过**（P0 5/5、P1 36/36、P2 20/20、P3 1/1；wiring 6/6）
- 变更集（累计两轮）：490 文件变更，未提交（待用户决定提交时机）

**残留观察（后续轮）**：git 提示 CRLF 文件将被 LF 化（.gitattributes 声明与磁盘行尾不一致的既有现象）；lark/wecom 渠道现注入本渠道工具集属预期行为变更；eval 用例 pe_005 清理 temp 文件的 ENOENT 告警（既有，测试通过）。

### 批 3.5 残留处理轮 — ✅ 完成（协调者直改，未提交）
- **门面解构修复（4 纸面命令复活）**：core/index.js 补 history（→SessionPersistence 适配 list/search/clear/export）/scheduler（→Scheduler 单例适配 list/add/remove/runNow）/createSubAgent/listSubAgents/getSubAgentStats/cleanupCompletedSubAgents（→src/core/subagent.js）——此前 `crabpaw history/schedule/subagent/status` 四命令解构 undefined 即 TypeError；session-persistence.js 补 clearUserSessions；scheduler.js 补 getScheduler 单例（顺带修复 panels/status.js:207 同款解构 undefined → getScheduler() 调用必炸的隐性断层）
- **skill-lifecycle 双嵌套修正**：SKILL_LIFECYCLE_FILE/LIFECYCLE_CONFIG_FILE 去掉重复 '.crabpaw' 段（DATA_DIR 已是 data/.crabpaw，原落 data/.crabpaw/.crabpaw/；磁盘无存量数据，无需迁移）
- **协调器 No engine 降级诚实化**：无引擎提案从 throw→Failed 改为 CANCELLED + info 级日志（memory/agent 走各自定时/自愈路径，属预期不执行而非失败）
- **双 SkillLifecycleManager 决策落定**：评估后不合并（状态机 vs 使用统计职责独立、7 消费方+数据迁移风险高、无用户可感知问题）——T3 的 TODO 注释升级为决策注释（含触发条件：未来出现双写不一致再立项）

**验证**：npm test 1232/1232（84 suites）、eval 62/62（P0 5、P1 36、P2 20、P3 1）——与 P0 修复轮同一基线，无回归。
