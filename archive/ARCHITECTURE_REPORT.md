# CrabPaw 项目全面架构分析报告

> 项目：CrabPaw (crabpaw) v2.2.0
> 分析日期：2026-07-27
> 分析范围：全部子系统 — 后端核心 / 前端 / 信道 / 插件 / 技能 / 安全 / 审计 / 内存 / 配置 / 评估 / Harness 框架 / 语音 / 面板

---

## 目录

1. [项目概览](#1-项目概览)
2. [后端核心架构](#2-后端核心架构)
3. [前端架构](#3-前端架构)
4. [信道系统](#4-信道系统)
5. [插件系统](#5-插件系统)
6. [技能系统](#6-技能系统)
7. [安全系统](#7-安全系统)
8. [审计系统](#8-审计系统)
9. [内存系统](#9-内存系统)
10. [配置系统](#10-配置系统)
11. [评估系统](#11-评估系统)
12. [Harness 框架](#12-harness-框架)
13. [语音对话系统深度分析](#13-语音对话系统深度分析)
14. [面板系统分析](#14-面板系统分析)
15. [跨系统串联问题](#15-跨系统串联问题)
16. [Bug 汇总](#16-bug-汇总)
17. [代码规模统计](#17-代码规模统计)
18. [架构决策评估](#18-架构决策评估)

---

## 1. 项目概览

### 1.1 基本信息

| 属性 | 值 |
|------|-----|
| 名称 | CrabPaw |
| 版本 | 2.2.0 |
| 描述 | 8 维度 Harness 框架的多智能体编排平台 |
| 技术栈 | Node.js + Electron + React + TypeScript + Vite |
| 包管理器 | npm |
| Node 版本 | >= 18.0.0 |
| 入口 | `src/cli/index.js` |
| 默认端口 | 38767 |

### 1.2 目录结构

```
D:\bossagent/
├── src/               # 后端核心 (~200+ JS 文件)
│   ├── cli/           # CLI 入口 + HTTP 请求处理
│   ├── core/          # 核心引擎 (AI, TTS, ASR, Workflow, Panels, 等)
│   ├── channels/      # 信道适配器 (WeChat, Lark, WeCom, Email)
│   ├── handlers/      # API 处理器
│   ├── tools/         # AI 工具定义
│   └── core/          # 子模块 (security, memory, skill, plugin, 等)
├── gui/               # Electron + React 前端
│   └── src/
│       ├── pages/     # 14 个页面
│       ├── components/ # 52 个组件目录
│       ├── hooks/     # 13 个自定义 hook
│       ├── contexts/  # 2 个 React context
│       └── lib/       # 13 个工具库
├── plugins/           # 14 个插件
├── skills/            # 68 个技能
├── evals/             # 21 个评估测试套件
├── memory/            # 内存持久化目录
├── locales/           # 国际化
├── config.yaml        # YAML 配置模板
└── data/              # 运行时数据目录
```

### 1.3 核心依赖

| 类别 | 依赖 |
|------|------|
| AI/LLM | 多提供商路由 (DeepSeek, Qwen, 等) |
| 信道 | `@larksuite/cli`, `@wecom/aibot-node-sdk` |
| 数据库 | `better-sqlite3`, `sql.js`, `sqlite3` (可选) |
| 文档 | `marked`, `mermaid`, `highlight.js`, `pdf-parse`, `exceljs`, `pptxgenjs` |
| 图表 | `chart.js`, `echarts`, `canvas` |
| 浏览器 | `playwright-core`, `cloakbrowser` |
| 语音 | `edge-tts`, Web Audio API, AudioWorklet |
| 构建 | Vite 5, Electron 28, TypeScript 5.3, Tailwind 3 |

---

## 2. 后端核心架构

### 2.1 启动流程

`src/core/bootstrap.js` 定义了 8 阶段初始化：

```
阶段 1: ConfigLoader       → 加载配置 + .env
阶段 2: CredentialManager  → 加载/解密 API 密钥
阶段 3: SecretRedactor     → 初始化密钥遮掩器
阶段 4: Logger             → 初始化日志系统
阶段 5: SecuritySystem     → 安全系统 + 沙箱 + 审批
阶段 6: ModelRouter        → LLM 提供商路由
阶段 7: Registration       → 工具/技能/插件/钩子注册
阶段 8: ChannelManager     → 信道初始化
```

### 2.2 核心模块

| 模块 | 文件 | 行数 | 职责 |
|------|------|------|------|
| AI Core | `src/core/ai.js` | ~4856 | 聊天引擎，思维链编排，工具调度入口，流式响应 |
| 系统提示 | `src/core/system-prompt.js` | ~1705 | 4 层提示构建 (角色/能力/约束/工具)，PROMPT_VERSION 2.1.0 |
| 工作流引擎 | `src/core/workflow-engine.js` | ~1500 | v2 工作流，条件/循环/子 Agent，安全 eval |
| 工具编排器 | `src/core/tool-orchestrator.js` | ~800 | 80+ 工具合约注册/路由/执行/回退 |
| 工具合约 | `src/core/tool-contract.js` | ~600 | PascalCase 命名合约定义 |
| 预算执行器 | `src/core/budget-enforcer.js` | ~400 | 5 级降级 (正常→降级→限制→最小→紧急) |
| 模型路由器 | `src/core/model-router.js` | ~800 | 多提供商 LLM 路由与回退 |
| 循环检测 | `src/core/loop-detection.js` | ~300 | 3 种检测策略 + 断路器 |
| HTTP 中间件 | `src/core/http-middleware.js` | ~200 | 请求预处理中间件 |
| SSE 广播 | `src/core/sse-broadcast.js` | ~200 | 服务端事件推送 |
| 活动流 | `src/core/activity-stream.js` | ~200 | 实时事件广播 |
| 上下文缓存 | `src/core/context-cache.js` | ~200 | 提示/技能/工具缓存层 |
| AI 工具执行 | `src/core/ai/tool-exec.js` | ~500 | 工具执行子模块 |
| AI 流式处理 | `src/core/ai/streaming.js` | ~400 | 流式响应子模块 |
| AI 上下文 | `src/core/ai/context.js` | ~300 | 上下文准备子模块 |
| AI 意图 | `src/core/ai/intents.js` | ~200 | 意图检测与工具路由 |

### 2.3 CLI / HTTP 层

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/cli/index.js` | ~300 | CLI 入口，启动 HTTP 服务 |
| `src/cli/request-handler.js` | ~1200 | HTTP 路由分发 (~200 端点) |
| `src/cli/handlers/` | 多个 | 功能处理器 (chat, tts, voice, 等) |

**关键观察：**
- `ai.js` 是一个 4856 行的巨型文件，包含聊天引擎、思维链编排、工具调度和流式响应
- `request-handler.js` 使用 `var` 声明变量，违反现代 JS 最佳实践
- 存在大量模块级全局可变状态 (`_current*`, `last*` 模式)
- 多个模块间存在循环依赖，通过惰性加载 (`getXxx()`) 绕过

---

## 3. 前端架构

### 3.1 技术栈

| 层次 | 技术 |
|------|------|
| 运行时 | Electron 28 |
| 框架 | React 18.2 (createRoot, Suspense, startTransition) |
| 构建 | Vite 5 + vite-plugin-electron |
| 语言 | TypeScript 5.3 |
| 样式 | Tailwind CSS 3 + CSS 自定义属性 (暗/亮主题) |
| 图标 | lucide-react |
| Markdown | react-markdown + remark-gfm + rehype-katex |
| 图表/图表 | mermaid, three.js, katex |
| 通知 | sonner (Toaster) |
| UI 原语 | @radix-ui (dialog, select, switch, tabs, tooltip) |
| 测试 | Playwright (E2E) |

### 3.2 启动顺序

```
main.tsx
  → 全局错误处理器 (50 次错误上限 → 页面重载)
  → unhandledrejection 监听器
  → Electron 崩溃检测
  → PerformanceObserver 内存压力监控
  → <ThemeProvider>
      → <ErrorBoundary>
          → <VoiceStateProvider>
              → <PluginProvider>
                  → <Dashboard />      ← 主壳，管理所有标签
                  → <SceneShell />     ← Agent 驱动 UI 覆盖层
              → </PluginProvider>
          → </VoiceStateProvider>
      → </ErrorBoundary>
    → <Toaster />
  → </ThemeProvider>
```

### 3.3 页面清单 (14 页)

| 页面 | 路径 | 用途 |
|------|------|------|
| Home | `pages/Home/` | 记忆图 + 快捷入口 |
| Dashboard | `pages/Dashboard/` | 主壳 (3024 行，巨型文件) |
| Automation | `pages/Automation/` | 任务/工作流自动化 |
| Calendar | `pages/Calendar/` | 日程管理 |
| EvolutionLog | `pages/EvolutionLog/` | Agent 进化历史 |
| Gateway | `pages/Gateway/` | 信道/桥接网关配置 |
| Logs | `pages/Logs/` | 系统日志浏览器 |
| Memory | `pages/Memory/` | AI 记忆面板 |
| News | `pages/News/` | 新闻聚合 |
| Settings | `pages/Settings/` | 应用设置 (含插件管理器) |
| Skills | `pages/Skills/` | 技能管理 |
| SkillsManagement | `pages/SkillsManagement/` | 高级技能管理 |
| SmartControl | `pages/SmartControl/` | 微信桌面监控 |
| Status | `pages/Status/` | 系统健康状态 |

### 3.4 核心组件

| 类别 | 组件 |
|------|------|
| 布局 | Sidebar, TitleBar, RightPanel, SceneShell, CommandPalette, StatusBar, SplashScreen |
| 聊天 | MessageAxis, SlashCommandMenu, FilePreviewModal, WorkflowStepCard, ApprovalCard |
| 语音 | VoiceIntegration, VoiceOrb, TTSFxProcessor, VoiceDiagnostics, AudioOutputManager |
| 场景 | PersonCard, WeatherCard, MetricCard, ChoiceCard, ImageCard, ChartCard, FormCard, KanbanCard (共 17 种) |
| 记忆 | MemoryGraph, MemorySoul, MemorySnapshot, MemoryEvolution |
| 面板 | HotspotPanel, HotspotEarth, ActivityStream, DocPanel, FileBrowser, MeetingsPanel, ExpertsPanel |

### 3.5 Hooks (13 个)

| Hook | 行数 | 用途 |
|------|------|------|
| useVoiceReply | 896 | 5 代流式 TTS (句子提取, 预取, barge-in) |
| usePushToTalk | 811 | PTT AudioWorklet PCM 捕获 + WS ASR |
| useVoiceSession | 677 | 连续语音对话引擎 |
| useChatStream | 330 | POST /chat SSE 流 |
| useChatSession | 371 | 会话 CRUD + 自动保存 |
| useSSE | 139 | SSE 事件总线 (指数退避重连) |
| usePlugins | 287 | 前端插件发现 + 动态注入 |
| useWakeWord | 278 | 唤醒词检测 |
| useContinuousVoice | 269 | Barge-in + 静默自动发送 |
| useMeetingTranscription | 295 | 会议转录 |
| useVoiceVisualState | 69 | 语音球动画状态推导 |

### 3.6 关键架构决策

1. **状态驱动的标签导航** — 无 React Router，通过 `activeTab` 字符串状态管理
2. **双 ref 模式** — 每个布尔状态有配套的 `useRef` 避免闭包陈旧问题
3. **双传输 API 层** — `api.ts` 透明支持 Electron IPC 和直接 HTTP fetch
4. **Scene 协议** — WebSocket 驱动的 Agent→UI 推送协议（17 种卡片）
5. **SSE 事件中枢** — Dashboard 注册 ~35 个事件处理器
6. **全局 window.__ 污染** — 大量跨组件通信通过 `window.__` 全局变量

---

## 4. 信道系统

### 4.1 架构概览

`ChannelManager` (单例 EventEmitter) 集中注册所有信道适配器，统一 8 种事件类型。

### 4.2 信道清单

| 信道 | 连接模式 | 认证 | 事件源 | 发送机制 |
|---------|---------|------|--------|---------|
| 微信桌面 | 截图轮询 | 无 (桌面应用) | VLM 视觉分析 | PS 剪贴板 + SendKeys |
| 微信官方 | API 轮询 | appId/appSecret | Webhook (XML) | 微信 API POST |
| 飞书 (Webhook) | HTTP 回调 | appId/appSecret | 事件订阅服务器 | 飞书 OpenAPI |
| 飞书 (WS) | WebSocket | appId/appSecret | WS 直连 / lark-cli | 飞书 OpenAPI |
| 企业微信 | WebSocket SDK | botId/secret | SDK WSClient | SDK sendMessage |
| 邮件 | IMAP 轮询 | 用户名/密码 | IMAP UNSEEN 轮询 | SMTP |

### 4.3 微信桌面监控器 (`wechat-desktop-monitor.js` — 2655 行)

**核心循环：**
1. `_safePoll()` — 速率限制 + 静默时段
2. `_captureWxWindow()` — PowerShell GDI 截图
3. VLM `analyzeImage()` — 检测 @提及 + 提取消息
4. `_validateVlmResult()` — 反幻觉校验
5. 去重 (`_repliedHashes`, `_chatLogHashes`)
6. `_reply()` — 构建提示 + 记忆 + 知识库 + 生成回复
7. `_focusWeChatWindow()` + `sendReplyToWeChat()` — PS 模拟输入

**高级特性：**
- 进化/反馈循环 (`_detectFeedback`)
- 记忆压缩 (`_compressMemories`)
- 嵌入缓存 (LRU 200 条)
- 自适应轮询 (被提及 3s → 空闲 30s)

### 4.4 飞书信道组件

| 组件 | 用途 |
|------|------|
| `token-manager.js` | 多应用令牌生命周期管理 |
| `event-server.js` | HTTP 回调服务器 (端口 38770) |
| `event-bridge.js` | lark-cli 子进程桥接 |
| `ws-realtime.js` | 直连 WebSocket 客户端 |
| `group-router.js` | 群消息路由策略引擎 |
| `api.js` | 飞书 OpenAPI 封装 |

### 4.5 企业微信信道组件

| 组件 | 用途 |
|------|------|
| `event-bridge.js` | 官方 SDK WebSocket 客户端 (897 行) |
| `group-router.js` | 群消息路由 |
| `message-dedup.js` | 消息去重 |
| `approval-handler.js` | 审批状态跟踪 |
| `approval-submitter.js` | OA 审批提交 |
| `contacts-sync.js` | 企业通讯录同步 |
| `external-contact.js` | 外部联系人查询 |
| `calendar-client.js` | 日历日程 CRUD |

---

## 5. 插件系统

### 5.1 架构

`PluginManager` (单例) 使用"贡献桥接"模式 — 插件向现有系统注册表（工具/事件/服务/UI/技能/中间件）注册贡献项，所有注册携带 `source` 标签以便清理。

### 5.2 搜索目录

- 内置: `plugins/`
- 用户: `data/.crabpaw/plugins/`
- 捆绑: `plugins/bundled/`

### 5.3 14 个注册插件

| 插件 | 描述 |
|------|------|
| browser-control | 浏览器控制 |
| calendar | 日历集成 |
| cost | 成本管理 |
| desktop-control | 桌面控制 |
| example-dashboard | 示例仪表板 |
| heartbeat-loop | 心跳维护循环 |
| memory-consistency | 内存一致性检查 |
| news | 新闻源 |
| regression-guard | 回归防护 |
| smart-control | 智能控制 UI |
| test-plugin | 测试插件 |
| voice | 语音功能 |
| voice-evolution | 语音进化 |
| wechat-monitor | 微信监控元数据 |

### 5.4 Manifest 格式

支持 `manifest.yaml` / `plugin.yaml` / `plugin.json`，贡献点分新旧格式：
- **新格式**: `contributes.ui.{routes, settings, sidebar}`
- **旧格式**: `contributions.{tools, events, services, routes, settings, skills, middleware}`

---

## 6. 技能系统

### 6.1 68 个技能按类别

| 类别 | 技能数 | 必需 |
|------|--------|------|
| core | 10 | 是 |
| office | 8 | 是 |
| channels | 4 | 是 |
| dev | 8 | 否 |
| data | 6 | 否 |
| productivity | 16 | 否 |

### 6.2 技能格式

每个技能是一个目录，内含 `SKILL.md` 文件：
```markdown
---
name: weather
version: "1.0.0"
description: "Get weather information"
arguments: ["city"]
metadata:
  crabpaw:
    emoji: ☔
    category: general
    triggers: ["weather", "天气"]
    priority: 2
---
# Weather
...
```

### 6.3 技能加载器 (`skill-loader-enhanced.js`)

- 平台匹配（按 `process.platform` 过滤）
- 威胁扫描（6 类威胁模式）
- 信任等级（builtin / trusted / community / agent_created）

### 6.4 技能执行器 (`src/core/skills.js` — 1785 行)

多语言执行引擎，支持 JavaScript / Python / Shell / Builtin 执行器，集成安全扫描、进化器、质量跟踪。

---

## 7. 安全系统

### 7.1 五层安全架构

```
用户输入
  → 1. 用户授权 (UserWhitelist)
  → 2. 命令审批 (ApprovalSystem)
  → 3. 文件系统边界 (FilesystemGuard)
  → 4. 提示注入检测 (PromptInjectionDetector)
  → 5. 跨会话隔离 (SessionIsolation)
```

### 7.2 五个安全等级

`DISABLED` → `BASIC` → `STANDARD` (默认) → `STRICT` → `PARANOID`

### 7.3 安全组件清单

| 组件 | 行数 | 用途 |
|------|------|------|
| `security/index.js` | ~200 | 统一门面，SecuritySystem 类 |
| `approval.js` | ~300 | 人工审批系统 (3 种模式) |
| `bash-command-filter.js` | ~200 | 35+ 禁止模式的正则过滤 |
| `dangerous-patterns.js` | ~200 | 12 类危险模式检测 |
| `filesystem-guard.js` | ~200 | 路径访问控制 |
| `sandbox.js` | ~300 | 4 种执行沙箱配置 |
| `session-isolation.js` | ~100 | 按用户隔离数据目录 |
| `prompt-injection-detector.js` | ~300 | 12 类提示注入检测 |
| `context-threat-scanner.js` | ~100 | 工作区上下文威胁扫描 |
| `streaming-context-scrubber.js` | ~200 | 流式上下文清洗 |
| `safe-expression.js` | ~200 | 安全表达式求值器 |
| `user-whitelist.js` | ~100 | 平台用户白名单 |
| `toolset-policy.js` | ~150 | 工具集策略管理 |
| `auth-oauth.js` | ~200 | OAuth 2.0 登录流 |
| `auth/pairing.js` | ~200 | 安全配对码系统 |
| `secure-storage.js` | ~200 | AES-256-GCM API 密钥加密 |
| `secret-redactor.js` | ~200 | 50+ 敏感模式运行时遮掩 |
| `exec-approval.js` | ~300 | 命令执行审批 |

---

## 8. 审计系统

### 8.1 两个版本

| 版本 | 行数 | 格式 | 特性 |
|------|------|------|------|
| v1 (`audit-log.js`) | 391 | JSON 数组 (单文件) | 1000 条目上限, 异常检测, 风险评分 |
| v2 (`audit-log-v2.js`) | 558 | JSONL (追加日志) | 42 事件类型, 自动轮转, 敏感数据遮掩 |

### 8.2 v2 事件类别

`user` / `config` / `skill` / `tool` / `file` / `network` / `security` / `backup` / `evolution` / `webhook` / `directive` / `error` (12 类, 42 种子类型)

---

## 9. 内存系统

### 9.1 架构 (40+ 文件)

**多存储混合架构：**

```
User Input
  → SessionMemory (短期会话缓冲)
  → AutoMemory (对话事实提取)
  → EnhancedMemorySystem (HRR 向量语义搜索)
  → HebbianGraphStore (联想记忆图)
  → EntityGraph (实体共现关系)
  → TemporalGraph (时间序列事实跟踪)
  → FTS (全文关键词检索)
  → UnifiedStore (SQLite 持久化)
```

### 9.2 核心模块

| 模块 | 行数 | 用途 |
|------|------|------|
| `memory/index.js` | 433 | HRR 向量搜索 + 信任评分 + Agent 隔离 |
| `memory/memory-manager.js` | 958 | 中央编排器 (会话/提取/梦境/归档) |
| `memory/unified-store.js` | — | SQLite 统一存储层 |
| `memory/scoring.js` | — | 动态信任评分管理 |
| `memory/hrr-engine.js` | — | HRR 向量编码引擎 |
| `memory/entity-resolution.js` | — | 实体提取与消歧 |
| `memory/hebbian-graph-store.js` | — | Hebbian 学习关联图 |
| `memory/context-integrator.js` | — | 增强上下文准备 |
| `memory/decay-engine.js` | — | 时间衰减引擎 |
| `memory/auto-dream.js` | — | 梦境引擎 (周期性综合) |

### 9.3 检索融合

所有存储结果通过 **RRF (Reciprocal Rank Fusion)** 融合，综合分数：HRR 相似度 (60%) + 信任评分 (20%) + 时效性 (20%)

---

## 10. 配置系统

### 10.1 三层重叠架构

1. **环境变量** (`loadEnv()`)
2. **JSON 配置** (`config.json` → `DATA_DIR/.crabpaw/`)
3. **YAML 配置** (`config.yaml` — 184 行模板)

### 10.2 关键特性

- API 密钥 AES-256-GCM 加密绑定机器身份
- 多提供商模型路由 (chat/reasoning/vision/image/TTS/ASR/embedding)
- 深度合并 + 原型污染防护
- 文件监听热重载 (1 秒缓存失效)
- 内置配置 FAQ (73 条知识条目)

---

## 11. 评估系统

### 11.1 21 个测试套件

| 类别 | 套件数 | 覆盖模块 |
|------|--------|---------|
| 工具合约 | 1 | 工具输入验证 |
| 钩子系统 | 1 | 28 个钩子测试 |
| 循环检测 | 1 | 26 个循环检测测试 |
| 预算执行 | 1 | 7 个预算测试 |
| Harness | 3 | 指标/合约/生命周期 |
| 其他 | 14 | 沙箱/个性化/事件总线/条件/配置文件等 |

### 11.2 当前状态

- **160/160 测试通过 (100%)**
- **总运行时间 98ms**
- CI 门禁: lint → test → eval
- 快照回归检测: `latest.json` (160/160), `baseline-v3.json`

---

## 12. Harness 框架

### 12.1 8 维度架构

| 维度 | 实现 | 状态 |
|------|------|------|
| 1. 工具即合约 | `tool-contract.js` (80+ 合约) | ✅ |
| 2. 提示即代码 | `system-prompt.js` v2.1.0 (4 层) | ✅ |
| 3. 上下文预算 | `budget-enforcer.js` (5 级降级) | ✅ |
| 4. 循环纪律 | `loop-detection.js` (3 策略 + 断路器) | ✅ |
| 5. 子 Agent 合约 | `agent-contract-validator.js` | ✅ |
| 6. Eval 驱动 | 21 套件, CI lint→test→eval | ✅ |
| 7. 可观测性 | audit-log-v2 (42 事件), 指标管道 | ✅ |
| 8. 治理 | `HARNESS.md` v2.2.0, CI/CD | ✅ |

### 12.2 钩子系统 (`harness-hooks.js` — 407 行)

6 种钩子类型：PreToolUse / PostToolUse / Command钩子 / HTTP钩子 / Prompt钩子 / Agent钩子

### 12.3 生命周期管理器 (`harness-lifecycle.js` — 399 行)

集成 4 个子系统：SelfHealingEngine + RecoveryChain + FeedbackLoop + MetricsCollector

---

## 13. 语音对话系统深度分析

### 13.1 整体架构

```
前端 (GUI)                       后端 (Server)
─────────                       ────────────
usePushToTalk ──WS PCM──→  voice-cloud-ws.js (ASR WebSocket)
useVoiceSession                voice-asr-handler.js (ASR 会话)
useVoiceReply ──SSE──→    TTS Engine (8 providers)
useWakeWord                   voice-tool.js (AI 工具)
VoiceIntegration              multimodal-tools.js
VoiceStateContext              voice-evolution.js
TTSFxProcessor                tts-evolution.js
AudioOutputManager            request-handler.js (TTS/ASR API)
VoiceDiagnostics              diagnose-handler.js
```

### 13.2 TTS 引擎 (`src/core/tts/index.js` — 936 行)

**8 个 Provider：**

| Provider | 类型 | 状态 |
|----------|------|------|
| doubao | 火山引擎 TTS | ✅ 可用 |
| deepseek | DeepSeek TTS | ❌ 已知 404 |
| qwen | Qwen TTS | ⚠️ 配置但可能被排除 |
| edge | Edge-TTS (免费) | ✅ 推荐 |
| openai | OpenAI TTS | ⚠️ 条件可用 |
| silero | 本地 TTS | ⚠️ 配置但受限 |
| local | 本地 TTS | ❌ 被构建排除 |
| piper | Piper TTS | ❌ 从未注册 |

**自动回退链：** `doubao` → `deepseek` → `qwen` → `edge` → `openai` → `silero`

注意：`local` 和 `piper` 在此链中不可达。

### 13.3 ASR 子系统 (`src/core/asr/`)

**4 个提供商：**
- 火山引擎
- 阿里云
- 腾讯云
- 本地 (模拟)

`asr.js` (204 行) 使用 localStorage 文件做状态同步，存在竞态和脏数据风险。

### 13.4 WebSocket 语音流 (`voice-cloud-ws.js`)

- 防抖时间：`_DEBOUNCE_MS = 800ms`
- 字符编码问题（`\n` 拼接问题）
- `final` 拼写错误（应为 `final`？）

### 13.5 前端语音 Hook 拓扑

```
VoiceIntegration (枢纽组件)
  ├── useWakeWord (唤醒词检测)
  ├── useVoiceSession (连续对话会话)
  │   ├── useContinuousVoice (barge-in + 静默发送)
  │   └── WebSocket ASR 连接
  ├── usePushToTalk (按键通话)
  │   └── AudioWorklet PCM 捕获
  ├── useVoiceReply (流式 TTS)
  │   └── AudioContext MP3 播放
  └── useMeetingTranscription (会议转录)

VoiceStateContext (状态聚合)
  └── → window.__ 全局变量 (向后兼容)
```

### 13.6 Bug 汇总 (27 个)

参见 [Bug 汇总](#16-bug-汇总) 中的 V1-V26 和 C1-C4。

---

## 14. 面板系统分析

### 14.1 后端架构

```
panel-handler.js (REST API)
  ├── GET /panels → 返回所有面板数据
  ├── GET /panels/{name} → 单面板数据
  ├── POST /panels/{name} → 更新面板配置
  ├── POST /panels/activity/state → 更新活动状态
  └── SSE /events → 面板变更推送

panel-tools.js (AI 工具)
  ├── ShowHotspot (热搜面板)
  ├── ShowWeather (天气面板)
  └── ShowMemoryGraph (记忆图谱)

panels/ (面板注册中心)
  ├── panel-registry.js (注册中心)
  ├── hotspot.js (热搜 — 微博/抖音/百度/知乎)
  ├── weather.js (天气 — OpenWeatherMap/wttr.in)
  ├── status.js (服务状态)
  └── memory-graph.js (记忆图数据)
```

### 14.2 前端架构

```
Sidebar (侧边栏)
  ├── tabs → Dashboard activeTab
  └── ServiceStatus 指示器

Panel 组件
  ├── HotspotPanel + HotspotEarth
  ├── ActivityStream
  ├── StatusBar
  ├── DocPanel
  ├── FileBrowser
  └── MemoryGraph

SceneShell (Scene 协议覆盖层)
  └── SceneSurface → 17 种卡片
```

### 14.3 Bug 汇总 (11 个)

参见 [Bug 汇总](#16-bug-汇总) 中的 P1-P11。

---

## 15. 跨系统串联问题

参见 [Bug 汇总](#16-bug-汇总) 中的 C1-C4。

---

## 16. Bug 汇总

### 严重性分布

| 严重性 | 数量 | 占比 |
|--------|------|------|
| 🔴 CRITICAL | 10 | 26% |
| 🟠 HIGH | 13 | 33% |
| 🟡 MEDIUM | 9 | 23% |
| 🔵 LOW | 7 | 18% |
| **总计** | **39** | **100%** |

### 16.1 语音系统 — 致命/严重级 (V1-V6)

| ID | 严重性 | 文件 | 问题 |
|----|--------|------|------|
| V1 | 🔴 CRITICAL | `request-handler.js:742-813` | 后端 TTS 单例被并发请求相互覆盖，从不恢复 |
| V2 | 🔴 CRITICAL | `request-handler.js:906` vs `tts/index.js:112` | 音频服务目录与 TTS 输出目录不一致，音频 404 |
| V3 | 🔴 CRITICAL | `request-handler.js:924` | `validateCredentials()` 无参数 → `asrReady` 永远 false |
| V4 | 🔴 CRITICAL | `VoiceStateContext.tsx:57` | stateRef 非响应式，所有消费者看到编译时状态 |
| V5 | 🔴 CRITICAL | `VoiceIntegration.tsx:62-65` | `onStateChange` 在字符串上访问 `.sessionActive` |
| V6 | 🔴 CRITICAL | `useVoiceSession.ts:123` | `volume` 硬编码为 0，VoiceOrb 动画失效 |

### 16.2 语音系统 — 高级 (V7-V13)

| ID | 严重性 | 文件 | 问题 |
|----|--------|------|------|
| V7 | 🟠 HIGH | `usePushToTalk.ts:479` | `sendPcm` 在 WS CLOSING 状态抛异常，无声 try/catch |
| V8 | 🟠 HIGH | `useVoiceSession.ts:570-604` | WS 重连孤立旧 WebSocket，泄漏连接 |
| V9 | 🟠 HIGH | `piper-provider.js` / `tts/index.js` | Piper 本地 TTS 从未注册到引擎 |
| V10 | 🟠 HIGH | `piper-provider.js:148` | `const process = exec(...)` 遮蔽 Node.js 全局 process |
| V11 | 🟠 HIGH | `voice-asr-handler.js:84` | 段 ID 字典序排序导致转录乱序 |
| V12 | 🟠 HIGH | `VoiceIntegration.tsx:203` | AudioOutputManager 无必要 props，`setSinkId` 空操作 |
| V13 | 🟠 HIGH | `useVoiceSession.ts:359,501` | 看门狗 + `onclose` 双重计数重连次数 |

### 16.3 语音系统 — 中低级 (V14-V26)

| ID | 严重性 | 文件 | 问题 |
|----|--------|------|------|
| V14 | 🟡 MEDIUM | `useVoiceReply.ts:832` | `playStreamingTTS` 不挂载 `__voiceResumeTTS` |
| V15 | 🟡 MEDIUM | `tts/index.js:153,134` | `local` TTS 在提供者排序中被跳过 |
| V16 | 🟡 MEDIUM | `tts/index.js:133` | DeepSeek TTS 已知 404 但仍可被选择 |
| V17 | 🟡 MEDIUM | `tts/index.js:627-641` | 流模式异步设置先于监听器注册 — 数据丢失竞态 |
| V18 | 🟡 MEDIUM | `tts/index.js:923` | `_streamNonStreamingAsStream` 删除源文件 |
| V19 | 🟡 MEDIUM | `TTSFxProcessor.ts:77-83` | LFO 振荡器永不停止 — AudioNode 泄漏 |
| V20 | 🟡 MEDIUM | `useVoiceSession.ts:298-300` | 转录抑制期间重置累积，ASR 状态丢失 |
| V21 | 🟡 MEDIUM | `AudioOutputManager.tsx:66-76` | 无 getUserMedia 授权时设备标签为空 |
| V22 | 🟡 MEDIUM | `Dashboard/index.tsx:112` | `PageFallback` 拼写错误 |
| V23 | 🟡 MEDIUM | `useWakeWord.ts:215` | 唤醒词 20 次重连后永久静默失效 |
| V24 | 🟡 MEDIUM | `ts-evolution.js` | `generateSSML()` 从未被调用 |
| V25 | 🔵 LOW | `voice-asr-handler.js:89,147` | 重叠的超时定时器 |
| V26 | 🔵 LOW | `voice-evolution.js:172-174` | 缓存命中率除零产生 NaN |

### 16.4 面板系统 (P1-P11)

| ID | 严重性 | 文件 | 问题 |
|----|--------|------|------|
| P1 | 🔴 CRITICAL | `panel-tools.js:92-94` | `ShowHotspot` 传对象而非 boolean，总是绕过缓存 |
| P2 | 🟠 HIGH | `HotspotPanel/index.tsx:444-445` | 颜色正则 `\w+` 不匹配 `#`，Stat Card 背景失效 |
| P3 | 🟠 HIGH | `StatusBar/index.tsx:35` | `tokenUsed` 永远 0，进度条永远 0% |
| P4 | 🟡 MEDIUM | `panel-handler.js:63,93,103` | API 响应包装不一致 (3 种格式) |
| P5 | 🟡 MEDIUM | `MemoryGraph/index.tsx:509-520` | 滚轮事件监听器泄漏，缩放失控 |
| P6 | 🟡 MEDIUM | `HotspotPanel/index.tsx:133-135` | `result?.ok` 不匹配后端格式 |
| P7 | 🟡 MEDIUM | `ActivityStream/index.tsx:588-598` | 去重键可能产生 `"undefined|undefined"` |
| P8 | 🔵 LOW | `MemoryGraph/index.tsx:412-435` | 注入的 `<style>` 元素永不移除 |
| P9 | 🔵 LOW | `panels-v2-tool.js:25-31` | `_pushScene` 空 catch |
| P10 | 🔵 LOW | `HotspotPanel/index.tsx:106` | SkeletonBar 动画错误 |
| P11 | 🔵 LOW | `panel-handler.js:146-156` | `readJsonBody` 静默吞掉 JSON 解析错误 |

### 16.5 跨系统串联 (C1-C4)

| ID | 严重性 | 问题 |
|----|--------|------|
| C1 | 🔴 CRITICAL | TTS 文本在 handler 和 engine 中被重复处理 |
| C2 | 🟠 HIGH | Piper + SSML 双重死代码 — 各自开发但从未集成 |
| C3 | 🟠 HIGH | `doubaoAppId` 未映射到 WS creds — 实时 ASR 认证失败 |
| C4 | 🟡 MEDIUM | `handleVoiceDiagnose` GET/POST 方法无区分 |

---

## 17. 代码规模统计

### 17.1 按区域估算

| 区域 | 估算行数 |
|------|---------|
| 后端核心 (src/core/) | ~25,000 |
| CLI/处理器 (src/cli/ + src/handlers/) | ~8,000 |
| 信道系统 (src/channels/) | ~8,000 |
| 安全系统 (src/core/security/) | ~3,000 |
| 内存系统 (src/core/memory/) | ~7,000 |
| 技能系统 (src/core/skill/) | ~10,000 |
| 插件系统 | ~3,000 |
| TTS/ASR/语音 | ~4,000 |
| **后端总计** | **~68,000** |
| **前端总计 (gui/)** | **~40,000** |
| **Evals/测试** | **~3,000** |
| **项目总计** | **~111,000** |

### 17.2 巨型文件榜单

| 文件 | 行数 | 职责 |
|------|------|------|
| `ai.js` | ~4856 | AI 核心引擎 |
| `Dashboard/index.tsx` | ~3024 | 前端主壳 |
| `wechat-desktop-monitor.js` | ~2655 | 微信桌面监控 |
| `system-prompt.js` | ~1705 | 系统提示构建 |
| `config.js` | ~1702 | 配置管理 |
| `skills.js` | ~1785 | 技能执行器 |
| `workflow-engine.js` | ~1500 | 工作流引擎 |
| `request-handler.js` | ~1200 | HTTP 路由 |

---

## 18. 架构决策评估

### 18.1 优点

| 决策 | 评估 |
|------|------|
| Harness 8 维度框架 | 系统化的 AI Agent 质量保证体系 |
| 多层安全架构 | 深度防御，从白名单到沙箱到注入检测 |
| 多存储混合内存 | RRF 融合带来高检索质量 |
| 事件驱动架构 | 松耦合，适合多信道集成 |
| 贡献桥接插件 | 插件与主系统干净集成，可溯源 |
| Markdown 原生技能 | 人类可读、版本可控、安全性可扫描 |
| 快照回归测试 | 自动化质量保障 |
| Scene 协议 | Agent 驱动 UI 的创新模式 |
| 5 级预算降级 | 优雅的资源管理策略 |

### 18.2 值得关注的决策

| 决策 | 评估 |
|------|------|
| Dashboard 3024 行巨型文件 | 严重违反单一职责原则 |
| `window.__` 全局污染 | 跨组件通信的反模式 |
| `var` 声明 (request-handler.js) | 过时模式 |
| 模块级全局可变状态 | 测试困难和竞态风险 |
| 多版本并行 (audit v1+v2) | 过渡期合理，应计划清理 |
| 无单元测试 (仅 E2E) | 测试覆盖缺口 |
| 无 React Router | Electron 环境中的务实选择 |
| 子进程架构 (信道桥接) | 进程隔离好，但管理复杂 |
| 硬编码的端口号 | 灵活度不足 |
| 静默 catch 块 | 违反"无静默失败"规则 |

### 18.3 修复优先级建议

**P0 — 立即修复（阻止功能运行）：**
1. V1 — TTS 引擎并发修复
2. V2 — 统一音频目录
3. V3 — 传递正确 config 到 `validateCredentials`
4. V4+V5 — 重写 VoiceStateContext
5. V6 — 修复 volume 变量
6. P1 — 修复 ShowHotspot 参数

**P1 — 高优先级（功能降级）：**
7. P2 — 颜色正则修复
8. P3 — token 用量追踪
9. V7 — `sendPcm` try/catch
10. V8 — WS 重连清理
11. V11 — 数字排序
12. V26 — 除零修正

**P2 — 中等优先级（质量/性能）：**
13. V9 — 注册 Piper
14. V10 — 重命名 `process` 变量
15. V13 — 统一重连计数
16. P4 — 统一 API 格式
17. P5 — 清理滚轮监听器

---

## 附录 A: 信道路由图

```
User Message (任何信道)
  → ChannelManager (统一事件总线)
    → 信道处理器 (消息规范化)
    → GroupRouter (策略: mention_only / all / off)
    → AI Core (chat 引擎)
      → Tool Orchestrator (工具执行)
      → Workflow Engine (工作流处理)
      → Memory System (记忆存储)
    → 发送响应
    → AuditLogV2 (审计记录)
```

## 附录 B: AI Chat 流

```
用户发送消息
  → POST /chat (SSE)
    → ai.js: chat()
      → context.js: 准备上下文
      → system-prompt.js: 构建提示
      → model-router.js: LLM 调用
      → streaming.js: 流式处理
        → tool-orchestrator.js: 工具路由
          → tool-contract.js: 合约验证
          → 安全系统: 安全检查
          → 工具执行
        → loop-detection.js: 循环检测
      → memory-system: 记忆存储
    → SSE 事件流回前端
```

## 附录 C: 文件到 Bug 交叉引用

| 文件 | 相关 Bug |
|------|----------|
| `request-handler.js` | V1, V2, V3, C4 |
| `tts/index.js` | V1, V2, V15, V16, V17, V18, C1 |
| `voice-asr-handler.js` | V11, V25 |
| `voice-cloud-ws.js` | C3 |
| `voice-evolution.js` | V26 |
| `tts-evolution.js` | V24 |
| `piper-provider.js` | V9, V10 |
| `VoiceStateContext.tsx` | V4 |
| `VoiceIntegration.tsx` | V5, V12 |
| `useVoiceSession.ts` | V6, V8, V13, V20 |
| `usePushToTalk.ts` | V7, V11 |
| `useVoiceReply.ts` | V14 |
| `useWakeWord.ts` | V23 |
| `TTSFxProcessor.ts` | V19 |
| `AudioOutputManager.tsx` | V21 |
| `Dashboard/index.tsx` | V22 |
| `panel-tools.js` | P1 |
| `panel-handler.js` | P4, P11 |
| `panels-v2-tool.js` | P9 |
| `HotspotPanel/index.tsx` | P2, P6, P10 |
| `StatusBar/index.tsx` | P3 |
| `ActivityStream/index.tsx` | P7 |
| `MemoryGraph/index.tsx` | P5, P8 |

---

> 报告已生成完毕
