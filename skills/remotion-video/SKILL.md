---
name: remotion-video
version: "1.0.0"
description: "Remotion 代码驱动视频生成：写 React 组件精确合成动画/数据视频/模板视频并渲染 MP4。用户要'做个视频/动画短片/片头/数据视频/字幕视频/宣传片'时使用。AI 创意实拍画面请用 VideoGenerate。"
metadata:
  crabpaw:
    emoji: 🎬
    category: visualization
    capabilities: [video_generation, motion_graphics]
    requires:
      bins:
        - node
    priority: 3
    tags: [video, remotion, motion, animation, render]
---

# Remotion 视频生成

用 React 组件描述视频的每一帧，Remotion 用内置 headless 浏览器逐帧渲染出 MP4。
适合：数据视频（周报/榜单/图表动画）、片头片尾、字幕视频、产品演示、营销模板视频。
产出可复现、精确到帧、可参数化批量生成。

## 工作区项目

项目位置（固定，仓库根相对）：`data/.crabpaw/workspace/remotion/`（首次调用 RemotionRender
时自动脚手架并安装依赖，首次初始化含浏览器内核下载，约 2-5 分钟，之后秒级就绪）。

**开始前的第一步：永远先调 `RemotionStatus`（不带参数）**——它返回项目绝对路径
（project_dir）和已登记合成物清单（available_compositions）。
⚠️ 禁止用 LS/Glob 搜索项目位置：项目在隐藏目录 `.crabpaw` 下，且浪费调用预算。

```
remotion/
  src/
    index.ts              # 入口（固定，勿改）
    Root.tsx              # 映射 COMPOSITIONS 数组（固定，勿改）
    compositions/
      index.tsx           # 合成物注册表 ← 新视频在这里登记
      HelloCrab.tsx       # 示例合成物
  render-runner.cjs       # 渲染 runner（工具托管，勿改）
  remotion.config.ts
```

## 添加一个视频（两步）

1. **写组件**：在 `src/compositions/` 新建 `<Name>.tsx`，导出组件 + 元信息：

```tsx
import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export const weeklyMeta = { durationInFrames: 150, fps: 30, width: 1280, height: 720 };

export const Weekly: React.FC<{ items?: string[] }> = ({ items = [] }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: "#0f172a", justifyContent: "center", padding: 80 }}>
      {items.map((t, i) => (
        <div key={i} style={{
          color: "#f8fafc", fontSize: 44, marginBottom: 24,
          opacity: interpolate(frame - i * 10, [0, 15], [0, 1], { extrapolateRight: "clamp" }),
        }}>{t}</div>
      ))}
    </AbsoluteFill>
  );
};
```

2. **登记**：在 `src/compositions/index.tsx` 的 `COMPOSITIONS` 数组加一条：

```tsx
import { Weekly, weeklyMeta } from "./Weekly";
// …
{ id: "Weekly", component: Weekly, ...weeklyMeta },
```

3. **渲染**：调用 `RemotionRender` 工具，`composition: "Weekly"`，需要参数化就传 `props`。

## RemotionRender 参数速查

| 参数 | 说明 |
|---|---|
| `composition` | 合成物 id（登记在 index.tsx 里的 id），必填 |
| `props` | 传入组件的 inputProps 对象 |
| `wait_seconds` | 同步等待秒数（默认 90）。超时任务转后台，完成后视频卡自动出现；`RemotionStatus(task_id)` 可查进度 |
| `codec` | h264（默认）/ h265 / vp8 / vp9 / gif |
| `scale` | 分辨率缩放（0.5 = 减半，加速渲染） |
| `output_name` / `title` | 输出文件名 / 视频卡标题 |

渲染完成：视频卡自动进对话流（进度卡原地变形为视频卡），产物登记进文档产物列表。
要发飞书/企微：`SendLarkFile` / `SendWecomFile`（**30MB 上限**，长视频先 `scale` 降清或裁短）。

## 写法要点（Remotion 最佳实践浓缩）

- **一切动画基于 `useCurrentFrame()`**：不用 setTimeout/CSS animation（渲染器逐帧截图，时间驱动才可靠）。
- **缓动**：`interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" })` 做透明度/位移；
  `spring({ frame, fps, config: { damping: 12 } })` 做弹性入场。
- **编排**：用 `<Sequence from={30}>` 让子元素延迟入场；`<Series>` 做分段轮播。
- **时长**：`durationInFrames / fps` = 秒数。30fps 下 10 秒 = 300 帧。
- **尺寸**：横屏 1280x720 / 1920x1080，竖屏(抖音/视频号) 720x1280。
- **静态资源**：图片/音频/视频放项目 `public/` 目录，用 `staticFile("logo.png")` 引用；
  视频用 `<OffthreadVideo>`，音频用 `<Audio>`，配字幕用 `<Img>`/文字逐帧。
- **字体**：系统字体族（sans-serif）最稳；要品牌字体用 `@remotion/google-fonts`（需 Bash 加依赖后重装）。
- **数据视频**：组件里直接 map 数据数组 + 按帧入场，就是模板化批量视频；换 `props` 出不同版本。
- **性能**：长视频/高分辨率渲染慢，预览期用 `scale: 0.5`，交付再用原尺寸。

## 常见错误

| 报错 | 原因/处理 |
|---|---|
| `Composition not found` | id 未登记进 `COMPOSITIONS` 数组，或 Root.tsx 被改动 |
| `props 不生效` | 组件没有声明该 prop，或 defaultProps 缺失 |
| 首次渲染卡在安装 | 初始化含浏览器下载，等进度卡走完；失败重试一次 |
| 渲染超 15 分钟 | 视频太长/分辨率太高，裁短、`scale` 降清或 `fps` 降到 24 |
| 要加第三方包 | 用 Bash 在项目目录 `npm install <pkg>`（工具只装脚手架自带依赖） |

## 与 VideoGenerate 的分工

| | RemotionRender（本技能） | VideoGenerate |
|---|---|---|
| 原理 | React 代码逐帧合成 | AI 模型生成实拍感画面 |
| 适合 | 数据/模板/文字/图表/产品 UI 动画 | 创意画面、实景风格、无素材起点 |
| 可控性 | 精确到帧、可复现、可参数化 | 提示词驱动，抽卡式 |
