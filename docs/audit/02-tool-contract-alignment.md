# 02 — 工具契约对齐审计报告

> 阶段：P1 工具契约对齐 · 紧随 01-api-contract-alignment 之后
> 日期：2026-07-30
> 范围：`src/tools/*.js`（59 模块）、`src/tools/registry.js`、`src/core/tool-contract.js`

## 一、背景与目标

HARNESS.md v2.2.0 规定所有工具契约必须使用 PascalCase 命名，并具备四个核心字段：
`description` / `schema` / `whenNotToUse` / `riskLevel`。`ToolRegistry.register()` 期望
工具以 `handler` 字段暴露执行函数，但历史代码中存在两类严重违例：

1. **`execute` 误用为 `handler`**：工具注册时使用 `async execute(params) {}` 简写方法，
   导致 `entry.handler` 为 `undefined`，`registry.execute()` 调用 `tool.handler(...)` 时
   抛 `TypeError: tool.handler is not a function` —— **工具完全不可用**。
2. **非标准 `parameters` 字段**：`reminder-tool.js` 使用顶层 `parameters` 而非 `schema`，
   导致 `entry.schema` 为 `undefined`，OpenAI/Claude schema 导出时该工具被静默丢弃。

本轮目标：消除全部功能性契约违例，建立回归测试防线，杜绝此类 BUG 再产生。

## 二、审计发现

### 2.1 `execute` → `handler` 违例（18 处，功能性阻断）

通过 `rg -n "async execute\s*\(" src/tools/` 与 `tsc` 联合定位，确认 18 处违例：

| 文件 | 违例数 | 工具名 | 影响 |
|------|--------|--------|------|
| `src/tools/document-tools.js` | 11 | doc_read / xlsx_query / pdf_extract / doc_to_markdown / docx_generate / xlsx_generate / pptx_generate / pdf_generate / html_generate / html-presentation / presentation-builder | 文档读写全线不可用 |
| `src/tools/email-tools.js` | 4 | email_list / email_read / email_search / email_send | 邮件工具全线不可用 |
| `src/tools/platform-api-tools.js` | 3 | wechat_mp_draft / wechat_mp_publish / platform_keys_status | 微信公众号工具不可用 |

> 注：`registry.js:283` 的 `async execute(name, params, context)` 是注册表自身的执行方法，非违例。

### 2.2 `schema` 缺失（3 处，功能性阻断）

`reminder-tool.js` 的 SetReminder / ListReminders / RemoveReminder 使用顶层 `parameters`
（非 JSON Schema 格式，逐字段 `required: true`），导致 `schema: undefined`，schema 导出被丢弃。

### 2.3 契约字段缺失（软债务）

| 字段 | 覆盖率（修复前） | 说明 |
|------|------------------|------|
| `description` | ~99% | 个别工具依赖 schema.description 兜底 |
| `schema` | 98.5%（193/196） | 仅 reminder 3 个缺失 |
| `riskLevel` | 0%（未捕获） | registry.register 解构未包含，全部丢失 |
| `whenNotToUse` | ~5% | 仅 5 个文件声明 |

## 三、修复内容

### 3.1 `registry.js` 契约加固（[src/tools/registry.js](file:///d:/bossagent/src/tools/registry.js)）

`register()` 方法增强：

- **捕获 `whenNotToUse` / `riskLevel`**：原先解构未包含这两个字段，现已持久化到 entry。
- **`execute` → `handler` 自动兜底**：检测到 `execute` 函数时自动映射为 `handler` 并告警，
  作为历史代码的安全网（即便源码未修，工具也能运行）。
- **硬校验**：`name` 非空、`handler` 必须为函数，否则抛错阻断注册。
- **riskLevel 自动派生**：未声明时根据 `isDangerous` 派生（dangerous→high，否则 low），
  并校验值域 `low|medium|high`。
- **软告警**：缺 `description` / `whenNotToUse` 时打印引导提示，不阻断。

### 3.2 18 处 `execute` → `handler` 重命名

