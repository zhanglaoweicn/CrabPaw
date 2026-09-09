---
name: browser-use
version: "2.0.1"
description: "浏览器自动化，通过 browser-use CLI 后台守护实现网页导航、点击、表单填写、截图、数据提取、多会话与云浏览器。当用户说“打开这个网页点一下X”“自动填表单”“从网页抓数据”“网页截图”时使用。"
metadata:
  crabpaw:
    category: general
    capabilities: [browser_automation]
    emoji: 🌐
    category: browser-automation
    triggers:
    priority: 4
    tags: [web, browser, automation]
      - browser-use
      - 浏览器自动化
      - 网页操作
      - 网页截图
      - 表单填写
---

# 浏览器自动化（browser-use）

通过 `browser-use` CLI 实现快速、持久的浏览器自动化。后台守护进程保持浏览器打开，命令间延迟约 50ms。

## 激活条件

当用户需要自动化浏览器操作时激活，例如：
- 打开网页、点击按钮、填写表单
- 截取网页截图
- 从网页提取数据
- 管理浏览器 Cookie
- 使用已登录的 Chrome Profile
- 并行操作多个浏览器

## 依赖

```bash
pip install browser-use
# 验证安装
browser-use doctor
```

## 核心工作流

1. **导航**: `browser-use open <url>` — 启动无头浏览器并打开页面
2. **检查**: `browser-use state` — 返回可点击元素及其索引
3. **交互**: 使用索引操作（`browser-use click 5`、`browser-use input 3 "文本"`）
4. **验证**: `browser-use state` 或 `browser-use screenshot` 确认结果
5. **重复**: 浏览器在命令间保持打开

如果命令失败，先运行 `browser-use close` 清理会话，然后重试。

## 浏览器模式

```bash
browser-use open <url>                         # 默认: 无头 Chromium（无需配置）
browser-use --headed open <url>                # 可见窗口（调试用）
browser-use connect                            # 连接用户 Chrome（保留登录态/Cookie）
browser-use cloud connect                      # 云浏览器（零配置，需 API Key）
browser-use --profile "Default" open <url>     # 使用指定 Chrome Profile
```

连接后，后续命令自动使用该浏览器，无需额外参数。

## 命令参考

### 导航

```bash
browser-use open <url>                    # 导航到 URL
browser-use back                          # 后退
browser-use scroll down                   # 向下滚动（--amount N 指定像素）
browser-use scroll up                     # 向上滚动
browser-use tab list                      # 列出所有标签页
browser-use tab new [url]                 # 新建标签页
browser-use tab switch <index>            # 切换标签页
browser-use tab close <index> [index...]  # 关闭标签页
```

### 页面状态（操作前先运行 state 获取元素索引）

```bash
browser-use state                         # URL、标题、可点击元素及索引
browser-use screenshot [path.png]         # 截图（无路径返回 base64，--full 全页截图）
```

### 交互（使用 state 返回的索引）

```bash
browser-use click <index>                 # 点击元素
browser-use click <x> <y>                 # 点击像素坐标
browser-use type "text"                   # 在焦点元素输入文本
browser-use input <index> "text"          # 点击元素后输入文本
browser-use keys "Enter"                  # 发送键盘按键（也支持 "Control+a" 等）
browser-use select <index> "option"       # 选择下拉选项
browser-use upload <index> <path>         # 上传文件
browser-use hover <index>                 # 悬停
browser-use dblclick <index>              # 双击
browser-use rightclick <index>            # 右键点击
```

### 数据提取

```bash
browser-use eval "js code"                # 执行 JavaScript，返回结果
browser-use get title                     # 页面标题
browser-use get html [--selector "h1"]    # 页面 HTML（可限定选择器）
browser-use get text <index>              # 元素文本
browser-use get value <index>             # 输入框值
browser-use get attributes <index>        # 元素属性
browser-use get bbox <index>              # 边界框 (x, y, width, height)
```

### 等待

```bash
browser-use wait selector "css"           # 等待元素（--state visible|hidden，--timeout ms）
browser-use wait text "text"              # 等待文本出现
```

### Cookie 管理

```bash
browser-use cookies get [--url <url>]     # 获取 Cookie
browser-use cookies set <name> <value>    # 设置 Cookie（--domain, --secure, --http-only）
browser-use cookies clear [--url <url>]   # 清除 Cookie
browser-use cookies export <file>         # 导出到 JSON
browser-use cookies import <file>         # 从 JSON 导入
```

### 会话管理

```bash
browser-use close                         # 关闭浏览器和守护进程
browser-use sessions                      # 列出活动会话
browser-use close --all                   # 关闭所有会话
```

## 云浏览器

```bash
browser-use cloud connect                 # 创建云浏览器并连接
browser-use cloud login <api-key>         # 保存 API Key（或设置 BROWSER_USE_API_KEY）
browser-use cloud logout                  # 移除 API Key
browser-use cloud v2 GET /browsers        # REST API 直通
browser-use cloud v2 POST /tasks '{"task":"...","url":"..."}'
browser-use cloud v2 poll <task-id>       # 轮询任务直到完成
```

## 隧道

```bash
browser-use tunnel <port>                 # 启动 Cloudflare 隧道
browser-use tunnel list                   # 查看活动隧道
browser-use tunnel stop <port>            # 停止隧道
browser-use tunnel stop --all             # 停止所有隧道
```

## 命令链

命令可用 `&&` 链接，浏览器通过守护进程持久化：

```bash
browser-use open https://example.com && browser-use state
browser-use input 5 "user@example.com" && browser-use input 6 "password" && browser-use click 7
```

不需要中间输出时用链式；需要解析 `state` 获取索引时分开执行。

## 常见工作流

### 已认证网站浏览

```bash
browser-use profile list                           # 查看可用 Profile
browser-use --profile "Default" open https://github.com  # 使用已登录的 Chrome
```

### 暴露本地开发服务器

```bash
browser-use tunnel 3000                            # → https://abc.trycloudflare.com
browser-use open https://abc.trycloudflare.com     # 浏览隧道
```

### 多浏览器并行

使用 `--session NAME` 运行多个独立浏览器，详见 [references/multi-session.md](references/multi-session.md)。

### CDP 原生控制

需要浏览器级控制（激活标签页、拦截网络、设备模拟）时，使用 `browser-use python`，详见 [references/cdp-python.md](references/cdp-python.md)。

## 全局选项

| 选项 | 说明 |
|------|------|
| `--headed` | 显示浏览器窗口 |
| `--profile [NAME]` | 使用真实 Chrome（不带名称默认 "Default"） |
| `--cdp-url <url>` | 通过 CDP URL 连接 |
| `--session NAME` | 指定会话名称（默认 "default"） |
| `--json` | JSON 格式输出 |
| `--mcp` | 以 MCP 服务器模式运行 |

## 使用提示

1. **操作前先运行 `state`** — 查看可用元素和索引
2. **调试用 `--headed`** — 看到浏览器在做什么
3. **会话持久化** — 浏览器在命令间保持打开
4. **命令失败时** — 先 `browser-use close`，再重试
5. **CLI 别名**: `bu`、`browser`、`browseruse` 均可用

## 故障排除

| 问题 | 解决方案 |
|------|----------|
| 浏览器无法启动 | `browser-use close` 然后 `browser-use --headed open <url>` |
| 找不到元素 | `browser-use scroll down` 然后 `browser-use state` |
| 诊断问题 | `browser-use doctor` |
