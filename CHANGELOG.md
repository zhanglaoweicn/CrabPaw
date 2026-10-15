# CHANGELOG

## 2.2.1 → 2.2.5 (2026-09-22 → 2026-09-26) — 发行版

> 中间版本 2.2.1~2.2.4 为连续热修发版（企微修复推送 / 发版链路自纠），此处按主题合并归档：

### 企微通道稳定性
- 桥接器"互相顶号"崩溃循环根治（静默失效根因 + 补被吞掉的子进程输出）
- 同步改单向 + 会话身份分离：电脑端与企微的记忆/上下文各自独立，对答通道对称
- access_token 凭证类错误给可操作指引；桥内不做进程清扫，避免双桥级联互杀

### 语音体系
- 实时通道"半开假活"自愈（下行活性看门狗）+ 判活重构（委托在途不误杀/尾窗保整句/续播去重/心跳探测）
- 专注模式与实时通道不兼容修复（pttOnly 运行时回退 classic 管线）
- 语音球动感增强、面板"说关了没关"收口、空格 PTT 死按兜底

### 圆桌会与老板体验
- 圆桌会全链路：多专家群聊式讨论、豆包十音色稳定绑定、纪要生成依赖反转、企微桥自回声抑制 + 中止能力
- 零输入信息层三件套：晨报带 / 结构化决策卡 / 今日产出轴
- UTC 日界根治：用量/简报日键全链路改本地时区（北京时间 0-8 点记账不再落昨天）
- 上下文历史携带按模型窗口动态化（128K 模型 20→64 条，小窗口 clamp 防溢出）
- LoopX 主动发声 kernel（gate/quota/dedup/intent/speak 五连判定）+ 长任务证据账本

### GUI / 桌面端
- 会客厅/一体机模式 S1–S5、应用内网页浏览面板（WebContentsView）、应用内一键更新（GitHub Releases）
- voice-shell 巨型组件五批拆分（index.tsx 3170→1919 行，-40%）
- three.js 移出首屏，首屏 JS -571.8KB（-31.0%）

### 数据与工具
- 命名数据源 DatabaseConfig：连接持久化 + 加密落盘 + 对话式配置
- 数据出处链：来源→视图→指标可核验 + API + 前端面板
- 会话收口闭环 + L0/L1/L2 分层加载协议 + OpenViking MCP 预置
- 对话式 MCP 连接器向导 M1（金蝶专线）
- 工具提示单源 tool-hints + 插件门禁收紧（缺 manifest 不再静默通过）
- 生图链路八连修：handraw-style 风格库、Agnes Image Provider、意图路由、local:// 协议统一、file_generated 图片气泡渲染、DeepSeek reasoning_content 回传

### 安全与发行
- 公开 Release 密钥泄漏修复：三层防护 + 已上架资产剥离 19987 条违禁条目（442MB）
- 标准发版编排 release.ps1 六步一条命令；快照仓同步改 blob 哈希精确比对（根治中文名乱码）
- 营销物料不进公开仓（随 U 盘/售后渠道分发）；密钥备份变体忽略规则补齐

### 质量基线
- eval 套件 58→59、用例 456→462（boss-experience 体验型断言固化）
- jest 全量 182 套件 2225 用例通过

## 2.2.0 后续迭代摘要（2026-08-20 → 2026-09-09，未发版）

> 2.2.0 发行后的主干迭代概览，详单见 git 提交历史：

- **业务卡与语义层** — 业务数据地基修复（ISO 日期、列别名）、语义视图、应收/合同/简报等 7 张业务卡
- **安全加固** — 浏览器控制轮（契约单源、raw CDP 闸、审计脱敏）与电脑控制轮（高危操作审批闸、press_key 双层根修）
- **专家×数据** — 数据路由修复、专家路由固定分档、例会三态、TaskOrbit 去重
- **视频能力** — Remotion 与 HyperFrames 双引擎接入及实测修复（素材入库 + 字幕/覆层工作流）
- **图像能力** — Seedream 图片生成（引擎层尺寸对齐 + 下载超时）、海报生成（Brand Kit + 双层渲染）
- **便携发行** — U 盘便携版管线（secret-store v2、端口强杀、CRABPAW_HOME、npm/pip/ffmpeg 预置、洁净度门禁）
- **模型配置** — 打包版改模型不生效修复（routing 同步 / 掩码 key 丢弃 / defaultModel 联动）
- **开源发布** — 脱敏清理、第三方声明（NOTICE.md）、发布流水线对齐 CI

## 2.2.0 (2026-08-19) — 发行版

### AG-UI 协议化（Phase 1）
- SSE 流 seq 编号 + 500 条环形重放（重连不丢帧）+ Last-Event-ID 续传
- turn/step 生命周期：useTurnState hook + 步骤 chip 进入 AgentRightPanel
- connected 带 seq 对账（重启黑障修复）、closedRuns 修剪/Set/不变量断言

### 面板与卡片体系
- 台风面板（默认沿海地图/历史台风入口/路径段着色/自适应范围）、热点面板（真实 Top12 绑定地球/轮询防重入）、股票行情面板、音乐唱片机、天气氛围层、视频卡片布局重做
- 文件生成面板（编码过程可视化/组合布局/关闭按钮/PDF 双 bug 修复）
- 会议卡片（后端持久化 + MeetingPanel 宿主卡 + 语音转写链路全通）、日程卡片（SchedulePanel + kind 'schedule'）
- 业务面板退役：6 tab 全清（日程/股票/文件归卡片，专家/数据库/经营数据→管理舱 data tab），删除「业务」按钮