对三个文件批量将 `async execute(params) {` 重命名为 `async handler(params) {`：
- `document-tools.js`：11 处
- `email-tools.js`：4 处
- `platform-api-tools.js`：3 处（含 1 处无参 `async execute() {`）

### 3.3 `reminder-tool.js` schema 重写

将 3 个工具的非标准 `parameters` 改写为标准 JSON Schema `schema`，并补全 `toolset` /
`whenNotToUse` / `riskLevel`。

### 3.4 契约字段补全（21 个工具）

为已修复的 18 + 3 个工具补全 `whenNotToUse` / `riskLevel`，引导模型正确选型。
由于并行 Edit 同文件触发写竞争（部分 `whenNotToUse` 注入丢失），改用原子化补丁脚本
[scripts/patch-tool-contracts.js](file:///d:/bossagent/scripts/patch-tool-contracts.js)
以「整文件读-内存替换-整文件写」方式幂等补全，最终 13 个丢失字段全部恢复。

## 四、回归测试

### 4.1 新增契约测试

[src/test/tool-contract.contract.test.js](file:///d:/bossagent/src/test/tool-contract.contract.test.js)
对全部 196 个已注册工具做动态校验：

- **硬断言**（失败即阻断）：
  - `handler` 必须是函数（核心 —— 拦截 `execute` 误用回归）
  - `name` 非空字符串、`schema` 为对象
  - 不应有工具残留 `execute` 字段（说明走了兜底路径）
  - `riskLevel` 必须全部具备
  - `isDangerous=true` 的工具 `riskLevel` 必须为 `high`
- **软度量**（汇总报告）：description / whenNotToUse / riskLevel 覆盖率

共 396 个用例，全部通过。

### 4.2 全量测试

```
Test Suites: 23 passed, 23 total
Tests:       685 passed, 685 total
```

（较修复前 21 suites / 272 tests，新增契约测试套件 +396 用例，0 回归）

### 4.3 Typecheck

`execute' does not exist in type ... handler: Function` 类错误 **全部消除**。
剩余 tools 目录 typecheck 错误均为预先存在的非契约问题（adm-zip/markitdown 缺声明、
bilibili/enterprise 浏览器上下文类型等），不在本轮范围。

## 五、契约覆盖率（修复后）

```
total=196  description=100.0%  whenNotToUse=11.7%  riskLevel=100.0%
```

- `description` / `riskLevel`：100% ✓
- `whenNotToUse`：11.7%（23/196）—— 长尾债务，由契约测试软报告持续追踪

## 六、遗留技术债务

| 优先级 | 债务 | 建议 |
|--------|------|------|
| P3 | 173 个工具缺 `whenNotToUse` | 按工具族（wecom/lark/panel 等）批量补全，可复用 patch 脚本模式 |
| P3 | `document-tools.js` 仍有 adm-zip/markitdown 缺类型声明 | 安装 `@types/adm-zip` 或本地声明 |
| P3 | `bilibili-tools` / `concept-time-tool` 类型推断错误 | 补 JSDoc typedef 或 `/** @type */` 标注 |
| P4 | `tool-contract.js` 的 `TOOL_CONTRACTS` 与 registry 注册存在两套契约定义 | 统一为单一事实源，registry.register 时自动同步到 TOOL_CONTRACTS |

## 七、经验教训

1. **并行 Edit 同文件会触发写竞争**：同一文件的多个 Edit 调用若并行执行，
   后写覆盖先写导致部分变更丢失。**同文件多编辑必须串行**，或改用原子化脚本。
2. **`execute` 与 `handler` 命名歧义**：registry 自身有 `execute()` 方法，工具字段用 `execute`
   会在阅读时造成混淆。契约应强制 `handler`，并在 register 中加兜底映射 + 告警。
3. **契约字段应在 register 时捕获**：仅 JSDoc 声明而不解构捕获，等于字段被静默丢弃。
   `riskLevel` 全量丢失即是此问题。

## 八、下一步

按综合审计计划，下一推荐项为 **P1 WebSocket 消息 schema 对齐**，或 **P2 ai.js 架构瘦身**。
