# CrabPaw AI Agent Platform — 开发手册

> 版本 2.2.0 | 适用于开发者和系统集成商

---

## 目录

1. [项目概览](#1-项目概览)
2. [系统架构](#2-系统架构)
3. [快速开始](#3-快速开始)
4. [项目结构](#4-项目结构)
5. [后端核心模块](#5-后端核心模块)
6. [前端 GUI 架构](#6-前端-gui-架构)
7. [配置说明](#7-配置说明)
8. [API 参考](#8-api-参考)
9. [语音系统](#9-语音系统)
10. [技能系统](#10-技能系统)
11. [插件系统](#11-插件系统)
12. [工作流引擎](#12-工作流引擎)
13. [记忆系统](#13-记忆系统)
14. [Harness 治理框架](#14-harness-治理框架)
15. [测试与评估](#15-测试与评估)
16. [部署说明](#16-部署说明)
17. [故障排查](#17-故障排查)

---

## 1. 项目概览

CrabPaw 是一个面向中小企业的多通道 AI 助理平台，提供：

- **多通道支持**：微信桌面监听、飞书 (Lark)、企业微信 (WeCom)
- **AI 对话**：支持 DeepSeek、豆包 (Volcengine)、Moonshot、Zhipu 等多家模型提供商
- **语音交互**：TTS 语音合成、ASR 语音识别、连续对话、唤醒词、打断 (Barge-in)
- **技能系统**：69 个内置技能（skills/ 目录实测，2026-09-09；另有 data/skills/ 21 个用户技能目录），支持 Markdown 格式的技能定义
- **工作流引擎**：多阶段任务编排与审批
- **记忆系统**：短期/长期记忆、实体解析、衰减引擎、信任评分
- **桌面应用**：基于 Electron + React 的跨平台 GUI
- **Harness 框架**：8 维度治理体系（合约、提示词、预算、循环检测、子代理、评估、可观测、治理）

### 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js >= 18 |
| 桌面框架 | Electron 28 |
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式方案 | Tailwind CSS 3 + CSS 变量 |
| 图标库 | Lucide React |
| 图表 | Chart.js, Mermaid, ECharts |
| 数据库 | SQLite (better-sqlite3) |
| 测试 | Jest |
| 代码检查 | ESLint |

---

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     GUI (Electron + React)                  │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐              │
│  │Dashboard │ │Automation│ │  Settings │              │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘              │
│       │             │             │                     │
│  ┌────┴─────────────┴─────────────┴──────────────────┐  │
│  │              HTTP API (REST + SSE + WS)               │  │
│  └────────────────────────┬──────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                    Backend (Node.js CLI)                    │
│  ┌────────────┐  ┌──────────┐  ┌───────────┐              │
│  │  Channels  │  │  Handlers│  │  Services │              │
│  │  ┌───────┐ │  │ ┌──────┐ │  │ ┌───────┐ │              │
│  │  │WeChat  │ │  │ │ Chat │ │  │ │Agent  │ │              │
│  │  │ Lark   │ │  │ │Voice │ │  │ │Summary│ │              │
│  │  │ WeCom  │ │  │ │Skill │ │  │ │Plugin │ │              │
│  │  └───────┘ │  │ └──────┘ │  │ │Manager│ │              │
│  └────────────┘  └──────────┘  │ └───────┘ │              │
│                                 └───────────┘              │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐   │
│  │   AI    │ │  Memory  │ │ Workflow │ │   Skills    │   │
│  │  Core   │ │  System  │ │  Engine  │ │  Workshop   │   │
│  └─────────┘ └──────────┘ └──────────┘ └─────────────┘   │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐   │
│  │   ASR   │ │   TTS    │ │ LLM      │ │   Tools     │   │
│  │ Cloud   │ │  Engine  │ │ Adapters │ │  Registry   │   │
│  └─────────┘ └──────────┘ └──────────┘ └─────────────┘   │
└────────────────────────────────────────────────────────────┘
```

### 数据流

1. **用户输入** → GUI / Channels → Request Handler
2. **Request Handler** → AI Core (LLM) → Tool Orchestrator → Tools
3. **Memory System** ↔ AI Core (读写记忆)
4. **Workflow Engine** 编排多步任务执行
5. **SSE** 流式推送 AI 回复和工具执行状态到 GUI

---

## 3. 快速开始

### 环境要求

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **操作系统**：Windows 10+ / macOS 12+ / Linux (Ubuntu 20.04+)

### 安装步骤

```bash
# 1. 克隆仓库
git clone <仓库地址>
cd crabpaw

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key 等配置

# 4. 启动开发服务器
npm run dev

# 5. 启动 GUI (新终端)
cd gui
npm install
npm run dev
```

### 验证安装

```bash
# 运行测试
npm test

# 运行评估
npm run eval
```

### 快速命令

| 命令 | 说明 |
|---|---|
| `npm start` | 启动生产服务器 |
| `npm run dev` | 开发模式（热重载） |
| `npm run dev:gui` | 启动 GUI 开发服务器 |
| `npm test` | 运行测试套件 |
| `npm run eval` | 运行评估框架 |
| `npm run lint` | 代码检查 |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run build:gui` | 构建 GUI |
| `npm run build:electron` | 构建 Electron 应用 |
| `npm run clean` | 清理构建产物 |

---

## 4. 项目结构

```
crabpaw/
├── src/                          # 后端源码
│   ├── cli/                      # CLI 入口 & 服务器
│   │   ├── index.js              # CLI 主入口
│   │   ├── server.js             # HTTP 服务器
│   │   └── request-handler.js    # API 路由分发
│   ├── core/                     # 核心模块 (300+ 文件)
│   │   ├── ai.js                 # AI 推理核心
│   │   ├── system-prompt.js      # 系统提示词 (v2.1.0)
│   │   ├── budget-enforcer.js    # 上下文预算控制
│   │   ├── tool-contract.js      # 工具合约定义 (80+ 合约)
│   │   ├── tool-orchestrator.js  # 工具编排器
│   │   ├── workflow-engine.js    # 工作流引擎
│   │   ├── memory-system.js      # 记忆系统
│   │   ├── memory/               # 记忆子系统
│   │   ├── middleware/           # 循环检测守卫（ai.js 手动接线，无链工厂）
│   │   ├── llm/                  # LLM 适配器
│   │   ├── search/               # 搜索引擎适配
│   │   ├── tts/                  # TTS 引擎
│   │   ├── skill/                # 技能执行器
│   │   └── scene/                # 场景渲染
│   ├── handlers/                 # HTTP API 处理器 (30 文件)
│   ├── channels/                 # 通信渠道
│   ├── services/                 # 业务服务
│   ├── tools/                    # 工具实现 (59 文件)
│   ├── taskflow/                 # 任务流引擎
│   ├── schedule/                 # 调度系统
│   └── test/                     # 单元测试
│
├── gui/                          # Electron + React 前端
│   ├── src/
│   │   ├── components/           # UI 组件 (45+ 组件)
│   │   ├── pages/                # 页面 (14 页面)
│   │   ├── hooks/                # React Hooks (13 个)
│   │   ├── contexts/             # React 上下文
│   │   ├── lib/                  # 工具函数
│   │   ├── types/                # 类型定义
│   │   ├── styles/               # 全局样式
│   │   └── plugin/               # 插件系统
│   ├── electron/                 # Electron 主进程
│   │   ├── main/                 # 主进程代码
│   │   └── preload/              # 预加载脚本
│   └── package.json
│
├── plugins/                      # 可安装插件 (14 个)
├── skills/                       # 内置技能 (69 个，2026-09-09 实测)
├── evals/                        # 评估测试用例 (52 套，以 npm run eval 输出为准)
├── scripts/                      # 工具脚本
├── docs/                         # 设计文档
├── config.yaml                   # 全局配置
├── .env.example                  # 环境变量模板
└── package.json                  # 项目配置
```

---

## 5. 后端核心模块

### 5.1 AI 核心 (`src/core/ai.js`)

AI 推理的中央调度器，负责：

- LLM Provider 选择与切换
- 流式响应处理 (SSE)
- 工具调用解析与执行
- 上下文序列化与 Token 计数
- 故障转移 (Fallback)

```javascript
// 使用示例
const { buildAi } = require('./src/core/ai')
const ai = buildAi({ model: 'deepseek-v4-pro', stream: true })
```

### 5.2 工具合约 (`src/core/tool-contract.js`)

80+ 个工具合约，统一规范工具定义：

```javascript
{
  name: 'Read',
  description: '读取文件内容',
  schema: { filePath: { type: 'string' }, offset: { type: 'number' } },
  whenNotToUse: '大文件请用 Grep',
  riskLevel: 'low',
}
```

### 5.3 工具编排器 (`src/core/tool-orchestrator.js`)

负责工具的注册、查找、调用和错误处理。

### 5.4 系统提示词 (`src/core/system-prompt.js`)

4 层提示词架构 (PROMPT_VERSION 2.1.0)：
1. 基础角色定义
2. 工具使用规范
3. 行为约束
4. 动态注入（技能、记忆、环境）

### 5.5 预算执行器 (`src/core/budget-enforcer.js`)

5 级上下文降级策略：
1. 完整上下文
2. 压缩历史对话
3. 移除冗余工具输出
4. 仅保留摘要
5. 最小模式

---

## 6. 前端 GUI 架构

### 6.1 页面结构

| 页面 | 文件 | 功能 |
|---|---|---|
| Dashboard | `gui/src/pages/Dashboard/` | 主面板（对话、文件、通知） |
| Home | `gui/src/pages/Home/` | 首页引导 |
| Settings | `gui/src/pages/Settings/` | 系统配置 |
| Automation | `gui/src/pages/Automation/` | 自动化任务 |
| Skills | `gui/src/pages/Skills/` | 技能浏览 |
| SkillsManagement | `gui/src/pages/SkillsManagement/` | 技能管理 |
| Memory | `gui/src/pages/Memory/` | 记忆可视化 |
| Calendar | `gui/src/pages/Calendar/` | 日历集成 |
| News | `gui/src/pages/News/` | 热点速递 |
| Logs | `gui/src/pages/Logs/` | 日志查看 |
| Status | `gui/src/pages/Status/` | 系统状态 |
| Gateway | `gui/src/pages/Gateway/` | API 网关 |
| EvolutionLog | `gui/src/pages/EvolutionLog/` | 进化日志 |

### 6.2 核心组件

| 组件 | 路径 | 功能 |
|---|---|---|
| RightPanel | `gui/src/components/RightPanel/` | 右侧面板（语音球 + AI 执行链） |
| VoiceOrb | `gui/src/components/VoiceOrb/` | Fibonacci 点云语音球动画 |
| ActivityStream | `gui/src/components/ActivityStream/` | AI 工具执行可视化 |
| FileBrowser | `gui/src/components/FileBrowser/` | 文件浏览器 |
| SceneShell | `gui/src/components/SceneShell/` | 14 种场景渲染器 |
| Sidebar | `gui/src/components/Sidebar/` | 侧边栏导航 |
| TitleBar | `gui/src/components/TitleBar/` | 窗口标题栏 |
| VoiceIntegration | `gui/src/components/VoiceIntegration.tsx` | 语音系统集成 |

### 6.3 状态管理

- **React Context**：VoiceStateContext 管理语音系统状态
- **useState/useRef**：组件级状态管理
- **window 全局变量**：向后兼容的跨组件通信桥

### 6.4 数据流

```
User Action → Dashboard (state) → useChatStream (SSE) → Chat UI
                                 → useVoiceReply (TTS)
                                 → usePushToTalk (ASR)
                                 → VoiceIntegration (session)
                                 → RightPanel (visualization)
```

---

## 7. 配置说明

### 7.1 环境变量 (`.env`)

```env
# AI 模型配置
DEEPSEEK_API_KEY=your-key-here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro

# 语音配置
DOUBAO_ACCESS_KEY=your_access_key
DOUBAO_APP_ID=your_app_id
DOUBAO_VOICE_KEY=your_voice_key
VOLCANO_APP_ID=your_app_id
VOLCANO_TOKEN=your_token

# 飞书集成
LARK_APP_ID=your_app_id
LARK_APP_SECRET=your_app_secret

# 服务器
HTTP_PORT=3000
WS_PORT=3001
```

### 7.2 模型配置文件 (`config.yaml`)

```yaml
providers:
  deepseek:
    apiKey: ${DEEPSEEK_API_KEY}
    baseUrl: ${DEEPSEEK_BASE_URL}
    models: [deepseek-v4-pro, deepseek-chat]
  volcengine:
    apiKey: ${VOLCANO_TOKEN}
    models: [doubao-pro-32k]

voice:
  tts:
    provider: edge-tts  # doubao-tts | volcano-tts | edge-tts
    defaultVoice: zh-CN-XiaoxiaoNeural
  asr:
    provider: doubao-asr  # volcengine-asr
```

### 7.3 管理界面配置

启动后访问 Settings 页面，或在 GUI 中通过侧边栏 → 设置 进行图形化配置。

---

## 8. API 参考

### 8.1 聊天 API

**发送消息**
```
POST /api/chat/send
Content-Type: application/json
{
  "message": "你好",
  "sessionId": "optional-session-id",
  "projectId": "optional-project-id"
}
```

**流式响应 (SSE)**
```
GET /api/chat/stream?message=hello&sessionId=xxx
Accept: text/event-stream
```

### 8.2 文件 API

```
GET    /api/files/list          # 列出文件
GET    /api/files/read?path=xxx # 读取文件
POST   /api/files/write         # 写入文件
DELETE /api/files/delete        # 删除文件
```

### 8.3 配置 API

```
GET    /api/config              # 获取配置
PUT    /api/config              # 更新配置
```

### 8.4 语音 API

```
POST   /api/voice/tts           # TTS 合成
POST   /api/voice/asr           # ASR 识别
WS     /voice/cloud             # 实时语音 WebSocket
```

### 8.5 技能 API

```
GET    /api/skills/list         # 技能列表
GET    /api/skills/:id          # 技能详情
POST   /api/skills/create       # 创建技能
PUT    /api/skills/:id          # 更新技能
DELETE /api/skills/:id          # 删除技能
```

### 8.6 对话历史 API

```
GET    /api/sessions            # 会话列表
POST   /api/sessions            # 创建会话
DELETE /api/sessions/:id        # 删除会话
PUT    /api/sessions/:id/rename # 重命名会话
```

---

## 9. 语音系统

### 9.1 架构

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   ASR 引擎   │  │   TTS 引擎   │  │  会话管理    │
│  (语音→文字) │  │  (文字→语音) │  │  (连续对话)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                  │                  │
┌──────┴──────────────────┴──────────────────┴───────┐
│              VoiceIntegration (集成层)               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │Barge-in  │ │  Wake Word│ │Continuous│           │
│  │(打断检测)│ │ (唤醒词)  │ │  (连续)  │           │
│  └──────────┘ └──────────┘ └──────────┘           │
└─────────────────────────────────────────────────────┘
```

### 9.2 TTS 语音列表

**豆包 (Doubao) — 10 种声音**
- `zh_female_xiaohe_uranus_bigtts`
- `zh_male_xiaodong_uranus_bigtts`
- `zh_female_shuangkuai_uranus_bigtts`
- `zh_female_tianmei_uranus_bigtts`
- 等

**火山引擎 (Volcano) — 8 种声音**
- `BV001_streaming`
- `BV002_streaming`
- 等

**Edge TTS — 3 种声音 (离线)**
- `zh-CN-XiaoxiaoNeural`
- `zh-CN-YunxiNeural`
- `zh-CN-XiaoyiNeural`

### 9.3 连续对话配置

在 Settings → 语音 页面中配置：
- **回复语音** (replyEnabled)：开启/关闭 AI 语音回复
- **连续对话** (continuousMode)：开启后保持持续收听
- **唤醒词** (wakeWordEnabled)：支持语音唤醒

### 9.4 快捷键

| 快捷键 | 功能 |
|---|---|
| 空格键 (按住) | Push-to-Talk，临时录音 |
| 空格键 (松开) | 停止录音并发送 |
| Ctrl+Shift+D | 语音诊断面板 |

---

## 10. 技能系统

### 10.1 技能结构

每个技能是一个包含 `SKILL.md` 的目录：

```
skills/
├── core/                 # 核心技能
│   ├── code-review/
│   │   └── SKILL.md
│   └── file-operations/
├── domain/               # 领域技能
├── system/               # 系统技能
├── _builtin/             # 内置技能
└── manifest.json         # 技能清单
```

### 10.2 技能编写规范

```markdown
# skill-name

## 描述
技能的简短描述

## 触发条件
- 用户提到 X 时触发
- 关键词：xxx, yyy

## 工作流
1. 步骤一
2. 步骤二

## 输出格式
输出的模板和规范
```

### 10.3 技能管理 API

通过 GUI 的 Skills 和 SkillsManagement 页面管理技能，或使用 CLI：

```bash
# 列出技能
npm run cli -- skills list

# 安装技能
npm run cli -- skills install ./path/to/skill
```

---

## 11. 插件系统

### 11.1 插件结构

```
plugins/
├── plugin-name/
│   ├── index.js          # 插件入口
│   ├── plugin.yaml       # 插件配置
│   └── ...
```

### 11.2 可安装插件

| 插件 | 功能 |
|---|---|
| voice | 语音系统 |
| voice-evolution | 语音进化 |
| calendar | 日历集成 |
| cost | 成本追踪 |
| news | 热点速递 |
| memory-consistency | 记忆一致性 |
| regression-guard | 回归防护 |
| heartbeat-loop | 心跳监控 |

### 11.3 插件开发

```javascript
// plugins/my-plugin/index.js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',
  init(context) {
    // 注册钩子、工具、路由等
  }
}
```

---

## 12. 工作流引擎

### 12.1 核心概念

- **TaskFlow**：多阶段任务编排
- **ApprovalGate**：审批门（人工审批节点）
- **PlannerEngine**：自动分步规划
- **SubAgentOrchestrator**：子代理调度

### 12.2 工作流模板

工作流定义在 `src/taskflow/workflow-template-engine.js`，支持：
- 顺序执行
- 条件分支
- 并行执行
- 审批暂停
- 重试与回退

---

## 13. 记忆系统

### 13.1 架构

```
┌─────────────────────────────────────────┐
│              Unified Memory             │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐  │
│  │ Short   │ │ Long    │ │ Session  │  │
│  │ Term    │ │ Term    │ │ Memory   │  │
│  └────┬────┘ └────┬────┘ └────┬─────┘  │
│       │            │           │        │
│  ┌────┴────────────┴───────────┴─────┐  │
│  │  Decay Engine + Trust Scoring     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 13.2 关键模块

| 模块 | 文件 | 功能 |
|---|---|---|
| MemoryManager | `src/core/memory/memory-manager.js` | 记忆读写核心 |
| DecayEngine | `src/core/memory/decay-engine.js` | 遗忘曲线 |
| TrustScore | `src/core/memory/trust-score.js` | 可信度评分 |
| EntityResolution | `src/core/memory/entity-resolution.js` | 实体消歧 |
| TemporalGraph | `src/core/memory/temporal-graph.js` | 时序图谱 |
| HebbianGraph | `src/core/memory/hebbian-graph-store.js` | 赫布学习 |
| AutoDream | `src/core/memory/auto-dream.js` | 自动梦境整理 |

---

## 14. Harness 治理框架

CrabPaw 实现了 8 维度 AI Agent 治理框架：

| 维度 | 模块 | 说明 |
|---|---|---|
| 1. Tool as Contract | `src/core/tool-contract.js` | 80 个 PascalCase 工具合约 |
| 2. Prompt as Code | `src/core/system-prompt.js` | 4 层版本化提示词 |
| 3. Context Budgeting | `src/core/budget-enforcer.js` | 5 级降级策略 |
| 4. Loop Discipline | `src/core/middleware/loop-detection.js` | 3 种检测策略 + 熔断器 |
| 5. Sub-agent Contract | `src/core/agent-contract-validator.js` | 子代理合约验证 |
| 6. Eval-Driven | `evals/` | 52 套评估用例（以 npm run eval 实际输出为准） |
| 7. Observability | `src/core/audit-log-v2.js` | 43 种审计事件（以 AUDIT_EVENTS 实测为准） |
| 8. Governance | `HARNESS.md` | 治理规范文档 v2.4.0 |

---

## 15. 测试与评估

### 15.1 运行测试

```bash
# 单元测试
npm test

# 特定测试文件
npm test -- --testPathPattern=tool-exec

# 监听模式
npm test -- --watch
```

### 15.2 评估框架

```bash
# 运行全量评估
npm run eval

# 回归评估
npm run eval:regression

# 保存基线
npm run eval:save-baseline

# 评估监听模式
npm run eval:watch
```

### 15.3 CI/CD

GitHub Actions 工作流 (`.github/workflows/ci.yml`)：
- Node.js v18 / v20 / v22 矩阵测试
- Lint → Test → Eval 三阶段

---

## 16. 部署说明

### 16.1 生产环境部署

```bash
# 1. 安装生产依赖
npm ci --production

# 2. 构建 GUI
npm run build:gui

# 3. 打包 Electron
npm run build:release

# 4. 或使用 PM2 管理 Node 服务
npm install -g pm2
pm2 start src/cli/server.js --name crabpaw
```

### 16.2 桌面应用打包（U 盘便携版）

```bash
# 一键构建免安装文件夹版（推荐，定稿管线）
npm run build:portable

# 流程：依赖下载(CloakBrowser/Python/node.exe, 幂等) → sherpa-only rebuild
#       → tsc + vite → electron-builder dir 目标 → 洁净度门禁 → zip
# 产物：CrabPaw-Release/CrabPaw-<版本>-win64-Portable.zip（解压双击 CrabPaw.exe 即用，数据在 exe 同级 CrabPaw-Data/）
# 前置：构建机 Node 必须 24.x（better-sqlite3/sharp prebuild 与捆绑 node.exe ABI 匹配）
# 常用开关：-Check 仅前置检查 / -SkipDeps 跳过依赖下载 / -UseGhProxy GitHub 加速 / -Clean 清理旧产物
```

设计文档（坑清单/验收清单）：`docs/superpowers/specs/2026-08-25-crabpaw-portable-usb-design.md`。
注意：electron-builder `portable` 单文件目标（SFX）已判定不可用——每次启动清空 %TEMP% 解压目录导致 `CrabPaw-Data` 数据丢失，勿再用 `npm run build:usb` 类旧脚本发版；`npm run build:release` 仅构建 NSIS 安装版（gui/package.json 内保留）。

### 16.3 无头模式部署

```bash
# 仅启动后端服务（无 GUI）
npm start
# 服务监听 http://localhost:3000
```

---

## 17. 故障排查

### 常见问题

| 问题 | 解决方案 |
|---|---|
| `ECONNREFUSED` | 确认服务已启动：`curl http://localhost:3000/api/health` |
| LLM API 错误 | 检查 `.env` 中 API Key 是否正确配置 |
| TTS 无声音 | 检查 Windows 音频输出设备；尝试切换 TTS Provider |
| 微信监控无响应 | 确认已安装并登录微信客户端 |
| 构建失败 | 执行 `npm run clean && npm install` |
| 端口冲突 | 修改 `.env` 中 `HTTP_PORT` 配置 |

### 日志查看

```bash
# 查看服务日志
cat data/logs/server.log

# GUI 开发者工具
# 在 Electron 窗口中按 Ctrl+Shift+I 打开 DevTools
```

### 诊断工具

```bash
# 运行诊断
node scripts/diagnose.js

# 检查系统环境
npm run cli -- doctor
```

---

## 附录 A: 依赖清单

### 核心依赖

| 包名 | 用途 |
|---|---|
| better-sqlite3 | SQLite 数据库 |
| playwright-core | 浏览器自动化 |
| canvas | Canvas 绘图 |
| marked | Markdown 渲染 |
| mermaid | 图表渲染 |
| edge-tts | 离线 TTS |
| ws | WebSocket 通信 |
| uuid | 唯一 ID 生成 |
| js-yaml | YAML 解析 |

### GUI 依赖

| 包名 | 用途 |
|---|---|
| react / react-dom | UI 框架 |
| electron | 桌面框架 |
| vite | 构建工具 |
| tailwindcss | CSS 框架 |
| @radix-ui/* | 无障碍 UI 组件 |
| lucide-react | 图标库 |
| zustand | 状态管理 |
| three.js | 3D 渲染 |
| react-markdown | Markdown 渲染 |

---

## 附录 B: 目录速查

```
关键配置文件:
  .env.example        — 环境变量模板
  config.yaml         — 全局配置
  package.json        — 项目元数据与脚本

关键入口文件:
  src/cli/index.js               — CLI 入口
  src/cli/server.js              — HTTP 服务
  gui/src/App.tsx                — GUI 入口
  gui/electron/main/index.ts     — Electron 主进程

关键模块:
  src/core/ai.js                 — AI 核心
  src/core/tool-contract.js      — 工具合约
  src/core/memory-system.js      — 记忆系统
  src/core/workflow-engine.js    — 工作流引擎

关键文档:
  HARNESS.md          — 治理框架规范
  AGENTS.md           — AI Agent 开发指引
```

---

> 版本 2.2.0 | 最后更新 2026-09-09