### 语音体系
- ASR WebSocket 常开保活、看门狗惰性重建、思考态修正、停止真停
- 全面板语音开关、TTS 真流式、Electron duck 修复

### 深度复盘与清理轮（2026-08-18）
- P0 修复轮：4 个纸面命令复活、双嵌套修正、协调器降级、双管理器决策不合并
- 微信通道全删（wechat-desktop-monitor/wechat-monitor-tools 等 15 个 src 文件）+ 2.4G 仓库回收
- 卸载 7 个零使用 Radix 依赖；mcp sandboxExecuteHandler 导出修复；gui CSS 修复（.subagent-card.error 缺括号/200%%）
- 测试基线：jest 1338 用例 / eval 424 项（P0-P3 全绿）

### 发行审计轮（2026-08-19）
- 意图路由补全：calendar/reminder/stock/network/scene 工具集接入意图映射
- 安全加固：废弃 build-portable.ps1 移除（曾打包开发机密钥）、lark-adapter 命令转义补全、docx 解压 zip-slip 防护、CRABPAW_HOST 监听收紧选项
- 打包修正：download:deps fail-fast、首启数据拷贝排除 cloakbrowser、better-sqlite3 按打包 node v20 ABI 重建

---
## 2.3.0 (2026-08-07) — 商用化冲刺（开发中，未发行）

### 语音链路全部接线（5 修复）
- voice_play 消费端修复：TTS 生成后正确推送到前端播放队列
- voice-evolution 接线：voice-evolution-handler 接入 init.js，TTS 进化数据闭环
- 语音审批：ASR 转录文本经人工审批确认后发送，防止误识别
- DocReader + MediaStage 语音集成：文档阅读和媒体播放时语音协调（suspendForMedia/resumeAfterMedia）
- TTS 排序优化：多 TTS provider 按质量/延迟排序选择

### B站直链解析
- 新增 bilibili-playurl 工具：解析 B站视频/音频直链，支持多清晰度降级
- playurl API 降级链：完整清晰度 → 备用清晰度 → 错误提示

### 专家协作编排
- 后端 collab API：src/core/experts/collaboration.js — 多专家协作任务分配与结果聚合
- SSE 实时推送：协作进度通过 SSE 实时推送到前端
- 前端 CollabWizard：gui/src/components/ExpertsPanel/CollabWizard.tsx — 协作任务向导
- 前端 CollabOrbit：gui/src/components/CollabOrbit/index.tsx — 专家协作轨道可视化
- eval 覆盖：evals/test-cases/expert-collaboration.js（9 用例）

### 8 个技能 Executor 补全
- 统一执行引擎：src/core/skill-executor.js
- 能力注册表：src/taskflow/skill-capability-registry.js
- 覆盖：PDF/Word/PPT/HTML 文档生成、Diagram/Chart 图表、图片编辑、B站直链解析

### 前端便捷性提升
- Cmd+K 命令面板：gui/src/components/CommandPalette/index.tsx — 全局快捷命令
- 会话历史 API：src/cli/commands/history.js — 会话历史查询与管理
- 上传进度：文件上传实时进度指示
- 审批音效：审批操作 Web Audio 反馈音效
- 音频设备管理：gui/src/components/AudioOutputManager.tsx — 输出设备选择（setSinkId）
- Gateway 启停：服务网关启动/停止控制

### Eval 增强
- 用例从 194 增至 231（+37 用例）
- 新增套件：expert-collaboration、regression、dry-run-inspector

### 债务清理
- 删除死代码/stub 文件
- 统一 async 模式（execSync → async API）
- 空 catch 全部补齐日志


## 2.2.0 (2026-07-28)

### 第四次修复迭代 — 架构重构
- R1: TTS 真流式 (MSE MediaSource) — 后端逐 chunk 推送，前端 MediaSource.appendBuffer 边收边播，TTFF 从 3-15s 降至 <1s
- R2: 双 WS 连接统一 — SceneShell 移除独立 WS，改用 useSceneSurfaces() hook
- 面板触发统一 — ShowWeather 视觉推送、天气预投影、音乐/热点 Scene surface 单路径
- 语音残留修复 — 12 空 catch、async readFileSync、最大重连限制、段排序

### 第五次修复迭代 — 技术债务清理
- 打断检测改进 — ZCR 零交叉率多特征分类区分语音/噪声，Electron duck 修复 (waveOutSetVolume P/Invoke)
- SceneShell kind 注册表 — 24 kind 的 KIND_REGISTRY 替代 250 行 inline switch
- 语音-媒体协调 — suspendForMedia/resumeAfterMedia 闭环
- 后端清理 — Local TTS 首次可用、normalizeTTSError、PCM 缓冲+WS 重连、Capability 注入 LLM context
- Settings 拆分 — 2074→1298 行，7 内联 section 独立组件
- Automation 清理 — 1646→812 行，删除废弃死文件
- VoiceStateContext — stateRef hack → useReducer

### 发布准备 (2026-07-28)
- 依赖漏洞修复 — tar(严重) + axios/js-yaml/brace-expansion(高危) 修复
- 版本统一 — GUI 1.0.0 → 2.2.0
- 端口配置 — workflow-handler 3000 硬编码修复
- 代码清理 — request-handler.js 38 处 var→const/let, execSync 审计加固
- CI — 新增 release workflow
