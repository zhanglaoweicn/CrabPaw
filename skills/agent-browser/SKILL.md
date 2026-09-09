---
name: agent-browser
version: "0.1.0"
description: "无头浏览器自动化，基于 Accessibility Tree 和 Ref 引用实现确定性元素选择，支持多会话隔离、状态持久化、网络拦截。当需要后台静默打开网页、点击元素、填表、抓取内容或截图（不弹可见窗口）时使用。"
metadata:
  crabpaw:
    emoji: 🌐
    category: automation
    capabilities: [browser_automation]
    requires:
      bins:
        - agent-browser
      npm:
        - agent-browser
    homepage: https://github.com/vercel-labs/agent-browser
---

# Agent Browser

基于 Accessibility Tree 的无头浏览器自动化，使用 Ref 引用实现确定性元素选择。

## ⚠️ 依赖要求

```bash
# 安装 agent-browser
npm install -g agent-browser

# 下载 Chromium
agent-browser install

# Linux 需要额外系统依赖
agent-browser install --with-deps

# 验证安装
agent-browser --version
```

## 🎯 核心优势

| 特性 | 说明 |
|------|------|
| **Accessibility Tree** | 基于可访问性树，不受 CSS 变化影响 |
| **Ref 引用** | 使用 `@e1`, `@e2` 引用元素，稳定可靠 |
| **JSON 输出** | AI 友好的结构化输出 |
| **会话隔离** | 多个独立浏览器上下文 |
| **状态持久化** | 保存/加载登录状态 |

## 📖 基本工作流

```bash
# 1. 打开页面并获取快照
agent-browser open https://example.com
agent-browser snapshot -i --json

# 2. 解析 JSON 中的 refs，识别元素
# {"refs": {"e1": {"role": "textbox"}, "e2": {"role": "button"}}}

# 3. 使用 Ref 执行操作
agent-browser fill @e1 "搜索内容"
agent-browser click @e2

# 4. 等待页面稳定后重新获取快照
agent-browser wait --load networkidle
agent-browser snapshot -i --json
```

## 🔧 核心命令

### 导航

```bash
agent-browser open <url>           # 打开页面
agent-browser back                 # 后退
agent-browser forward              # 前进
agent-browser reload               # 刷新
agent-browser close                # 关闭
```

### 快照（推荐使用 -i --json）

```bash
agent-browser snapshot -i --json                    # 可交互元素 + JSON 输出
agent-browser snapshot -i -c -d 5 --json            # 紧凑模式 + 深度限制
agent-browser snapshot -s "#main" -i --json         # 限定选择器范围
```

### 交互（基于 Ref）

```bash
agent-browser click @e2             # 点击
agent-browser fill @e3 "text"       # 填充文本
agent-browser type @e3 "text"       # 逐字输入
agent-browser hover @e4             # 悬停
agent-browser check @e5             # 勾选
agent-browser uncheck @e5           # 取消勾选
agent-browser select @e6 "value"    # 下拉选择
agent-browser press "Enter"         # 按键
agent-browser scroll down 500       # 滚动
agent-browser drag @e7 @e8          # 拖拽
```

### 获取信息

```bash
agent-browser get text @e1 --json       # 获取文本
agent-browser get html @e2 --json       # 获取 HTML
agent-browser get value @e3 --json      # 获取表单值
agent-browser get attr @e4 "href" --json # 获取属性
agent-browser get title --json          # 获取标题
agent-browser get url --json            # 获取 URL
agent-browser get count ".item" --json  # 统计元素数量
```

### 状态检查

```bash
agent-browser is visible @e2 --json     # 是否可见
agent-browser is enabled @e3 --json     # 是否可用
agent-browser is checked @e4 --json     # 是否勾选
```

### 等待

```bash
agent-browser wait @e2                  # 等待元素出现
agent-browser wait 1000                 # 等待毫秒
agent-browser wait --text "Welcome"     # 等待文本出现
agent-browser wait --url "**/dashboard" # 等待 URL 匹配
agent-browser wait --load networkidle   # 等待网络空闲
agent-browser wait --fn "window.ready === true"  # 等待自定义条件
```

## 🔄 会话管理

### 多会话隔离

```bash
# 管理员会话
agent-browser --session admin open app.com
agent-browser --session admin state load admin-auth.json

# 用户会话（同时运行）
agent-browser --session user open app.com
agent-browser --session user state load user-auth.json

# 查看所有会话
agent-browser session list
```

