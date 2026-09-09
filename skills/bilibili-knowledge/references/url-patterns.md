# B站 URL 模式矩阵

每行给出识别特征 + 首选处理方式（API 工具 → WebFetch → BrowserControl 递减）。来源：browser-harness domain-skills/bilibili/navigation.md 转录核对（2026-08-20）。

## 核心页面

| 页面 | URL 模式 | 识别特征 | 首选处理方式 |
|---|---|---|---|
| 视频页 | `bilibili.com/video/{BV}` | BV 号 | 已登录场景可直接 BilibiliPlay(bvid)；仅需信息用 WebFetch |
| 用户空间 | `space.bilibili.com/{mid}` | 数字 mid | WebFetch；动态/收藏等需登录用 BrowserControl |
| 搜索 | `search.bilibili.com/all?keyword={QUERY}` | keyword 参数 | **用 BilibiliSearch 工具**，勿手写抓搜索页 |
| 专栏 | `bilibili.com/read/cv{cv号}` | cv 前缀 | **必须浏览器渲染**（Playwright 站点），WebFetch/BrowserControl |
| 动态-关注 | `t.bilibili.com` | 顶级路径 | 需登录 → BrowserControl；**注意与用户动态区分** |
| 动态-用户 | `space.bilibili.com/{mid}/dynamic` | mid/dynamic | 需登录 → BrowserControl |
| 热门 | `bilibili.com/v/popular/all` | popular | WebFetch 或 BilibiliSearch 关键词替代 |
| 排行榜 | `bilibili.com/v/popular/rank/all` | rank | WebFetch 或 BilibiliSearch 关键词替代 |
| 每周必看 | `bilibili.com/v/popular/weekly?num={N}` | weekly | WebFetch |
| 直播 | `live.bilibili.com/` | live 子域 | WebFetch 列表；直播间需登录交互用 BrowserControl |
| 音频 | `bilibili.com/audio/` | audio | WebFetch（Playwright 站点） |
| 番剧 | `bilibili.com/anime/`、`bangumi.bilibili.com` | anime/bangumi | 番剧信息用 WebFetch；播放通常需大会员 |

## 个人空间子页

| 页面 | URL |
|---|---|
| 主页（视频+收藏夹） | `space.bilibili.com/{mid}` |
| 动态 | `space.bilibili.com/{mid}/dynamic` |
| 投稿 | `space.bilibili.com/{mid}/upload` |
| 合集和系列 | `space.bilibili.com/{mid}/lists` |
| 收藏 | `space.bilibili.com/{mid}/favlist`（会重定向到 `?fid={DEFAULT_FOLDER_ID}&ftype=create`） |
| 追番追剧 | `space.bilibili.com/{mid}/bangumi` |
| 设置 | `space.bilibili.com/{mid}/settings` |

## 视频页元素

- 观看历史：`bilibili.com/account/history`（暂停/清空/日期过滤；历史项在 `.history-record`）
- 稍后再看：`bilibili.com/watchlater/#/list`（SPA 路径，**非** history 子页）
- 创作中心：`member.bilibili.com/platform/home`；投稿：`member.bilibili.com/platform/upload/video/frame`
- 黑名单：`bilibili.com/blackroom/ban`

## 与工具结合要点

- 给用户的视频链接统一归一化为 `https://www.bilibili.com/video/{bvid}`（剥离 `?vd_source=` 追踪参数）
- BilibiliSearch 已返回拼好的视频 URL，直接透传即可
- 需要"标题反查 bvid"（如用户只给 AV 号/视频标题）→ BilibiliSearch(标题/AV 号) 取首个结果
