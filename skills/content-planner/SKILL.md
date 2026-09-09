---
name: content-planner
version: 1.0.0
description: "内容选题策划，根据热点趋势和历史数据推荐选题方向、生成内容日历，标注流量预估、竞争程度与最佳发布时间。当自媒体创作者问“该更新什么”“帮我排个内容日历”“规划下周选题”时使用。"
metadata:
  crabpaw:
    emoji: "📅"
    category: media
    capabilities: [content_writing]
    triggers: [content_plan, editorial, calendar, topic, planning, schedule_content]
    platforms: [linux, macos, windows]
    requires: [hot_search, web_search, memory_search]
---

# 📅 内容选题策划

## 概述

将零散的灵感变成可执行的选题日历，用数据驱动内容决策。

## 核心功能

### 1. 选题推荐
/content plan --platform wechat --count 7
基于当前热点 + 账号历史数据
推荐未来一周的选题方向
每个选题标注：流量预估、竞争程度、最佳发布时间

### 2. 内容日历
/content calendar --month 7
生成月度内容日历
标注重要营销节点（节假日、大促、行业事件）
分散内容类型（干货/观点/故事/推广）

### 3. 灵感捕手
/content capture "灵感碎片..."
随时记录选题灵感
自动归类、关联已有选题
定期回顾提醒

### 4. 选题评估
/content evaluate "选题描述"
评估选题的：
- 流量潜力（搜索量/话题热度）
- 竞争程度（已有内容数量）
- 差异化角度（你的独特优势）
- 投入产出比（写作耗时 vs 预期流量）

## 输出格式

📅 内容日历 | 2026年7月

周一 干货类
周二 观点类
周三 故事类
周四 干货类
周五 推广/恰饭
周末 轻量/互动

标注热点日、节日、大促节点
每个选题包含：标题方向、关键词、参考素材
