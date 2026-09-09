---
name: article-writer
version: 1.0.0
description: "长文写作辅助，按公众号/知乎/头条/小红书风格从大纲生成成文，含SEO标题与排版建议。当用户说“帮我写篇文章/公众号推文/知乎回答”或需要把提纲扩写成完整长文时使用。"
metadata:
  crabpaw:
    emoji: "✍️"
    category: media
    capabilities: [article_writing]
    triggers: [write, article, post, blog, copywriting, draft, writing, content]
    platforms: [linux, macos, windows]
    requires: [web_search, web_fetch]
---

# ✍️ 长文写作辅助

## 概述

从选题到大纲到成文，适配多平台风格的全流程写作助手。

## 平台风格适配

| 平台 | 风格特征 | 字数建议 | 排版特点 |
|------|---------|---------|---------|
| 公众号 | 信息密度高、分段短、金句多 | 1500-3000 | 短段落、小标题多、配图丰富 |
| 知乎 | 深度专业、论证充分、数据支撑 | 2000-5000 | 长段落、引用多、逻辑严密 |
| 头条 | 标题党友好、通俗易懂、情绪共鸣 | 800-1500 | 短小精悍、观点鲜明 |
| 小红书 | 个人化、种草风、emoji多 | 500-1000 | 短句为主、话题标签多 |

## 核心功能

### 1. SEO标题生成
/article title "主题" --platform wechat
生成 3-5 个备选标题
评估点击率、搜索友好度、平台推荐概率

### 2. 大纲生成
/article outline "主题" --depth 3
生成 2-3 层深度大纲
提供不同切入角度的方案

### 3. 全文写作
/article write "主题" --platform zhihu --tone professional
根据大纲生成完整文章
支持指定语气（专业/轻松/犀利/温情）

### 4. 排版优化
/article polish <文章内容>
优化段落结构
添加合适的排版标记（加粗、引用、分隔）
建议配图位置

### 5. 一鱼多吃
/article repurpose <原文> --from wechat --to xiaohongshu
将一篇长文拆解/改写成适配其他平台的内容
