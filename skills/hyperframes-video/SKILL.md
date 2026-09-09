---
name: hyperframes-video
version: "1.0.0"
description: "HyperFrames HTML→视频渲染：写普通 HTML（data-start/data-duration 时序）合成模板/数据/设计感视频并渲染 MP4。适合'给已有视频加字幕/加图形覆层'、参数化批量渲染、块级模板视频。AI 创意实拍用 VideoGenerate；React 精确控制用 RemotionRender。"
metadata:
  crabpaw:
    emoji: 🎞️
    category: visualization
    capabilities: [video_generation, video_postprocessing]
    requires:
      bins:
        - node
    priority: 3
    tags: [video, hyperframes, html, captions, template]
---

# HyperFrames 视频生成

合成物就是一张普通 HTML 页面：用 `data-start` / `data-duration` 属性声明时间轴，
HyperFrames 用 headless Chrome 确定性逐帧渲染成 MP4。GSAP / Lottie / Three.js / CSS 动画都可以用。
强项：块级模板视频、**给已有视频加字幕或图形覆层**、参数化批量渲染。

## 工作区项目（路径固定）

项目位置（仓库根相对）：`data/.crabpaw/workspace/hyperframes/`（首次调用 HyperFramesRender
时自动脚手架并安装依赖；首次初始化含浏览器下载，约 2-5 分钟，之后秒级就绪）。

**开始前的第一步：永远先调 `HyperFramesStatus`（不带参数）**——它返回项目绝对路径
（project_dir）和已有合成物清单（available_compositions）。
⚠️ 禁止用 LS/Glob 搜索项目位置：项目在隐藏目录 `.crabpaw` 下，且浪费调用预算。

## 合成物结构（一个 HTML 文件 = 一个视频）

放在 `compositions/` 目录下，如 `compositions/product-intro.html`：

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>/* 页面尺寸必须与 data-width/height 一致 */</style>
</head>
<body>
  <div id="stage" data-composition-id="product-intro" data-width="1280" data-height="720"
       data-start="0" data-duration="10"
       data-composition-variables='[{"id":"title","type":"string","label":"标题","default":"默认标题"}]'>
    <div id="title">标题内容</div>
  </div>
  <script>
    // seekable 时间轴：GSAP timeline 必须 paused 且注册到 window.__timelines[合成物ID]，
    // 渲染器按 data-composition-id 查找并逐帧 seek。用 fromTo()（随机 seek 可靠），勿用 from()。
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#title', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, 0);
    window.__timelines = window.__timelines || {};
    window.__timelines['product-intro'] = tl;
  </script>
