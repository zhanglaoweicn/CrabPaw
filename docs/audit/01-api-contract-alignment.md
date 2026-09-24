# 01 — API 契约对齐审计与修复

> 日期：2026-07-30  
> 范围：前后端 HTTP 端点契约对齐、响应信封统一、raw fetch 治理

## 一、审计发现

### 1.1 严重缺陷：Automation 页面全面 404

前端 `gui/src/pages/Automation/index.tsx` 调用的 **全部 6 组 `/api/*` 端点在后端路由表中未注册**，导致整个自动化页面非功能性（任务列表/模板/历史/工作流/版本均为空，所有操作静默失败）：

| 前端调用 | 后端注册状态 | 根因 |
|----------|-------------|------|
| `GET/POST/PATCH/DELETE /api/schedules` | ❌ 仅 `/schedules` 已注册 | 缺 `/api/` 别名 |
| `GET /api/tasks/templates` | ❌ 未注册 | `handleTemplates` 存在但为死代码 |
| `GET /api/tasks/history` | ❌ 未注册（仅 `/tasks/history`） | 缺 `/api/` 别名 |
| `GET /api/tasks/workflows` | ❌ 未注册 | `handleWorkflows` 存在但未接线 |
| `GET /api/tasks/versions/:id` | ❌ 未注册 | `handleTaskVersions` 为死代码 |
| `POST /api/tasks/cancel` | ❌ 未注册 | `handleTaskCancel` 为死代码 |

**死代码模块**：`src/tasks/core/task-api-enhanced.js` 导出 `handleTemplates` / `handleTaskVersions` / `handleTaskCancel` / `handleEnhancedSchedules`，但全代码库无任何位置导入使用。

### 1.2 响应信封不一致

后端存在两种信封风格，前端 raw `fetch` 未统一处理：

| 端点 | 信封风格 | 前端访问 | 结果 |
|------|---------|---------|------|
| `GET /api/schedules` | **嵌套** `{success, data:{cron}}` | `data.cron` | ❌ undefined |
| `GET /api/tasks/templates` | 扁平 `{success, templates}` | `data.templates` | ✓ |
| `GET /api/tasks/history` | 扁平 `{success, history}` | `data.history` | ✓ |
| `GET /api/news/sources` | 扁平 `{success, sources}` | `data.sources` | ✓ |

### 1.3 raw `fetch()` 绕过认证/超时/信封解包

前端 24 处 raw `fetch()` 绕过 `apiGet/apiPost` 助手，导致：
- 非 Electron 模式下（配置 token 时）不发送 `X-Api-Key` 头 → 401
- 无超时控制
- 不解包 `{success,data}` 信封

**误报排除**（已正确实现，无需修改）：
- `PluginBridge.tsx:67` — 已用 `apiGet`
- `Dashboard/index.tsx:1713` — 已用 `getApiHeaders()` 附加认证头（响应为 text，不能用 apiGet）
- 语音流式端点（`/api/voice/tts/stream` 等）— 合法 raw fetch（流式响应）

## 二、修复内容

### 2.1 后端路由接线 — `src/cli/request-handler.js`

1. **导入 task-api-enhanced 死代码处理器**（此前从未被 require）：
   ```js
   const { handleTemplates, handleTaskCancel, handleTaskVersions } = require('../tasks/core/task-api-enhanced');
   ```

2. **新增 ROUTE_TABLE 条目**（6 组端点）：
   - `/api/schedules` (GET/POST/PATCH/DELETE) → `handleSchedules`（既有、经实战验证）
   - `/api/tasks/templates` → `handleApiTaskTemplates`
   - `/api/tasks/history` → `handleTaskHistory`（既有，任务执行历史）
   - `/api/tasks/workflows` → `handleApiTaskWorkflows`
   - `/api/tasks/versions/:taskId` → `handleApiTaskVersions`
   - `/api/tasks/cancel` → `handleApiTaskCancel`

3. **LOCAL_HANDLERS 注册**：
   - `handleApiTaskTemplates` / `handleApiTaskCancel` — 直接委派（无路径参数提取）
   - `handleApiTaskVersions` — **修复路径提取 bug**：原 `split('/')[3]` 假定 `/tasks/versions/:id`，挂载于 `/api/tasks/versions/:id` 时会取到 `'versions'`。包装器改写 `req.url` 后委派
   - `handleApiTaskWorkflows` — `initWorkflowHandler` 从未被调用（`workflowEngine` 为 null），直接委派会 500；返回诚实空状态 `{success, workflows:[]}` 保持页面功能

4. **导出 `resolveRoute`** 供契约测试验证

### 2.2 前端迁移至 api 助手

| 文件 | 修复 |
|------|------|
| `Automation/index.tsx` | 8 处 raw `fetch` → `apiGet/apiPost/apiPatch`；修复 `data.cron` → `result.data?.cron` |
| `Settings/index.tsx` | `switchProfile` diff → `apiGet`；`exportProfile` 补 `getApiHeaders()`（二进制流保留 fetch） |
| `Settings/sections/SearchSection.tsx` | 3 处 news sources raw `fetch` → `apiGet/apiPost` |

## 三、验证结果

- **后端测试**：22 套件 / 289 用例全绿（含 17 个新增路由契约测试）
- **后端模块加载**：`require('./src/cli/request-handler')` 无异常
- **前端 typecheck**：Automation / SearchSection 零错误；Settings 仅有既有未用变量告警（line 122，非本次改动）
- **无破坏性变更**：既有 `/schedules`、`/tasks/history`、`/api/news/sources`、`/api/profiles/*` 路由全部保留

## 四、遗留项（后续处理）

1. **工作流引擎初始化**：`initWorkflowHandler` 从未调用，`/api/tasks/workflows` 暂返回空。需在服务启动时调用以激活完整工作流功能
2. **Dashboard 既有 typecheck 错误**：~15 处（`currentRoundId`、`Maximize2` 等），属历史债务，与本轮无关
3. **`src/tools/*.js` typecheck 错误**：~20 处工具契约违规（`execute`→`handler`、`parameters` 字段等），需批量对齐工具注册 schema
