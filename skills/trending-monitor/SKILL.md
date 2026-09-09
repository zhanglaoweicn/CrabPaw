---
name: trending-monitor
version: 1.0.0
description: "热点监控技能，聚合微博热搜、知乎热榜、百度风云榜、抖音热点等多平台实时热点，支持定时推送与关键词过滤。当用户问「今天有什么热点」「热搜是什么」或追话题时使用。"
metadata:
  crabpaw:
    emoji: "📡"
    category: media
    capabilities: [trend_monitoring]
    triggers: [hot, hot_search, trending, news, buzz, viral, weibo, zhihu, douyin]
    platforms: [linux, macos, windows]
---

# 📡 热点监控

## 概述

聚合多平台实时热点，帮助创作者快速发现选题、追踪话题热度变化。

## 数据源覆盖

| 平台 | 内容类型 | 更新频率 |
|------|---------|---------|
| 微博热搜 | 实时热搜榜 + 文娱榜 + 要闻榜 | 分钟级 |
| 知乎热榜 | 社会/科技/娱乐/财经分类热点 | 小时级 |
| 百度风云榜 | 实时热点 + 七日趋势 + 搜索指数 | 小时级 |
| 抖音热点 | 挑战榜 + 流行趋势 + 音乐榜 | 小时级 |
| 头条热榜 | 新闻/科技/娱乐分类 | 小时级 |
| B站热门 | 全站排行榜 + 各分区排行 | 日级 |

## 核心功能

### 1. 即时查询
/hot now              当前全平台热点TOP20
/hot weibo             仅微博热搜
/hot zhihu             仅知乎热榜
/hot search <关键词>   搜索是否有相关热点

### 2. 定时推送
/hot watch "AI" --every 2h         AI相关热点追踪
/hot digest --at 9:00              每日热点早报
/hot week-report                    本周热点回顾

### 3. 热度追踪
/hot track <话题>                   话题热度变化曲线
/hot related <话题>                 相关热点和延伸选题

## 输出格式

📡 热点早报 | 日期

🔴 爆 (热搜指数 > 90)
🟡 热 (热搜指数 50-90)
🟢 新 (上升趋势)

附选题角度建议（争议/科普/共鸣），适合平台建议，预估流量池

## 配置
推荐使用热点早报 + 下午速报 + 晚间总结的三段式节奏
