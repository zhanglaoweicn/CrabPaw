# CrabPaw — AI Agent Platform

> 多通道 AI 助理平台 | v2.2.0

CrabPaw 是面向中小企业的智能助理平台，支持多模型、多渠道、语音交互、技能扩展和工作流自动化。本项目遵循 Harness 8 维度 AI Agent 治理框架。

## 获取与安装

### 方式 A：下载安装包（普通用户，推荐）

到 [Releases](../../releases) 页面下载最新的便携版 zip，解压后运行 `CrabPaw.exe` 即可：

- 无需安装 Node.js 或任何开发环境（运行时已内置）
- 首次启动会联网自动补下载浏览器内核组件（约数百 MB，仅一次）
- 数据目录在程序目录旁的 `CrabPaw-Data/`，删除即卸载，不写注册表
- 启动后在设置页填入模型 API Key 即可开始对话

### 方式 B：从源码运行（开发者）

**环境要求**：Node.js ≥ 18（建议 24 LTS，与打包环境一致可避免 native 模块预编译问题）、npm ≥ 9；Windows 10+ / macOS 12+ / Ubuntu 20.04+。

```bash
git clone <repo-url> && cd crabpaw

# 国内网络建议先加速 Electron 二进制下载（Windows PowerShell 用 $env: 替代 export）
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

npm install                # 后端依赖（含 postinstall 自检）
cp .env.example .env       # 填入 API Key，见下方「模型配置」

# 一键启动（后端 + 桌面端）
node scripts/dev-all.js

# 或分两个终端启动：
npm run dev                # 终端 1：后端开发服务（127.0.0.1:38767）
cd gui && npm install && npm run dev:desktop   # 终端 2：Electron 桌面端
```

> 注意：gui 下的 `npm run dev` 只启动浏览器版 Vite 调试页（无 Electron 壳、无语音），
> 请使用 `npm run dev:desktop` 启动完整桌面端。

### 模型配置

编辑 `.env`（复制自 `.env.example`）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 二选一 | DeepSeek（推荐，便宜好用） |
| `QWEN_API_KEY` | 二选一 | 通义千问（备选） |
| `LARK_APP_ID` / `LARK_APP_SECRET` | 可选 | 飞书集成，不填则禁用 |
| `WECOM_CORP_ID` / `WECOM_AGENT_SECRET` | 可选 | 企业微信集成，不填则禁用 |
| `PORT` | 可选 | API 端口，默认 38767 |

没有的 Key 留空即可，只会禁用对应功能，不影响核心对话。也可以启动后在桌面端
**设置 → 模型配置** 页面直接填写并保存，无需手改 `.env`。

### 常见问题

| 现象 | 处理 |
|---|---|
| Electron 下载慢或失败 | 设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后重装 |
| `better-sqlite3`/`sharp` 安装报错 | 对齐 Node 版本（建议 24 LTS）后删除 `node_modules` 重装 |
| 端口 38767 被占用 | 结束旧的后端进程，或设 `PORT` 换端口 |
| 语音无声/唤醒不可用 | 检查系统麦克风权限；gui 安装时会自动执行 sherpa-onnx 的 Electron 重建 |
| 桌面端连不上后端 | 先确认后端已启动（`npm run dev`），桌面端会自动探测 38767 |

## 核心功能

- **AI 对话** — DeepSeek / 豆包 / Moonshot / Zhipu 等多模型支持
- **语音交互** — TTS 语音合成、ASR 识别、连续对话、唤醒词（sherpa-onnx 本地 KWS）
- **多通道** — 微信桌面监听、飞书、企业微信
- **技能系统** — 69 个内置技能（skills/ 目录实测，2026-09-09；另有 data/skills/ 21 个用户技能目录），Markdown 定义，即插即用
- **工作流引擎** — 多阶段任务编排与审批
- **记忆系统** — 短期/长期记忆，实体解析，衰减引擎
- **桌面应用** — Electron + React 跨平台 GUI，卡片式场景呈现
- **Harness 治理** — 8 维度 AI Agent 治理框架（预算、契约、安全、审计）

## 项目结构

| 目录 | 说明 |
|---|---|
| `src/` | 后端核心（CLI、AI、工具、记忆、工作流） |
| `gui/` | Electron + React 桌面前端 |
| `plugins/` | 可安装插件 (14 个) |
| `skills/` | 内置技能库 (69 个，2026-09-09 实测) |
| `evals/` | 评估测试框架 (52 套，以 `npm run eval` 实际输出为准) |
| `docs/` | 设计文档 |

## 常用命令

```bash
npm start            # 生产启动
npm run dev          # 开发模式
npm test             # 运行测试
npm run eval         # 运行评估
npm run lint         # 代码检查
npm run typecheck    # TypeScript 检查
npm run build:gui    # 构建 GUI
npm run download:deps # 首次打包前预置便携运行时(node/python/ffmpeg)
npm run build:release # 打包桌面应用（依赖 download:deps 先行）
npm run build:portable # 构建便携版 zip
```

## 网络监听与 Webhook

自 v2.2 起，主 API 默认只绑定 `127.0.0.1`（单机桌面形态的安全默认值）。若你使用企微/飞书
Webhook 回调（需要局域网或公网可达），启动前设置环境变量：

```bash
CRABPAW_HOST=0.0.0.0   # 恢复全网卡监听（Webhook 部署形态）
```

## 二次开发与贡献

1. **文档**：开发手册见 [DEVELOPMENT_MANUAL.md](./DEVELOPMENT_MANUAL.md)，治理框架见 [HARNESS.md](./HARNESS.md)
2. **贡献**：见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 语音配置

TTS 引擎支持：豆包 (10 种声音) / 火山引擎 (8 种) / Edge TTS (3 种，离线)

## License

[MIT](./LICENSE)。本项目捆绑/引用的第三方组件及其许可见 [NOTICE.md](./NOTICE.md)。