</body>
</html>
```

要点：
- 根元素带 `data-composition-id` / `data-width` / `data-height` / `data-start` / `data-duration`（秒）
- **GSAP timeline 必须 `paused: true` 且注册到 `window.__timelines['<data-composition-id>']`**——
  渲染器按这个注册表逐帧 seek，漏了注册画面会卡在首帧空白
- 动画用 `fromTo()`（随机 seek 可靠）；给关键 tween 显式位置参数；只动 transform/opacity
- `data-composition-variables` 定义参数化变量，渲染时通过工具的 `props` 传值覆盖

## 渲染（HyperFramesRender 工具）

| 参数 | 说明 |
|---|---|
| `composition` | compositions/ 下的文件名（可不含 .html 后缀），必填 |
| `props` | 变量取值对象（覆盖 data-composition-variables 的 default） |
| `wait_seconds` | 同步等待秒数（默认 90），超时转后台，`HyperFramesStatus(task_id)` 查进度 |
| `format` | mp4（默认）/ webm / gif |
| `output_name` / `title` | 输出文件名 / 视频卡标题 |

渲染前会自动跑 `hyperframes lint` 静态校验：结构错误会**在打包前被拦截**并给出具体
findings——按提示修复 HTML 后重试即可，不用改别的。完成：视频卡自动进对话流；
发飞书/企微用 `SendLarkFile` / `SendWecomFile`（30MB 上限）。

## 写法规范

- 页面 `html,body` 尺寸必须等于 `data-width`×`data-height`，`overflow: hidden`
- 时长单位是**秒**（data-duration="10" = 10 秒）；帧率默认 30
- 中文用 `'Microsoft YaHei','PingFang SC',sans-serif`；**emoji 图标在无头渲染里可能缺字形**
  （显示为 ？ 方块）——用数字徽标/纯 CSS 图形替代更稳
- 复杂画面参考 GSAP timeline 编排（多个 from/to 按 0.x 秒错峰入场）
- 参数化批量：固定版式 + `data-composition-variables`，换 `props` 出不同版本

## 给已有视频加字幕/图形覆层（五步工作流）

典型需求：给口播/访谈视频加动态字幕、标题条、数据卡片。**原视频不动**，作为底层，
图形层叠在上面渲染合成。第一步永远是 `HyperFramesStatus`（拿项目路径）。

1. **素材入库**：`HyperFramesStageAsset { file_path: <上传的视频绝对路径> }` ——
   复制进项目 `assets/`，返回 `assets_ref`（如 `assets/interview.mp4`）。
   ⚠️ 智能体无法自己复制二进制文件（GUI 渠道无 Bash），必须用本工具。
2. **转写**：`HyperFramesTranscribe { input_path: <assets_ref 对应的 staged_path> }` ——
   本地 whisper 转写为词级 `transcript_<名>.json`（首次自动下载模型；whisper-cpp
   未安装时工具会报安装指引）。**替代方案**：已有 .srt/.vtt 转写稿直接传给本工具
   （导入模式，无需 whisper）——bossagent 会议记录的转写稿就是现成来源。
3. **写合成物**：原视频做底层 + 图形层按 transcript 词级时间排布：

```html
<video class="clip" src="assets/interview.mp4" data-start="0" data-duration="60"
       style="object-fit: cover"></video>
<!-- 字幕：按 transcript 的 start/end 逐句排 -->
<div class="clip" data-start="12" data-duration="3.5"
     style="position:absolute; left:80px; right:80px; bottom:70px; text-align:center;
            font-size:44px; font-weight:700; color:#fff; text-shadow:0 2px 12px rgba(0,0,0,0.8)">
  营收增长 40%
</div>
<!-- 数据卡片/标题条同理，放在上三分之一或侧边，避免遮挡人物面部 -->
```

4. **渲染**：`HyperFramesRender { composition: "<名字>" }`（自动过 lint 门）。
5. 交付：视频卡自动展示；发飞书/企微用 SendLarkFile（30MB 上限）。

字幕样式规范：白字+黑描边/阴影最稳；一句一行（每行 ≤18 字）；底部 70-90px 安全区；
数字/关键词用品牌色高亮。

## 常见错误

| 报错 | 原因/处理 |
|---|---|
| lint findings 列表 | 按 finding 提示修 HTML；都是打包前拦截，修完重试即可 |
| `durationInFrames`/时长相关 | data-duration 缺失或单位写错（应为秒） |
| 页面空白/超时 | html,body 尺寸与 data-width/height 不一致，或动画不可 seek |
| 首次渲染卡在安装 | 初始化含浏览器下载，等进度卡走完；失败重试一次 |
| 要加第三方包 | 用 Bash 在项目目录 `npm install <pkg>`（工具只装脚手架自带依赖） |

## 三个视频引擎的分工

| | HyperFramesRender（本技能） | RemotionRender | VideoGenerate |
|---|---|---|---|
| 写法 | HTML + 时序属性 | React 组件 | AI 提示词 |
| 强项 | 模板/块级视频、给已有视频加字幕覆层、参数化批量 | 复杂动画精确控制 | 创意实拍画面 |
| 选它当 | 有现成视频要包装、要批量出片、版式类内容 | 需要帧级精细动画 | 要真实感画面 |
