---
name: bilibili-knowledge
version: 1.0.0
description: "B站站点知识包，搜索/播放走公开接口，专栏、动态、登录态走浏览器兜底，含搜索到播放的调用链。当用户提到B站/哔哩哔哩/BV号/AV号/up主/三连或给出bilibili.com链接时使用。"
metadata:
  crabpaw:
    emoji: "📺"
    category: media
    capabilities: [bilibili_knowledge]
    triggers: [b站, 哔哩, bilibili, BV号, AV号, 弹幕, 投币, 三连]
    platforms: [linux, macos, windows]
---

# 📺 B站（哔哩哔哩）站点知识包

## 激活条件
用户提到 B站/哔哩/bilibili/BV 号/AV 号/up主/弹幕/三连/投币/收藏，或给出 bilibili.com 链接时，使用本包知识。

## 工具选择决策表
| 场景 | 首选 | 说明 |
|---|---|---|
| 搜视频 | BilibiliSearch(keyword) | 结果含 bvid → SceneMedia(id="video_1", bvid=...) 应用内播放 |
| 已知 BV 号/视频链接 | SceneMedia(bvid) 或 BilibiliPlay(bvid) | BilibiliPlay 内部已自动推媒体面板，**勿再重复调 SceneMedia**；SceneMedia 自动解析直链 |
| 专栏文章 bilibili.com/read | WebFetch 或 BrowserControl | 需 JS 渲染，勿用普通 http_get |
| 用户资料/动态/点赞投币三连 | BrowserControl（需登录）或告知无法代办 | 公开 API 无此能力，**不要声称已完成**（防幻觉） |
| 分区热门/排行榜 | WebFetch popular URL 或 BilibiliSearch 关键词替代 | 无专用工具 |

## 核心调用链
BilibiliSearch(keyword) → 取第一个结果的 bvid → SceneMedia(id="video_1", bvid=..., autoplay=true) → getBilibiliPlayUrl 内部走 view API + playurl API（qn=64→32 降级）→ 媒体面板播放。只知 BV 号时一条 SceneMedia(bvid) 即完成，无需先搜索。

## 字段陷阱（BilibiliSearch 返回值）
- 分区字段是 `result_type`，**不是 `module_type`**（历史 bug：误判导致恒无结果）
- `duration` 是 "mm:ss" 字符串（如 "3:45"），不是秒数
- `title` 含 `<em>` 标签（工具已剥离）；`play` 已格式化为"万"
- `pic` 是协议相对 URL（//i0.hdslb.com/...），展示时补 https:
- 清晰度 qn：64=480p、32=360p 是免登录上限；playUrl 为 null = 需登录或区域限制

## BV/AV 格式
BV 号 = `BV1` 开头共 10 字符（如 BV1GJ411x7h）；AV 号 = 纯数字（如 av170001，仍可解析）。工具 schema 只接受 bvid 参数，遇 AV 号先 BilibiliSearch 反查 bvid 或直接浏览器打开。

## 核心 URL 速查（完整矩阵见 references/url-patterns.md）
- 视频页 `bilibili.com/video/{bvid}`｜用户空间 `space.bilibili.com/{mid}`
- 搜索 `search.bilibili.com/all?keyword=`｜专栏 `bilibili.com/read/cv{cv号}`

## Gotchas 摘要（详见 references/browser-fallback.md）
- 不要声称已完成三连/投币/收藏——公开 API 无此能力，只能浏览器代办或明示不可行
- bilibili.com/read 必须浏览器渲染；视频页 wait_for_load 不够，需额外等待播放器加载
- "动态"有两种含义：`t.bilibili.com` 关注 feed vs `space.bilibili.com/{mid}/dynamic` 用户动态
- 视频 URL 可能带 `?vd_source=` 追踪参数，可剥离
- watchlater（稍后再看）是 SPA 路径，需 wait 再取元素

## 参考文档
- references/partitions.md — 30 分区 slug 全表（c/douga 动画等）
- references/url-patterns.md — 完整 URL 模式矩阵
- references/browser-fallback.md — 浏览器兜底操作手册（六段式）

---

## 分区 slug 速查（完整表见 references/partitions.md）
动画=c/douga｜游戏=c/game｜鬼畜=c/kichiku｜音乐=c/music｜舞蹈=c/dance｜影视=c/cinephile｜娱乐=c/ent｜知识=c/knowledge｜科技=c/tech｜数码=c/digital｜美食=c/food｜汽车=c/car｜生活=c/life｜时尚=c/fashion｜运动=c/sports｜动物=c/animal｜国创=c/guochuang｜纪录片=c/documentary｜小剧场=c/shortplay｜资讯=c/information｜vlog=c/vlog｜绘画=c/painting｜AI=c/ai｜家装房产=c/home｜户外=c/outdoors｜健身=c/gym；热门榜走 `/v/popular/*`

## 登录态检测（浏览器兜底）
```javascript
// 已登录：头像元素存在
js("document.querySelector('.header-entry-avatar')?.src || 'not logged in'")
// 未登录：登录按钮可见
js("document.querySelector('.header-login-entry')?.textContent?.trim() || 'no login btn'")
```

最后核对日期：2026-08-20
