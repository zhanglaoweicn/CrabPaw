# B站 30 分区 slug 全表

来源：browser-harness domain-skills/bilibili/navigation.md（2026-05-01 实测），2026-08-20 转录核对。B 站首页左侧边栏 30 个内容分区，均映射到 `bilibili.com/c/{slug}`。

## 完整分区表

| 中文分区 | slug | 频道 URL | 备注 |
|---|---|---|---|
| 动画 | douga | `bilibili.com/c/douga` | |
| 游戏 | game | `bilibili.com/c/game` | |
| 鬼畜 | kichiku | `bilibili.com/c/kichiku` | 拼音缩写，不是 pinyin 直译 |
| 音乐 | music | `bilibili.com/c/music` | |
| 舞蹈 | dance | `bilibili.com/c/dance` | |
| 影视 | cinephile | `bilibili.com/c/cinephile` | |
| 娱乐 | ent | `bilibili.com/c/ent` | 缩写 |
| 知识 | knowledge | `bilibili.com/c/knowledge` | |
| 科技数码 | tech | `bilibili.com/c/tech` | 缩写 |
| 数码 | digital | `bilibili.com/c/digital` | |
| 美食 | food | `bilibili.com/c/food` | |
| 汽车 | car | `bilibili.com/c/car` | 源文档无尾斜杠 |
| 生活 | life | `bilibili.com/c/life` | |
| 时尚美妆 | fashion | `bilibili.com/c/fashion` | |
| 体育运动 | sports | `bilibili.com/c/sports` | |
| 动物 | animal | `bilibili.com/c/animal` | |
| 国创 | guochuang | `bilibili.com/c/guochuang` | |
| 纪录片 | documentary | `bilibili.com/c/documentary` | |
| 小剧场 | shortplay | `bilibili.com/c/shortplay` | |
| 资讯 | information | `bilibili.com/c/information` | |
| vlog | vlog | `bilibili.com/c/vlog` | |
| 绘画 | painting | `bilibili.com/c/painting` | |
| 人工智能 | ai | `bilibili.com/c/ai` | |
| 家装房产 | home | `bilibili.com/c/home` | |
| 户外潮流 | outdoors | `bilibili.com/c/outdoors` | |
| 健身 | gym | `bilibili.com/c/gym` | |

## 未使用 /c/ 的顶级入口

以下频道不走 `c/{slug}`，而是站点顶层路径：

| 频道 | URL |
|---|---|
| 番剧 | `bilibili.com/anime/` |
| 电影 | `bilibili.com/movie/` |
| 电视剧 | `bilibili.com/tv/` |
| 综艺 | `bilibili.com/variety/` |
| 热门榜 | `bilibili.com/v/popular/all`（综合）/ `v/popular/rank/all`（排行榜，24 分区 tab） |
| 每周必看 | `bilibili.com/v/popular/weekly?num={ISSUE}` |
| 入站必刷 | `bilibili.com/v/popular/all` 的"入站必刷"tab |

## 与工具结合

- 排行榜 24 分区 tab 与侧边栏 30 分区**不是同一套**（排行榜：全部/番剧/国创/纪录片/电影/电视剧/综艺/动画/游戏/鬼畜/音乐/舞蹈/影视/娱乐/知识/科技/数码/美食/汽车/时尚/美妆/体育/运动/动物）
- 需要"某分区的视频"时首选 BilibiliSearch(关键词+分区名)，例如 `BilibiliSearch("美食 探店")`；只有要抓排行榜/列表页本身时才 WebFetch `bilibili.com/c/{slug}`
- 频道 URL 是 Playwright 渲染站点，WebFetch 不可用时报错时再走 BrowserControl