### 环境变量方式

```bash
AGENT_BROWSER_SESSION=admin agent-browser open app.com
```

## 💾 状态持久化

```bash
# 保存登录状态（cookies + storage）
agent-browser state save auth.json

# 加载状态（跳过登录流程）
agent-browser state load auth.json
```

## 📸 截图与 PDF

```bash
agent-browser screenshot page.png           # 可视区域截图
agent-browser screenshot --full page.png    # 完整页面截图
agent-browser pdf page.pdf                  # 生成 PDF
```

## 🌐 网络控制

```bash
# 拦截请求
agent-browser network route "**/ads/*" --abort

# 模拟响应
agent-browser network route "**/api/*" --body '{"x":1}'

# 查看请求
agent-browser network requests --filter api
```

## 🍪 Cookies 与存储

```bash
# Cookies
agent-browser cookies                       # 获取所有
agent-browser cookies set name value        # 设置

# Storage
agent-browser storage local key             # 获取 localStorage
agent-browser storage local set key val     # 设置
```

## 📑 标签页与框架

```bash
agent-browser tab new https://example.com   # 新标签页
agent-browser tab 2                         # 切换标签页
agent-browser frame @e5                     # 切换 iframe
agent-browser frame main                    # 返回主框架
```

## 📋 快照输出格式

```json
{
  "success": true,
  "data": {
    "snapshot": "...",
    "refs": {
      "e1": {"role": "heading", "name": "Example Domain"},
      "e2": {"role": "button", "name": "Submit"},
      "e3": {"role": "textbox", "name": "Email"}
    }
  }
}
```

## 💡 最佳实践

### 1. 始终使用 `-i --json`

```bash
# ✅ 推荐
agent-browser snapshot -i --json

# ❌ 不推荐
agent-browser snapshot
```

### 2. 操作后等待稳定

```bash
agent-browser click @e2
agent-browser wait --load networkidle
agent-browser snapshot -i --json
```

### 3. 保存认证状态

```bash
# 首次登录后保存
agent-browser state save auth.json

# 后续直接加载
agent-browser state load auth.json
```

### 4. 使用会话隔离

```bash
# 不同用户使用不同会话
agent-browser --session user1 ...
agent-browser --session user2 ...
```

### 5. 调试时使用 --headed

```bash
# 显示浏览器窗口
agent-browser --headed open https://example.com
```

## 🎯 使用场景

### 搜索并提取

```bash
agent-browser open https://www.google.com
agent-browser snapshot -i --json
# AI 识别搜索框 @e1
agent-browser fill @e1 "AI agents"
agent-browser press Enter
agent-browser wait --load networkidle
agent-browser snapshot -i --json
# AI 识别结果 refs
agent-browser get text @e3 --json
agent-browser get attr @e4 "href" --json
```

### 多用户测试

```bash
# 管理员会话
agent-browser --session admin open app.com
agent-browser --session admin state load admin-auth.json
agent-browser --session admin snapshot -i --json

# 用户会话（同时）
agent-browser --session user open app.com
agent-browser --session user state load user-auth.json
agent-browser --session user snapshot -i --json
```

### 表单自动填充

```bash
agent-browser open https://form.example.com
agent-browser snapshot -i --json
agent-browser fill @e1 "张三"
agent-browser fill @e2 "zhang@example.com"
agent-browser select @e3 "option1"
agent-browser check @e4
agent-browser click @e5  # 提交
```

## 🔍 与内置浏览器工具对比

| 场景 | 推荐工具 |
|------|----------|
| 多步骤自动化工作流 | **agent-browser** |
| 需要确定性元素选择 | **agent-browser** |
| 性能敏感场景 | **agent-browser** |
| 复杂 SPA 应用 | **agent-browser** |
| 需要截图/PDF 分析 | 内置浏览器工具 |
| 视觉检查需求 | 内置浏览器工具 |

## ⚠️ 注意事项

1. **首次运行**：需要下载 Chromium，可能需要几分钟
2. **内存占用**：每个会话独立浏览器实例
3. **网络依赖**：首次安装需要网络
4. **调试模式**：使用 `--headed` 查看浏览器行为

---

**让浏览器自动化变得简单可靠 🌐**
