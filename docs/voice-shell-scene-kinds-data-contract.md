# VoiceShell SceneShell Kinds 数据契约

> **状态：前端已实现，后端待对齐。**
>
> 本文档供后端工具侧对齐 SceneSet 下发的 `data` 字段形状。所有字段均源自
> `gui/src/components/SceneShell/kinds/` 下各 kind 组件的实际消费代码，逐组件核对，
> 不臆造。字段名如与后端现有命名不一致，以后端统一为准，但前端期望字段名即为本文所列。

---

## 目录

1. [weather — 天气卡片](#1-weather)
2. [music / music_player — 音乐播放器](#2-music)
3. [form — 表单卡片](#3-form)
4. [timeline — 时间线 / 日历锁格](#4-timeline)
5. [kanban — 看板 / 甘特进度条](#5-kanban)
6. [metric — 指标卡片](#6-metric)
7. [chart — 图表卡片](#7-chart)
8. [document — 文档卡片](#8-document)
9. [contract — 合同卡片](#9-contract)
10. [progress — 环状进度弧](#10-progress)
11. [web-preview / web_preview — 网页预览](#11-web-preview)
12. [choice — 选项卡片](#12-choice)
13. [news — 资讯卡片](#13-news)
14. [awakening — 唤醒/环境通知](#14-awakening)
15. [selfcheck — 启动诊断](#15-selfcheck)
16. [expert_review — 专家评审](#16-expert_review)
17. [focus_thread — 焦点线程](#17-focus_thread)
18. [meeting_recording / meeting — 会议录音/纪要](#18-meeting_recording)
19. [image — 图片卡片](#19-image)
20. [task_panel — 任务面板](#20-task_panel)
21. [text / info — 文本卡片](#21-text)
22. [hotspot — 热点榜单（简卡）](#22-hotspot)
23. [doc / documentation — 文档目录简卡](#23-doc)
24. [focus_banner — 专注提醒横幅](#24-focus_banner)
25. [terminal_stream / terminal — 终端输出](#25-terminal_stream)
26. [person_card — 人物卡片（外部组件）](#26-person_card)
27. [media / media_stage — 媒体舞台（外部组件）](#27-media)

---

## 1. weather

**源码：** `gui/src/components/SceneShell/kinds/weather.tsx`
**kinds 注册名：** `weather`（注：WeatherPopup 独立组件居中渲染，不经过 SceneShell 通用通道）

### 数据接口 `WeatherData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `city` | `string` | 是 | 城市名称 | `"北京"` |
| `temp` | `string \| number` | 是 | 当前温度（组件自动去除 °/℃ 后缀后按数字渲染） | `"26°C"` 或 `26` |
| `condition` | `string` | 是 | 天气状况中文/英文（用于图标映射 + 色调映射） | `"晴"` `"多云"` `"小雨"` `"sunny"` |
| `humidity` | `string \| number` | 否 | 湿度；缺字段时隐藏 | `"65%"` 或 `65` |
| `wind` | `string` | 否 | 风速文本；缺字段时隐藏 | `"东北风 3级"` |
| `icon` | `string` | 否 | 自定义图标（预留，当前未直接消费） | `"01d"` |
| `forecast` | `Array<{day, high, low, condition}>` | 否 | 天气预报数组；<=3 条走 compact 模式，>3 走 week 模式 | 见下 |

**forecast 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `day` | `string` | 是 | 日期/星期文字（第一条显示"今天"） | `"周一"` `"08-05"` |
| `high` | `number \| string` | 是 | 最高温 | `32` |
| `low` | `number \| string` | 是 | 最低温 | `24` |
| `condition` | `string` | 是 | 天气状况（用于图标映射） | `"晴"` |

### 后端工具侧注意点

- `condition` 同时驱动 weather icon（`glyphFor()` 支持中英文）和全息色调（`tintForWeather()`），
  中英文均可，建议统一使用中文。
- 温度建议直接传数字，避免组件侧额外解析。

---

## 2. music / music_player

**源码：** `gui/src/components/SceneShell/kinds/music.tsx`
**kinds 注册名：** `music`、`music_player`

### 数据接口 `MusicPlayerData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 是 | 曲目标题 | `"晴天"` |
| `artist` | `string` | 否 | 艺人名；为空显示"未知艺人" | `"周杰伦"` |
| `album` | `string` | 否 | 专辑名；缺字段时隐藏 | `"叶惠美"` |
| `cover` | `string` | 否 | 专辑封面 URL；缺字段时显示默认占位 | `"https://..."` |
| `duration` | `number` | 否 | 总时长（秒）；缺字段显示 `--:--` | `243` |
| `progress` | `number` | 否 | 播放进度 0-100 | `45` |
| `playing` | `boolean` | 否 | 是否播放中；默认 `true`（缺字段时按播放态） | `true` |
| `volume` | `number` | 否 | 音量 0-100；优先 data.volume，其次 `window.__ttsVolume` | `70` |

### 后端工具侧注意点

- `volume` 字段优先级为 data.volume > `window.__ttsVolume` > 默认 0。
- `progress` 当前通过 SSE 实时推送（组件内部轮询 `data.progress` 更新）。
- duration 和 progress 结合计算已播放时间：`duration * progress / 100`。

---

## 3. form

**源码：** `gui/src/components/SceneShell/kinds/form.tsx`
**kinds 注册名：** `form`

### 数据接口 `FormData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `prompt` | `string` | 否 | 表单上方提示文字（支持多行，带激光烧刻动效） | `"请填写以下信息："` |
| `fields` | `FormField[]` | 是 | 表单字段列表 | 见下 |
| `submit` | `string` | 否 | 提交按钮文字；默认 `"提交"` | `"确认下单"` |
| `streaming` | `boolean` | 否 | 是否流式输出（启用激光烧刻动效 + 闪烁光标） | `true` |
| `heatLevel` | `number` | 否 | 1-5 种草程度；存在时右侧渲染光谱柱（暖橙→玫红渐变） | `3` |

**FormField 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `name` | `string` | 是 | 字段标识（提交时回传） | `"quantity"` |
| `label` | `string` | 是 | 字段标签 | `"数量"` |
| `type` | `'text' \| 'number' \| 'select' \| 'toggle'` | 是 | 字段类型 | `"select"` |
| `options` | `string[]` | 否 | type=select 时的选项列表 | `["选项A", "选项B"]` |
| `default` | `any` | 否 | 默认值 | `"选项A"` |

### 后端工具侧注意点

- 用户提交后前端通过 `pushIntent(name='submit', { fields: Record<string, any> })` 回流
  表单值到 Agent。
- `heatLevel` 仅 1-5 有效；组件内部 clamp 为 1-5 取整。

---

## 4. timeline

**源码：** `gui/src/components/SceneShell/kinds/timeline.tsx`
**kinds 注册名：** `timeline`

### 数据接口 `TimelineData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 否 | 标题 | `"项目里程碑"` |
| `events` | `TimelineEvent[]` | 是（不传降级为空数组） | 时间线事件列表（传统模式） | 见下 |
| `date` | `string` | 否 | 日期（日历锁格模式）；与 slots 同时存在时切换为日历网格渲染 | `"2026-08-05"` |
| `slots` | `TimelineSlot[]` | 否 | 时间段列表（日历锁格模式） | 见下 |
| `focusTime` | `string` | 否 | 当前焦点时间（匹配格高亮 + "当前"标记） | `"14:00"` |

**TimelineEvent 子字段（传统时间线模式）：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `timestamp` | `number` | 是 | Unix 毫秒时间戳 | `1754352000000` |
| `title` | `string` | 是 | 事件标题 | `"需求评审"` |
| `description` | `string` | 否 | 事件描述 | `"评审 v2.3 需求文档"` |
| `icon` | `string` | 否 | 事件图标（Emoji） | `"📋"` |
| `color` | `string` | 否 | 圆点颜色；默认 `#6366f1` | `"#22c55e"` |

**TimelineSlot 子字段（日历锁格模式）：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `time` | `string` | 是 | 时间段标签 | `"09:00-10:00"` |
| `title` | `string` | 是 | 时间段标题 | `"晨会"` |
| `locked` | `boolean` | 否 | 是否锁定（蓝色光圈呼吸动画 + 锁图标） | `true` |

### 后端工具侧注意点

- 两种模式互斥：`date` + `slots` 都存在且有数据时走日历锁格模式（场景九日程 kinds），
  否则走传统时间线模式。
- `focusTime` 与 `slot.time` 精确字符串匹配才高亮。

---

## 5. kanban

**源码：** `gui/src/components/SceneShell/kinds/kanban.tsx`
**kinds 注册名：** `kanban`

### 数据接口 `KanbanData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 否 | 看板标题 | `"Sprint 12"` |
| `columns` | `KanbanColumn[]` | 是（不传降级为空数组） | 看板列 | 见下 |
| `tasks` | `GanttTask[]` | 否 | 甘特进度条模式——任务列表；存在时在看板下方额外渲染甘特条 | 见下 |

**KanbanColumn 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `id` | `string` | 是 | 列标识 | `"todo"` |
| `title` | `string` | 是 | 列标题 | `"待办"` |
| `cards` | `KanbanCard[]` | 是 | 卡片列表（最多显示 6 张） | 见下 |

**KanbanCard 子子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `id` | `string` | 是 | 卡片标识 | `"task-1"` |
| `title` | `string` | 是 | 卡片标题 | `"实现登录页"` |
| `tags` | `string[]` | 否 | 标签列表（最多显示 3 个） | `["前端", "P0"]` |
| `dueAt` | `number` | 否 | 截止日期（Unix 毫秒时间戳） | `1754352000000` |
| `color` | `string` | 否 | 左侧色条颜色 | `"#ef4444"` |

**GanttTask 子字段（甘特进度条）：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `name` | `string` | 是 | 任务名称 | `"数据库迁移"` |
| `progress` | `number` | 是 | 进度 0-100；NaN/Infinity clamp 为 0 | `72` |
| `risk` | `boolean` | 否 | 风险标记；true 时红色 ⚠️ 脉冲 + 进度条红橙渐变 | `false` |

### 后端工具侧注意点

- `tasks` 是看板的扩展模式（甘特进度条），在看板列下方额外渲染，不影响原有看板渲染。
- `progress` 必须在 0-100 之间；组件内部有 clamp 兜底，但后端应保证数据有效。
- 每列最多渲染 6 张卡片，超出显示 `+N 项`。

---

## 6. metric

**源码：** `gui/src/components/SceneShell/kinds/metric.tsx`
**kinds 注册名：** `metric`

### 数据接口 `MetricData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `value` | `string \| number` | 是（单 KPI 模式） | 指标值 | `"98.6%"` |
| `label` | `string` | 是 | 指标标签 | `"准确率"` |
| `unit` | `string` | 否 | 单位（大写渲染） | `"ACCURACY"` |
| `trend` | `'up' \| 'down' \| 'stable'` | 否 | 趋势 | `"up"` |
| `subtitle` | `string` | 否 | 副标题 | `"较昨日 +2.3%"` |
| `items` | `MetricData[]` | 否 | 多 KPI 模式；存在且非空时优先使用 | 见上各字段 |

### 后端工具侧注意点

- 两种模式：单 KPI（直接使用顶层字段）和多 KPI（`items` 数组优先）。
- 多 KPI 模式下各 item 之间自动添加分隔线。
- 段脉冲高亮依赖 `window.__ttsSegmentPulse` 信号（TTS 段切换时），非后端数据字段。

---

## 7. chart

**源码：** `gui/src/components/SceneShell/kinds/chart.tsx`
**kinds 注册名：** `chart`

### 数据接口 `ChartData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 否 | 图表标题 | `"月度销售趋势"` |
| `type` | `'line' \| 'bar' \| 'pie'` | 是 | 图表类型 | `"bar"` |
| `labels` | `string[]` | 是 | X 轴标签（pie 时为扇区标签） | `["1月", "2月", "3月"]` |
| `datasets` | `Array<{label, data[], color?}>` | 是 | 数据集 | 见下 |

**dataset 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `label` | `string` | 是 | 数据集标签（图例显示） | `"销售额"` |
| `data` | `number[]` | 是 | 数据点；长度应与 labels 一致 | `[120, 200, 150]` |
| `color` | `string` | 否 | 自定义颜色；缺字段时使用内置调色板轮换 | `"#6366f1"` |

### 后端工具侧注意点

- pie 图仅取 `datasets[0]` 的数据，其余 datasets 忽略。
- 画布固定 280x160；标签超过 5 字符会截断加省略号。
- 内置调色板 7 色：`#6366f1, #22d3ee, #f59e0b, #ef4444, #22c55e, #a78bfa, #fb7185`。

---

## 8. document

**源码：** `gui/src/components/SceneShell/kinds/document.tsx`
**kinds 注册名：** `document`

### 数据接口 `DocumentData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 是 | 文档标题 | `"产品需求规格说明书"` |
| `pages` | `Array<{text: string}>` | 是 | 页面内容数组；每项为一页的纯文本 | 见下 |
| `pageCount` | `number` | 否 | 总页数（用于显示 "第 1 页 / 共 N 页"）；默认取 pages.length | `15` |

**page 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `text` | `string` | 是 | 单页文本内容（支持 `\n` 换行，`white-space: pre-wrap` 渲染） | `"## 第一章\n\n产品概述..."` |

### 后端工具侧注意点

- 每页使用纸页堆叠入场动画（从底部抽拉，间隔 ~300ms），最多渲染 12 页。
- 缺 `title` 或 `pages` 为空数组时渲染错误占位（"数据不完整"）。
- 纸页堆叠组件 (`PaperStack`) 同时被 contract kind 复用。

---

## 9. contract

**源码：** `gui/src/components/SceneShell/kinds/contract.tsx`
**kinds 注册名：** `contract`

### 数据接口 `ContractData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 是 | 合同标题 | `"软件技术服务合同"` |
| `parties` | `{a: string; b: string}` | 否 | 甲乙方名称；缺字段或为空时隐藏信息栏 | `{a: "甲方公司", b: "乙方公司"}` |
| `amount` | `string` | 否 | 合同金额（自由文本，不限定格式） | `"¥ 500,000.00"` |
| `clauses` | `string[]` | 是 | 条款数组；每项为一页/一条款（内部转为 PaperStack pages） | `["第一条 服务内容...", ...]` |
| `seal` | `boolean` | 否 | 是否显示签章（⚑ 红色印章动画） | `true` |

### 后端工具侧注意点

- 与 document 共享 `PaperStack` 组件，`clauses` 数组每条映射为一页。
- `parties` 的 `a`（甲方）和 `b`（乙方）独立显示，缺哪个隐藏哪个。
- `seal` 为 true 时标题栏右侧显示红色 ⚑ 印章（CSS stamp 动画）。
- 缺 `title` 或 `clauses` 为空数组时渲染错误占位。

---

## 10. progress

**源码：** `gui/src/components/SceneShell/kinds/progress.tsx`
**kinds 注册名：** `progress`

### 数据接口 `ProgressData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `percent` | `number` | 是 | 进度百分比 0-100 | `67` |
| `logs` | `string[]` | 是 | 日志行数组（逐条浮现动画，最多显示最近 8 条） | `["初始化环境...", "构建中..."]` |
| `scan` | `boolean` | 否 | 是否显示激光扫描线动画（仅高性能模式生效） | `true` |

### 后端工具侧注意点

- `percent` 驱动左侧 canvas 环状进度弧，0-100 clamp 兜底。
- `logs` 每条约 350ms 逐条浮现动画；初始状态已有日志一次性展示。
- `scan` 激光扫描线动画在低性能模式 (`getPerformanceMode() === 'low'`) 下关闭。

---

## 11. web-preview / web_preview

**源码：** `gui/src/components/SceneShell/kinds/web-preview.tsx`
**kinds 注册名：** `web-preview`、`web_preview`

### 数据接口 `WebPreviewData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `url` | `string` | 是 | 网页 URL（仅允许 http/https 协议） | `"https://example.com"` |
| `title` | `string` | 否 | 预览标题 | `"示例页面"` |
| `pour` | `boolean` | 否 | 是否显示底部海报浇筑粒子动画 | `true` |

### 后端工具侧注意点

- URL 白名单校验仅允许 `http:` / `https:` 协议；非法 URL 渲染红色 "不安全的 URL" 占位。
- iframe sandbox 为 `allow-scripts`（不含 `allow-same-origin`），安全第一。
- 加载超时 8s 兜底 + 3s 错误检测；失败显示 "预览加载失败" 占位。
- `pour` 粒子动画在低性能模式下降级为静态色条。

---

## 12. choice

**源码：** `gui/src/components/SceneShell/kinds/choice.tsx`
**kinds 注册名：** `choice`

### 数据接口 `ChoiceData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `question` | `string` | 否 | 问题标题 | `"请选择导出格式"` |
| `options` | `string[] \| Array<{label: string; value: string}>` | 是 | 选项列表；支持简单字符串数组或 label/value 对象数组 | `["PDF", "Excel", "CSV"]` 或 `[{label:"PDF",value:"pdf"}]` |
| `multiple` | `boolean` | 否 | 是否多选；影响 sendIntent name（`toggle` vs `select`） | `false` |

### 后端工具侧注意点

- 用户点击选项后通过 `sendIntent(surfaceId, name, {value})` 回流：
  - 单选：`name = 'select'`
  - 多选：`name = 'toggle'`
- options 支持两种格式：简单字符串时 label 和 value 相同；对象数组时分别取值。

---

## 13. news

**源码：** `gui/src/components/SceneShell/kinds/news.tsx`
**kinds 注册名：** `news`

### 数据接口 `NewsData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `items` | `Array<{title, heat?, url?}>` | 是 | 资讯条目列表（最多显示 6 条） | 见下 |
| `platform` | `string` | 否 | 平台名称；默认 `"综合"` | `"微博"` |

**item 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 是 | 资讯标题 | `"GPT-5 正式发布"` |
| `heat` | `number \| string` | 否 | 热度值 | `"980万"` |
| `url` | `string` | 否 | 详情链接（同时作为 React key 一部分） | `"https://..."` |

### 后端工具侧注意点

- 前三条使用金银铜排名色（#ffd700 / #c0c0c0 / #cd7f32）。
- items 为空时组件返回 null（不渲染）。

---

## 14. awakening

**源码：** `gui/src/components/SceneShell/kinds/awakening.tsx`
**kinds 注册名：** `awakening`

### 数据接口 `AwakeningData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `text` | `string` | 是 | 通知文本 | `"系统已就绪，随时为您服务"` |
| `type` | `'info' \| 'success' \| 'warning' \| 'error'` | 否 | 通知类型（决定圆点颜色）；默认 `"info"` | `"success"` |
| `dots` | `number` | 否 | 圆点数量；默认 3 | `5` |

### 后端工具侧注意点

- type 颜色映射：info=蓝、success=绿、warning=黄、error=红。

---

## 15. selfcheck

**源码：** `gui/src/components/SceneShell/kinds/selfcheck.tsx`
**kinds 注册名：** `selfcheck`

### 数据接口 `SelfCheckData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 否 | 诊断标题 | `"系统启动自检"` |
| `items` | `Array<{label, status}>` | 是 | 检测项列表 | 见下 |

**item 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `label` | `string` | 是 | 检测项名称 | `"数据库连接"` |
| `status` | `'checking' \| 'ok' \| 'warn' \| 'error'` | 是 | 状态 | `"ok"` |

### 后端工具侧注意点

- status 图标映射：checking=⋯（灰色）、ok=✓（绿色）、warn=⚠（黄色）、error=✗（红色）。

---

## 16. expert_review

**源码：** `gui/src/components/SceneShell/kinds/expert-review.tsx`
**kinds 注册名：** `expert_review`

### 数据接口 `ExpertReviewData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `agents` | `Array<{name, status, duration?}>` | 是 | 评审专家列表 | 见下 |
| `conclusion` | `string` | 是 | 评审结论（空字符串显示 "全部专家已就位，结论生成中…"） | `"建议通过，需补充性能测试"` |
| `ts` | `number` | 是 | 时间戳（预留字段） | `1754352000000` |

**agent 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `name` | `string` | 是 | 专家标识（用于 `resolvePersona` 映射中文名） | `"architect"` |
| `status` | `string` | 是 | 状态（done 时显示耗时） | `"done"` |
| `duration` | `number` | 否 | 耗时（毫秒）；status=done 时转为秒显示 | `3200` |

### 后端工具侧注意点

- `agents[].name` 经 `resolvePersona()` 映射为中文标签（如 architect→"系统架构师"）。
- 支持 `onAsk` 回调触发语音追问（`"语音追问推理链"` 按钮）。

---

## 17. focus_thread

**源码：** `gui/src/components/SceneShell/kinds/focus-thread.tsx`
**kinds 注册名：** `focus_thread`

### 数据接口 `FocusThreadData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 否 | 焦点线程集合标题 | `"当前焦点"` |
| `threads` | `FocusThread[]` | 是（不传降级为空数组） | 线程列表（最多显示 6 条） | 见下 |

**FocusThread 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `id` | `string` | 是 | 线程标识 | `"thread-1"` |
| `title` | `string` | 是 | 线程标题 | `"实现用户认证模块"` |
| `status` | `'pending' \| 'active' \| 'done' \| 'blocked' \| 'snoozed'` | 是 | 线程状态 | `"active"` |
| `progress` | `number` | 否 | 进度百分比；仅 >0 时显示进度条 | `65` |
| `dueAt` | `number \| null` | 否 | 截止时间（Unix 毫秒时间戳）；预留字段 | `1754352000000` |
| `items` | `FocusThreadItem[]` | 否 | 子任务列表（最多显示 4 项） | 见下 |

**FocusThreadItem 子子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `label` | `string` | 是 | 子任务描述 | `"编写单元测试"` |
| `done` | `boolean` | 是 | 是否完成（完成项加删除线 + 绿色勾） | `true` |

### 后端工具侧注意点

- status 映射：active=目标图标（绿）、pending=空心圆（灰）、done=勾（紫）、blocked=警告三角（黄）、snoozed=时钟（灰）。
- 每个线程左侧 2px 色条颜色由 status 决定。

---

## 18. meeting_recording / meeting

**源码：** `gui/src/components/SceneShell/kinds/meeting.tsx`
**kinds 注册名：** `meeting_recording`、`meeting`

### 数据接口 `MeetingRecordingData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `title` | `string` | 是 | 会议标题 | `"周会 2026-08-05"` |
| `status` | `'recording' \| 'transcribing' \| 'summarizing' \| 'done'` | 是 | 会议处理状态 | `"done"` |
| `duration` | `number` | 否 | 录音时长（秒） | `1834` |
| `speakerCount` | `number` | 否 | 发言人数 | `5` |
| `speakers` | `MeetingSpeaker[]` | 否 | 发言转写列表（预留，当前未直接展开渲染） | 见下 |
| `summary` | `string` | 否 | 会议摘要（done + expanded 时展示） | `"本次会议讨论了..."` |
| `keywords` | `string[]` | 否 | 关键词标签列表（done + expanded 时展示） | `["Q3规划", "预算"]` |

**MeetingSpeaker 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `name` | `string` | 是 | 发言人姓名 | `"张三"` |
| `time` | `string` | 否 | 发言时间戳 | `"00:02:35"` |
| `text` | `string` | 是 | 发言内容 | `"关于Q3的预算..."` |

### 后端工具侧注意点

- 状态驱动左侧 3px 色条颜色：recording=红、transcribing=黄、summarizing=紫、done=绿。
- done 状态可点击展开查看 summary + keywords；其他状态不可点击。
- recording/transcribing/summarizing 状态时麦克风图标带红色脉冲圆点。

---

## 19. image

**源码：** `gui/src/components/SceneShell/kinds/image.tsx`
**kinds 注册名：** `image`

### 数据接口 `ImageData`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `src` | `string` | 是 | 图片 URL | `"https://example.com/image.png"` |
| `alt` | `string` | 否 | 替代文本 | `"架构图"` |
| `caption` | `string` | 否 | 图片说明文字（底部显示） | `"图 1：系统架构"` |
| `aspectRatio` | `number` | 否 | 宽高比；默认 16/9 | `4/3` |

### 后端工具侧注意点

- 加载前显示"加载中..."占位；加载完成后渐入（opacity transition 0.6s）。

---

## 20. task_panel

**源码：** `gui/src/components/SceneShell/kinds/task-panel.tsx` + `gui/src/lib/task-panel-store.ts`
**kinds 注册名：** `task_panel`（注：统一由 TaskPanelHost 浮层渲染，通道 B）

### 数据接口 `TaskPanel`

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `id` | `string` | 是 | 面板唯一标识 | `"round-abc123"` |
| `title` | `string` | 是 | 任务标题 | `"生成月度报告"` |
| `status` | `'running' \| 'success' \| 'error' \| 'cancelled'` | 是 | 任务状态 | `"running"` |
| `progress` | `number` | 是 | 进度 0-100（clamp 兜底） | `45` |
| `currentAction` | `string` | 是 | 当前动作描述 | `"正在查询数据库..."` |
| `toolHistory` | `ToolEvent[]` | 是 | 工具调用历史（可展开） | 见下 |
| `result` | `{fileName?, path?}` | 否 | 输出结果（文件路径等） | `{fileName: "report.pdf"}` |
| `createdAt` | `number` | 是 | 创建时间（Unix 毫秒） | `1754352000000` |
| `updatedAt` | `number` | 是 | 更新时间（Unix 毫秒） | `1754352010000` |
| `steps` | `Array<{name: string; status: 'pending' \| 'running' \| 'done' \| 'error'}>` | 否 | 工作流阶段步骤；存在时渲染步骤列表 | 见下 |

**ToolEvent 子字段：**

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `toolName` | `string` | 是 | 工具名称（技能工具自动紫色标识） | `"execute_skill"` |
| `summary` | `string` | 是 | 调用摘要 | `"执行技能: doc-generator"` |
| `status` | `'running' \| 'success' \| 'error'` | 是 | 执行状态 | `"success"` |
| `ts` | `number` | 是 | 时间戳 | `1754352005000` |

### 后端工具侧注意点

- 该面板数据由前端 `TaskPanelStore` 聚合 SSE 事件流生成，后端 SSE 事件类型见
  `task-panel-store.ts` 的 `PanelEvent` 类型定义。
- 技能工具 (`skill_manage`/`SkillsList`/`SkillView`/`execute_skill`/`executeSkill`)
  自动显示为紫色 📦 技能卡片。
- 支持两种渲染模式：标准模式（完整卡片）和 compact 模式（单行进度条）。
- running 状态显示取消按钮。

---

## 21. text / info

**源码：** `gui/src/components/SceneShell/kinds/index.tsx` 内联 `TextRenderer`
**kinds 注册名：** `text`、`info`

### 数据接口

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `text` | `string` | 否 | 文本内容（优先） | `"操作已完成"` |
| `content` | `string` | 否 | 文本内容（备选，text 不存在时取） | `"操作已完成"` |

### 后端工具侧注意点

- 最简单的渲染器：纯文本展示，优先取 `text`，其次 `content`。
- 无特殊样式或交互。

---

## 22. hotspot

**源码：** `gui/src/components/SceneShell/kinds/index.tsx` 内联 `HotspotRenderer`
**kinds 注册名：** `hotspot`

### 数据接口

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `items` | `any[]` | 否 | 热点条目（优先）；每项取 `title` 或 `text` | `[{title: "热搜1", heat: "100万"}]` |
| `platforms` | `Array<{items?: any[]}>` | 否 | 多平台模式；取第一个平台的 items | `[{items: [...]}]` |
| `platform` | `string` | 否 | 平台名称；默认 `"综合"` | `"微博"` |

### 后端工具侧注意点

- 数据优先级：`items` > `platforms[0].items`。
- 最多显示 5 条；金银铜排名色用于前三。
- 底部提示 "点击侧栏「热点」查看完整榜单"。

---

## 23. doc / documentation

**源码：** `gui/src/components/SceneShell/kinds/index.tsx` 内联 `DocRenderer`
**kinds 注册名：** `doc`、`documentation`

### 数据接口

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `topicId` | `string` | 否 | 主题标识（优先作为标题） | `"getting-started"` |
| `topic` | `string` | 否 | 主题名称（topicId 不存在时使用） | `"快速入门"` |
| `sections` | `Array<{title?: string} \| string>` | 否 | 章节列表；每项取 title 或直接取字符串 | `[{title: "安装"}]` |

### 后端工具侧注意点

- 最多显示 3 个章节；底部提示 "点击侧栏「文档」查看完整说明"。
- 这是精简版文档目录卡片，非完整 document kind。

---

## 24. focus_banner

**源码：** `gui/src/components/SceneShell/kinds/index.tsx` 内联 `FocusBannerRenderer`
**kinds 注册名：** `focus_banner`

### 数据接口

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `task` | `string` | 否 | 任务描述（优先） | `"请在 14:00 前完成代码评审"` |
| `text` | `string` | 否 | 文本内容（task 不存在时使用） | `"请在 14:00 前完成代码评审"` |
| `status` | `string` | 否 | 状态类型；决定左侧色条颜色；默认 `"info"` | `"warn"` |
| `detail` | `string` | 否 | 补充说明 | `"优先级 P0"` |

### 后端工具侧注意点

- status 颜色映射：info=蓝、warn=橙、error=红、success=绿。
- 左侧 3px 色条 + 半透明边框。

---

## 25. terminal_stream / terminal

**源码：** `gui/src/components/SceneShell/kinds/index.tsx` 内联 `TerminalRenderer`
**kinds 注册名：** `terminal_stream`、`terminal`

### 数据接口

| 字段 | 类型 | 必选 | 说明 | 示例 |
|------|------|------|------|------|
| `lines` | `string[]` | 否 | 终端输出行（优先）；最多显示最后 5 行 | `["> build success", "! warning: ..."]` |
| `logs` | `string[]` | 否 | 终端输出行（lines 不存在时使用） | `["> build success"]` |

### 后端工具侧注意点

- `!` 开头的行显示为红色（错误），`>` 开头的行显示为绿色。
- 黑底等宽字体渲染，模拟终端。
- 最大高度 120px。

---

## 26. person_card

**源码：** 外部组件 `gui/src/components/PersonCard`
**kinds 注册名：** `person_card`

### 数据接口

人物卡片数据由 `PersonCard` 组件定义，非 SceneShell kinds 内部实现。
后端对齐时请参考 `gui/src/components/PersonCard` 组件的 props 定义。

---

## 27. media / media_stage

**源码：** 外部组件 `gui/src/components/MediaStage`
**kinds 注册名：** `media`、`media_stage`

### 数据接口

媒体舞台数据由 `MediaStage` 组件定义，非 SceneShell kinds 内部实现。
后端对齐时请参考 `gui/src/components/MediaStage` 组件的 props 定义。

---

## 附录：Kinds 注册名速查表

| 注册名 | 组件 | 包装模式 |
|--------|------|----------|
| `weather` | WeatherPopup（独立组件，不经过 SceneShell） | card |
| `music` / `music_player` | MusicPlayerCard | card |
| `form` | FormCard | none |
| `timeline` | TimelineCard | card |
| `kanban` | KanbanRendererCard | card |
| `metric` | MetricCard | card |
| `chart` | ChartCard | card |
| `document` | DocumentCard | card |
| `contract` | ContractCard | card |
| `progress` | ProgressCard | card |
| `web-preview` / `web_preview` | WebPreviewCard | card |
| `choice` | ChoiceCard | none |
| `news` | NewsCard | card |
| `awakening` | AwakeningCard | card |
| `selfcheck` | SelfCheckCard | card |
| `expert_review` | ExpertReviewCard | none |
| `focus_thread` | FocusThreadCard | card |
| `meeting_recording` / `meeting` | MeetingRecordingCard | card |
| `image` | ImageCard | card |
| `task_panel` | TaskPanelCard（通道 B，TaskPanelHost） | card |
| `text` / `info` | TextRenderer（内联） | none |
| `hotspot` | HotspotRenderer（内联） | card |
| `doc` / `documentation` | DocRenderer（内联） | card |
| `focus_banner` | FocusBannerRenderer（内联） | card |
| `terminal_stream` / `terminal` | TerminalRenderer（内联） | card |
| `person_card` | PersonCard（外部组件） | card |
| `media` / `media_stage` | MediaStage（外部组件） | card |

---

> **文档版本：** 1.0
> **生成日期：** 2026-08-05
> **核对人：** CrabPaw Agent (P7.5 Task 5)
> **核对方式：** 逐组件读取源码（21 个 kind 文件 + 1 个索引文件 + 1 个 store 文件），
>   提取 TypeScript 接口定义与组件内 `data.xxx` 实际消费字段，不臆造。
