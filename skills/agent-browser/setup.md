# Agent Browser 安装指南

## 概述

Agent Browser 是基于 Accessibility Tree 的无头浏览器自动化工具，专为 AI Agent 设计。

## 安装步骤

### 1. 安装 Node.js（如未安装）

- 下载地址：https://nodejs.org/
- 推荐版本：>= 18.0.0

### 2. 安装 agent-browser

```bash
npm install -g agent-browser
```

### 3. 下载 Chromium

```bash
agent-browser install
```

> **Linux 用户**需要安装系统依赖：
> ```bash
> agent-browser install --with-deps
> ```

### 4. 验证安装

```bash
agent-browser --version
```

## 常见问题

| 问题 | 解决方案 |
|------|----------|
| `command not found: agent-browser` | 检查 npm 全局路径是否在 PATH 中 |
| Chromium 下载失败 | 检查网络连接，或使用代理 |
| Linux 启动失败 | 运行 `agent-browser install --with-deps` 安装系统库 |

## 技能状态

- **未安装**：此技能将不可用
- **已安装**：技能自动激活，可在对话中调用
