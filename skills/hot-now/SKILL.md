---
name: hot-now
version: 1.0.0
description: "即时热点快查，trending-monitor 的快捷入口，返回当前各平台热搜TOP20汇总。当用户说“今天有什么热点”“看看热搜”“有什么新闻”时使用。"
metadata:
  crabpaw:
    emoji: "🔥"
    category: media
    capabilities: [trend_monitoring]
    triggers: [hot_now, today_hot, trending_now, search_hot, top_news]
    platforms: [linux, macos, windows]
---

# 🔥 即时热点

## 概述

trending-monitor 的快捷入口，快速查看当前全平台热点。

## 触发

用户说"今天有什么热点"、"看看热搜"、"有什么新闻"时自动触发。

## 行为

调用 trending-monitor 的即时查询，返回当前各平台热点TOP20汇总。
