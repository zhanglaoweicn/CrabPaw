# CrabPaw 插件体系优化方案 v2

> 基于 HARNESS.md 工程规范与现有代码库的真实分析  
> 最后更新：2026-07-04

---

## 目录

1. [背景与现状](#1-背景与现状)
2. [设计原则](#2-设计原则)
3. [整体架构](#3-整体架构)
4. [插件定义规范](#4-插件定义规范)
5. [核心机制](#5-核心机制)
6. [前后端联动](#6-前后端联动)
7. [Plugin 与 Skill 的关系](#7-plugin-与-skill-的关系)
8. [功能拆分评估](#8-功能拆分评估)
9. [实施路线图](#9-实施路线图)
10. [常见问题](#10-常见问题)

---

## 1. 背景与现状

### 1.1 已有构件一览

CrabPaw 的"类插件"设施：

| 设施 | 位置 | 成熟度 | 现状 |
|------|------|--------|------|
| **PluginManager v3** | `src/core/plugin/plugin-manager.js` | ✅ 已运行 | 贡献转接器模式，支持生命周期、来源追踪、enable/disable |
| **UIRegistry** | `src/core/plugin/ui-registry.js` | ✅ 已运行 | 管理路由、侧边栏、设置面板的动态注册与广播 |
| **Manifest 解析器** | `src/core/plugin/manifest.js` | ✅ 已运行 | 读取 manifest.yaml，兼容 v1/v2 格式 |
| **PluginBridge** | `gui/src/plugin/PluginBridge.tsx` | ✅ 已运行 | React Context + 轮询，将 UI 贡献注入前端 |
| **PluginManagerPanel** | `gui/src/pages/Settings/PluginManagerPanel.tsx` | ✅ 已运行 | 设置页面中的插件管理面板 |
| **前端动态集成** | `router.tsx` / `Sidebar` / `Settings` | ✅ 已适配 | CORE_ROUTES + PluginRoutes 分离，插件侧边栏动态显示 |
| **Skill System** | `src/core/skills.js` | ✅ 独立体系 | 60+ 技能，有完整的加载/进化/推荐机制 |
| **旧 PluginSystem** | `src/core/plugin-system.js` | ✅ 桥接中 | 保持 getPluginManager() 等旧导出兼容 |
| **旧 Dashboard Plugin Scanner** | `src/core/dashboard-plugin-scanner.js` | ⚠️ 遗留 | 与 PluginManager 不互通，两套系统并存 |

### 1.2 当前插件清单

```
plugins/ 目录
├── calendar/         日程管理
├── cost/             用量统计
├── news/             资讯聚合
├── test-plugin/      验证插件
├── voice/            语音合成
│
├── (4 个 bundled 插件)
│   ├── voice-evolution/     语音进化定时器
│   ├── heartbeat-loop/      AI 心跳自检
│   ├── memory-consistency/  记忆一致性维护
│   └── regression-guard/    回归检测
│
└── example-dashboard/  旧系统插件（遗留）
```

### 1.3 关键问题

**已完成修复：**
- ✅ PluginRoutes 死代码 → 激活为动态路由 fallback
- ✅ 16 条静态路由覆盖插件路由 → 拆分为 CORE_ROUTES + PluginRoutes
- ✅ 侧边栏 9 项全硬编码 → 精简为 5 项核心，插件项从 UIRegistry 动态获取
- ✅ 插件 UI 回填插件组 → PluginManagerPanel 显示全部插件
- ✅ 插件侧边栏首次打开空白 → PluginBridge 首轮快速轮询

**未完成：**
- ❌ Skill 与 Plugin 的集成（见第 7 节）
- ❌ 旧 Dashboard Plugin Scanner 的废弃迁移
- ❌ config.yaml 与 plugin-states.json 的配置统一
- ❌ 6 个 bundled 插件（无 UI 后台定时器）无状态监控页面

---

## 2. 设计原则

### 2.1 核心思想：贡献点模式（Contribution Points）

插件系统不是"一个独立的世界"，而是**通往现有注册表的桥梁**。插件加载时，将 manifest 中的贡献点注册到已有的系统注册表中。

```
插件加载 → manifest.contributions
  ├── tools     → ToolRegistry.register(name, fn, { source: 'plugin:xxx' })
  ├── events    → EventBus.subscribe(event, handler, { source: 'plugin:xxx' })
  ├── services  → ServiceRegistry.register(name, svc, { source: 'plugin:xxx' })
  ├── routes    → UIRegistry.registerRoute(path, component, { source: 'plugin:xxx' })
  ├── settings  → UIRegistry.registerSettingsPanel(id, icon, label, component, { source: 'plugin:xxx' })
  ├── sidebar   → UIRegistry.registerSidebarItem(label, icon, path, { source: 'plugin:xxx' })
  └── skills    → SkillLoader.register({ ... , source: 'plugin:xxx' })

插件禁用 → unregisterBySource('plugin:xxx')
  → 批量清理所有已注册的贡献
```

### 2.2 三个判断标准

一个功能是否应该做成插件：

1. **有没有第二种实现的可能性？** → Y = 插件（可替换）
2. **失败时应该拖垮整个系统吗？** → N = 插件（可隔离）
3. **是否具备独立开关的价值？** → Y = 插件（节省资源/降低耦合）

这三个维度独立，任意一个为 Y 就是插件候选。

### 2.3 两个层面的开关

| 层次 | 含义 | 示例 |
|------|------|------|
| **功能级开关** | 功能本身的开/关，由用户实时操作 | 语音回复开/关 `voiceConfig.replyEnabled` |
| **插件级开关** | 整个功能模块是否加载到系统中 | 语音插件禁用 → TTS 引擎不加载、进化定时器不启动、Settings 面板不显示 |

功能关 = 省电；插件关 = 省内存、省 CPU、省启动时间、省代码加载。

### 2.4 不做什么

以下事项经讨论后明确**不在本方案范围内**：

| 事项 | 原因 |
|------|------|
| 第三方插件市场 | 当下不开市场，聚焦内部治理 |
| 插件沙箱（worker_threads） | 无第三方则不需要这层保护 |
| Skill 与 Plugin 合并 | 两个不同的体系，管理层可集成但运行层分道 |
| 6 个 bundled 插件 UI 化 | 纯后台定时器，无 UI 贡献需求 |

---

## 3. 整体架构

### 3.1 三层结构

```
┌───────────────────────────────────────────────────────────────┐
│                     Plugin Layer (插件层)                       │
│                                                               │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐                 │
│  │ voice   │  │ calendar  │  │ cost     │                 │
│  │ 语音合成 │  │ 日程管理   │  │ 用量统计  │                 │
│  └─────────┘  └───────────┘  └──────────┘                 │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ news    │  │ voice-evo │  │ heartbeat│  │ 其他 bundled │  │
│  │ 资讯    │  │ 语音进化   │  │ 心跳循环  │  │ 后台定时器    │  │
│  └─────────┘  └───────────┘  └──────────┘  └──────────────┘  │
├───────────────────────────────────────────────────────────────┤
│              Extension Points Registry (扩展点注册表)           │
│                                                               │
│  ToolRegistry  EventBus  ServiceRegistry  UIRegistry  SkillLoader│
│  (来源追踪)    (来源追踪)  (来源追踪)        (动态UI)    (来源追踪) │
├───────────────────────────────────────────────────────────────┤
│                   Core Systems (核心系统)                        │
│                                                               │
│  AI Loop  LLM Router  Context Engine  Workflow Engine  Config  │
│  Memory   Skill Sys  Evolution       Harness Lifecycle  Logger  │
│  ToolExec Security  Scheduler        Observability      CLI    │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 加载流程

```
系统启动
  │
  ├── load core (始终启用)
  │   ├── ToolRegistry, EventBus, Config, Logger
  │   ├── AI Loop, Memory, Skill System
  │   └── PluginManager.initialize()
  │
  ├── init.js → loadFromConfig(pluginConfigs)
  │   ├── 读取 _knownPlugins（_scanDir → discover）
  │   ├── 读取 plugin-states.json（用户禁用记录）
  │   ├── 跳过 enabled: false 的插件
  │   └── 逐个 load()
  │       ├── readManifest()
  │       ├── _loadContributions() → 注册到各注册表
  │       ├── _executeLifecycle('load') → 调用 plugin.js onLoad
  │       ├── _executeLifecycle('start') → 调用 onStart
  │       └── 加入 loaded Map
  │
  └── 前端 (首次渲染时)
      ├── PluginBridge 开始轮询 /api/plugins/ui-contributions
      ├── 首轮快速轮询（每2秒一次，最多10次）
      └── 拿到数据后 → 侧边栏+路由更新
```

### 3.3 插拔流程

```
用户点击 "禁用"
  → PluginManager.disable(name)
    → _executeLifecycle('stop') → 调用 plugin.js onStop
    → unregisterBySource(sourceTag)
      → ToolRegistry.unregisterBySource → 移除工具
      → EventBus.unsubscribeBySource → 取消事件订阅
      → ServiceRegistry.unregisterBySource → 移除服务
      → UIRegistry.unregisterBySource → 移除 UI 路由/侧边栏/设置
    → 从 loaded Map 移除
    → 写入 plugin-states.json { name: { enabled: false } }
    → 前端下一次轮询 → UIRegistry 快照已不含该插件贡献
    → 侧边栏项消失 / 路由变空白 / 设置面板消失

用户点击 "启用"
  → PluginManager.enable(name)
    → 查找 _knownPlugins 或扫描磁盘
    → 重新执行 load() 完整流程
    → 写入 plugin-states.json
    → 前端下一次轮询 → UIRegistry 快照已包含该插件贡献
    → 侧边栏项出现 / 路由可用 / 设置面板出现
```

### 3.4 前端三层渲染通路

```
App.tsx
  └── <Routes>
      ├── <Route path="/*" element={<RootLayout />}>
      │   ├── {CORE_ROUTES.map(route => <Route ... />)}     ← 静态 5 条
      │   └── <Route path="/*" element={<PluginRoutes />} /> ← 动态 fallback
      │       └── 匹配启用的插件路由
      └── </Route>

Sidebar/index.tsx
  ├── NAV_ITEMS (静态 5 项)        ← 聊天 / 任务 / 技能 / 记忆 / 设置
  ├── visiblePlugins (旧系统)      ← 遗留，待移除
  └── pluginContributions.sidebars ← 动态（由启用的插件贡献）
      └── 日历 / 用量 / 资讯 / 语音设置 / 测试入口

Settings/index.tsx
  ├── coreSections (静态 4 组)     ← 用户 / 模型 / 系统 / 管理
  └── pluginSettingsPanels (动态)  ← 由启用的插件注册
      └── 语音设置 / 测试插件配置
```

---

## 4. 插件定义规范

### 4.1 Manifest 格式（v2）

使用 `manifest.yaml`，位于插件目录根：

```yaml
# plugins/voice/manifest.yaml
name: voice
version: 1.0.0
kind: plugin                # plugin | skill | combined
description: "语音合成"
author: "CrabPaw Core"
license: MIT

lifecycle:
  init: onLoad              # 方法名映射（新格式）
  start: onStart
  stop: onStop

contributes:
  ui:
    routes:
      - path: /calendar
        component: calendar-page
        label: 日程
        icon: Calendar
    sidebar:
      - id: voice-settings
        icon: Volume2
        label: 语音设置
        section: settings
    settings:
      - id: voice
        icon: Volume2
        label: 语音设置
        group: 插件
  tools:
    - name: TextToSpeech
      handler: ./tools/tts.js
      category: voice
      riskLevel: low
  events:
    - on: session:created
      handler: ./handlers/on-session.js
  skills:
    - module: ./skills/voice-control
      triggers: ["朗读"]
```

### 4.2 兼容格式（v1 回退）

```yaml
name: calendar
version: 1.0.0
kind: plugin

lifecycle:
  init: onLoad

contributes:
  ui:
    routes:
      - path: /calendar
        component: calendar-page
        label: 日程
```

旧格式 `contributions.{tools,events,...}` 在 `_resolveContribs()` 中自动兼容。

### 4.3 Manifest 解析规则

| 字段 | 必需 | 说明 |
|------|------|------|
| `name` | ✅ | 仅允许 `[a-z0-9_-]`，用作唯一标识 |
| `version` | ✅ | semver |
| `kind` | ❌ | 默认 `plugin` |
| `description` | ❌ | 显示在管理面板 |
| `lifecycle.init` | ❌ | 加载阶段调用的方法名 |
| `lifecycle.start` | ❌ | 启动阶段调用的方法名 |
| `lifecycle.stop` | ❌ | 停止阶段调用的方法名 |
| `contributes.ui.routes` | ❌ | 动态路由注册 |
| `contributes.ui.sidebar` | ❌ | 侧边栏项注册 |
| `contributes.ui.settings` | ❌ | 设置面板注册 |
| `contributes.tools` | ❌ | 工具注册 |
| `contributes.events` | ❌ | 事件订阅 |
| `contributes.skills` | ❌ | 技能注册 |
| `contributes.services` | ❌ | 服务注册 |
| `contributes.middleware` | ❌ | Harness 钩子注册 |
| `platforms` | ❌ | 运行平台过滤 |
| `license` / `repository` | ❌ | 预留市场字段 |

### 4.4 目录结构规范

```
plugins/
├── voice/
│   ├── manifest.yaml        ← 必选
│   ├── plugin.js            ← 生命周期入口（可选的，纯声明式可省略）
│   ├── tools/               ← contributions.tools 引用的 handler
│   ├── handlers/            ← contributions.events 引用的 handler
│   ├── services/            ← contributions.services 引用的 service
│   └── frontend/            ← 前端组件
│       └── VoiceSettings.tsx
│
├── bundled/
│   ├── voice-evolution/
│   │   ├── manifest.yaml
│   │   └── plugin.js
│   └── ...
│
└── (每个插件独立目录，支持浅层嵌套)
```

### 4.5 生命周期入口（plugin.js）

```javascript
module.exports = {
  // 加载时调用
  async onLoad({ manifest, pluginConfig, pluginDir }) {
    // 初始化资源、连接等
  },
  // 启动时调用（贡献注册完成后）
  async onStart({ manifest, pluginConfig }) {
    // 启动定时器、后台任务等
  },
  // 停止时调用
  async onStop() {
    // 清理资源、关闭连接、停定时器
  },
};
```

---

## 5. 核心机制

### 5.1 来源追踪（Source Tracking）

这是整个插件系统的基础设施——所有注册表都支持 `source` 字段，禁用插件时批量清理。

**已实现：**

| 注册表 | 方法 | 文件 |
|--------|------|------|
| ToolRegistry | `register({..., source})` + `unregisterBySource()` | `src/tools/registry.js` |
| EventBus | `subscribe(event, handler, {source})` + `unsubscribeBySource()` | `src/core/event-bus.js` |
| ServiceRegistry | `register(name, svc, {source})` + `unregisterBySource()` | `src/services/registry.js` |
| UIRegistry | `registerRoute/settings/sidebar(..., {source})` + `unregisterBySource()` | `src/core/plugin/ui-registry.js` |

**实现逻辑：**

```javascript
disable(name) {
  // 1. 调用 onStop 生命周期
  // 2. 清理各注册表
  toolRegistry.unregisterBySource(`plugin:${name}`);
  eventBus.unsubscribeBySource(`plugin:${name}`);
  serviceRegistry.unregisterBySource(`plugin:${name}`);
  uiRegistry.unregisterBySource(`plugin:${name}`);
  // 3. 持久化禁用状态
  pluginStates[name] = { enabled: false };
  saveStates();
}
```

### 5.2 状态持久化

**文件：** `data/.crabpaw/plugin-states.json`

```json
{
  "voice-evolution": { "enabled": false, "disabledAt": "2026-07-03T..." },
  "heartbeat-loop":  { "enabled": true,  "enabledAt":  "2026-07-01T..." }
}
```

- 通过 `_loadStates()` 在插件管理器初始化时读取
- 通过 `_saveStates()` 在每次 enable/disable 后写入
- 在 `loadFromConfig()` 中检查：如果某插件被用户禁用，即使是系统 bundled 插件也跳过加载

### 5.3 插件发现的两种方式

| 方式 | 时机 | 范围 | 用途 |
|------|------|------|------|
| `_scanDir()` | `initialize()` 时 | `plugins/` + `plugins/bundled/` | 建立 `_knownPlugins` 索引 |
| `_lazyDiscoverPluginsSync()` | `listAll()` 兜底 | 同上 | 当 `_knownPlugins` 为空时，同步扫描磁盘 |

### 5.4 管理 API

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/plugins/ui-contributions` | GET | 获取 UIRegistry 快照（routes + settings + sidebars） |
| `/api/plugin-manager/list` | GET | 列出所有已知插件及状态 |
| `/api/plugin-manager/{name}/enable` | POST | 启用插件 |
| `/api/plugin-manager/{name}/disable` | POST | 禁用插件 |

---

## 6. 前后端联动

### 6.1 数据流

```
后端                                前端
────                                 ────

PluginManager._loadContributions()
  → uiRegistry.registerRoute()
  → uiRegistry.registerSidebarItem()
  → uiRegistry.registerSettingsPanel()
    ↓                               ─────────────────────
                                    PluginBridge 轮询（首轮2s间隔，之后30s）
                                      → apiGet('/api/plugins/ui-contributions')
                                      → 比较 snapshot 是否有变化
                                      → setContributions({ routes, settings, sidebars })
                                    ─────────────────────
                                      → router.tsx → PluginRoutes 使用 routes
                                      → Sidebar/index.tsx 使用 sidebars
                                      → Settings/index.tsx 使用 settings
```

### 6.2 前端实现

**PluginBridge（`gui/src/plugin/PluginBridge.tsx`）：**

```typescript
// React Context + Provider + Hook
// 1. 首轮快速轮询（每2秒一次，最多10次）解决启动时序
// 2. 常规轮询（每30秒）应对运行时插件启/禁
// 3. 暴露 usePluginContributions() hook
// 4. 插件启/禁后自动刷新无需手动
```

**路由系统（`gui/src/router.tsx`）：**

```typescript
// CORE_ROUTES（5条，静态，不可禁用）
//   - index → 首页
//   - /chat → 聊天
//   - /automation → 任务
//   - /skills → 技能
//   - /memory → 记忆
//   - /settings → 设置
//
// 辅助路由（静态，无侧边栏入口）
//   - /skills-management, /evolution-log, /skill-market
//   - /status, /gateway, /logs
//
// PluginRoutes（动态，由插件开关控制）
//   - /calendar → 日历页面（calendar 插件启用时）
//   - /news → 资讯（news 插件启用时）
//   - /cost → 用量（cost 插件启用时）
```

**侧边栏（`gui/src/components/Sidebar/index.tsx`）：**

```
NAV_ITEMS（静态5项）：聊天 / 任务 / 技能 / 记忆 / 设置
──────────────────────────────────────────────────
插件分组（动态）：
  {pluginContributions.sidebars.map(item => ...)}
  → 日历 / 用量 / 资讯 / 语音设置 / 测试入口
  → 图标通过 PLUGIN_ICON_MAP 映射到 Lucide 组件
```

**图标映射（`gui/src/components/Sidebar/index.tsx`）：**

```typescript
const PLUGIN_ICON_MAP: Record<string, LucideIcon> = {
  Calendar, Newspaper, BarChart3, Cpu,
  Globe, Monitor, MessageSquare, Volume2,
  Puzzle,  // fallback
}
```

插件 manifest 声明什么图标名，侧边栏就显示什么图标。

### 6.3 设置面板集成

**导航源拼接（`Settings/index.tsx`）：**

```
组（核心）                          ← 硬编码
  user / profile / channel / model / security / search / update / backup
组「管理」                          ← 硬编码
  plugin-manager
──────────────────────────────────
组「插件」（动态）                   ← 从 UIRegistry 获取
  pluginSettingsPanels.map(p => ...)
```

---

## 7. Plugin 与 Skill 的关系

### 7.1 本质区别

| 维度 | **代码插件（Plugin）** | **提示词技能（Skill）** |
|------|----------------------|----------------------|
| 本质 | 系统能力的扩展 | AI 知识的提示 |
| 运行载体 | Node.js 运行时 | LLM 的上下文窗口 |
| 被谁使用 | 系统自动执行 | AI 自主决定使用 |
| 有无状态 | 有（连接池、缓存、定时器） | 无（纯文本） |
| 生命周期 | init → start → stop → unload | enable → (LLM读到) → disable |
| 失败模式 | 可能抛异常、内存泄漏 | 不会——它只是文本 |
| 谁产生 | 开发者编写 | 任何人 + Evolution 自动生成 |
| 数量规模 | ~几十个 | ~几百个（含自动生成的） |
| "禁用"效果 | 明确可感知（工具没了、UI 消失了） | 不可感知（AI 仍然能做这件事） |
| 管理必要性 | 必须手动控制 | Evolution 系统自动管理 |

### 7.2 不合并的理由

1. **禁用一个技能的"禁用"几乎没有意义**——AI 仍然可以完成该任务，只是少了优化提示
2. **Skill 数量远超 Plugin**（60+ vs 10），强行塞进一个面板造成噪音
3. **Skill 无代码无生命周期**，强行给 SKILL.md 塞 `init/start/stop` 是过度设计
4. **Skill 已经有自己的管理入口**（`/skills` 页面）和**自动管理机制**（Evolution 系统自动淘汰低质量技能）

### 7.3 唯一可行的衔接点

| 衔接点 | 可行性 | 实现成本 |
|--------|--------|---------|
| `listAll()` 中追加技能列表 | ✅ 低（~25 行，只读数据） | 0.5 天 |
| 管理面板同时展示 "提示词插件" 类型 | ✅ 低（前端已支持 kind: 'skill'） | 0.1 天 |
| PluginManager 记录技能禁用状态 | ✅ 低（只写 plugin-states.json） | 0.2 天 |
| buildSkillsPrompt() 过滤已禁用技能 | ⚠️ 中（需要改技能系统核心逻辑） | 1 天 |
| 技能 Evolution 与 Plugin 状态互通 | ❌ 不推荐（两个系统的生命周期不同） | — |

**建议：不做合并。** 让用户去 `/skills` 页面管理技能（浏览、编辑、创建），在插件管理面板管插件（启/禁、监控状态）。两个入口，两个职责，互不打扰。

---

## 8. 功能拆分评估

### 8.1 当前哪些功能已经在插件中

| 功能 | 插件名 | 加载方式 | 禁用效果 |
|------|--------|---------|---------|
| 日程管理 | `calendar` | `getPluginManager` | ✅ 侧边栏消失、路由空白 |
| 资讯聚合 | `news` | `getPluginManager` | ✅ 侧边栏消失、路由空白 |
| 用量统计 | `cost` | `getPluginManager` | ✅ 侧边栏消失、路由空白 |
| 语音合成 | `voice` | `getPluginManager` | ✅ 侧边栏消失 |
| 语音进化 | `voice-evolution` | `getPluginManager` | ✅ 定时器停止 |
| 心跳循环 | `heartbeat-loop` | `getPluginManager` | ✅ 循环停止 |
| 记忆一致性 | `memory-consistency` | `getPluginManager` | ✅ 定时器停止 |
| 回归检测 | `regression-guard` | `getPluginManager` | ✅ 检测停止 |

### 8.2 评估矩阵：剩余功能

| 功能 | 独立UI | 后台资源 | 多实现 | 硬编码在init.js | 建议 |
|------|--------|----------|--------|---------------|------|
| **Settings: 搜索配置** | ✅ 设置面板 | ❌ | ❌ | ❌ | 低 — 可拆可留 |
| **Settings: 更新设置** | ✅ 设置面板 | ❌ | ❌ | ❌ | 低 — 可拆可留 |
| **Settings: 数据备份** | ✅ 设置面板 | ❌ | ❌ | ❌ | 低 — 可拆可留 |
| **Skills 页面** | ✅ 独立页面 | ❌ | ❌ | ❌ | 不拆 — 技能管理中心 |
| **SystemDoctor** | ❌ 无UI | ✅ 定时诊断 | ❌ | ✅ | 低 — 可搬运为新 bundled |
| **JobQueue 恢复** | ❌ 无UI | ✅ 启动时恢复 | ❌ | ✅ | 低 — 可搬运为新 bundled |
| **Skill Crystallizer** | ❌ 无UI | ✅ 后台蒸馏 | ❌ | ✅ | 低 — 可搬运为新 bundled |

---

## 9. 实施路线图

### 9.1 已完成（P0-P3 + P4 部分）

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0 基础设施 | 来源追踪（3 个注册表）+ Manifest 解析器 + UIRegistry + PluginManager 重构 | ✅ |
| P1 前端扩展点 | PluginBridge + 动态路由/侧边栏/设置面板 | ✅ |
| P2 功能拆分 | 6 个 bundled 插件 + init.js 改造 + test-plugin 验证 | ✅ |
| P3 管理面板 | 后端 API（list+enable+disable）+ PluginManagerPanel | ✅ |
| P4 补完 | 发现范围扩展到 plugins/ 根 + 语音/日历 manifests | ✅ |
| 审计修复 | 所有被 linter 损坏的文件恢复 + 验证 | ✅ |

### 9.2 待完成

| 编号 | 事项 | 工作量 | 优先级 |
|------|------|--------|--------|
| P5-2 | 旧 Dashboard Plugin Scanner 废弃 / 数据迁移 | 1 天 | 中 |
| P5-3 | config.yaml 的 `plugins.bundled` 段映射 | 0.5 天 | 低 |
| P5-4 | 插件管理面板增加搜索/过滤功能 | 1 天 | 低 |
| P5-5 | 插件健康状态指示（运行时长/错误计数） | 1 天 | 低 |

---

## 10. 常见问题

### Q1：禁用一个插件，效果是立即生效还是重启生效？

**立即生效。** `disable()` 会：

1. 调用 `plugin.js` 的 `onStop()` → 清理运行时状态
2. 调用 `unregisterBySource()` → 从所有注册表中移除贡献
3. 写入 `plugin-states.json` → 持久化

前端在下一次 PluginBridge 轮询（最长 30 秒）后自动更新 UI。如果插件的页面正在访问，会变为空白。

### Q2：禁用一个插件后，相关数据会丢失吗？

**不会。** `disable()` 只做两件事：停止运行时 + 从注册表移除。不删除插件目录，不清除配置文件，不销毁数据。重新 `enable()` 后一切恢复正常。

### Q3：为什么新系统不用` plugin.yaml` 而用` manifest.yaml`？

两个都支持。Manifest 解析器按优先级查找：`manifest.yaml` > `manifest.yml` > `plugin.yaml` > `plugin.yml` > `plugin.json`。推荐使用 `manifest.yaml` 以区别于旧系统。

### Q4：插件图标如何配置？

插件 manifest 的 `sidebar.icon` 字段填 Lucide 图标名（如 `Calendar`、`Volume2`），在 `Sidebar/index.tsx` 的 `PLUGIN_ICON_MAP` 中注册映射即可。未注册的图标回退到 `Puzzle`。

### Q5：迁移现有功能到插件体系需要改代码吗？

**不需要修改模块代码**，只需要：

1. 在 `plugins/` 下新建目录
2. 写 `manifest.yaml` 声明贡献点
3. 写 `plugin.js`（至少一个空的 `onLoad`）
4. （可选）从 `init.js` 中移除旧的硬编码初始化代码

模块代码不动，只改变"谁什么时候调用它"。

---

## 附录 A：文件变更对照

### 核心插件系统（`src/core/plugin/`）

| 文件 | 职责 | 关键导出 |
|------|------|---------|
| `manifest.js` | Manifest 读取和校验 | `readManifest()`, `validateManifest()` |
| `ui-registry.js` | UI 贡献注册中心 | `UIRegistry`, `getUIRegistry()` |
| `plugin-manager.js` | 插件管理引擎 | `PluginManager`, `getPluginManager()` |

### 桥接层

| 文件 | 职责 |
|------|------|
| `src/core/plugin-system.js` | 保持旧导出（`getPluginManager`, `ModelProviderPlugin` 等）兼容 |

### 前端

| 文件 | 职责 |
|------|------|
| `gui/src/plugin/PluginBridge.tsx` | React Context + 轮询获取 UI 贡献 |
| `gui/src/App.tsx` | 渲染 CORE_ROUTES + PluginRoutes |
| `gui/src/router.tsx` | CORE_ROUTES 定义 + PluginRoutes 路由匹配 |
| `gui/src/components/Sidebar/index.tsx` | 静态核心项 + 动态插件侧边栏项 |
| `gui/src/pages/Settings/index.tsx` | 核心组硬编码 + 插件组动态 |
| `gui/src/pages/Settings/PluginManagerPanel.tsx` | 插件启/禁管理面板 |

### 后端 API

| 文件 | 端点 |
|------|------|
| `src/cli/request-handler.js` | `/api/plugins/ui-contributions`, `/api/plugin-manager/list`, `/api/plugin-manager/{name}/enable`, `/api/plugin-manager/{name}/disable` |

### 插件目录

| 路径 | 说明 |
|------|------|
| `plugins/calendar/` | 日程（manifest + plugin.js） |
| `plugins/cost/` | 用量（manifest + plugin.js） |
| `plugins/news/` | 资讯（manifest + plugin.js） |
| `plugins/voice/` | 语音（manifest + plugin.js + VoiceSettings.tsx 前端面板） |
| `plugins/test-plugin/` | 验证（manifest + plugin.js + tools/*） |
| `plugins/bundled/` | 6 个后台定时器插件（各含 manifest + plugin.js） |
| `plugins/example-dashboard/` | 遗留（旧系统） |
