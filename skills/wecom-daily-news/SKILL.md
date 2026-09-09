---
name: wecom-daily-news
version: "1.0.0"
description: "企业微信资讯推送技能，自动获取AI资讯并通过企业微信推送给指定用户或群组，支持定时任务。当用户要每日资讯推送、定期技术动态分享或群发新闻时使用。"
metadata:
  crabpaw:
    emoji: 📰
    category: productivity
    capabilities: [notification]
    triggers:
      - 每日资讯
      - AI资讯推送
      - 企业微信推送
      - 每日新闻
---

# 企业微信每日资讯推送

## 技能描述

自动获取AI资讯并通过企业微信推送到指定用户或群组。支持定时任务触发，每天固定时间推送最新的AI行业动态、技术文章和产品更新。

## 功能特性

- 🤖 自动获取AI行业资讯
- 📊 智能筛选和排序
- 💬 企业微信消息推送
- ⏰ 支持定时任务
- 📝 Markdown格式美化
- 🔄 自动重试机制

## 使用场景

- 每日AI资讯推送
- 定期技术动态分享
- 行业新闻自动播报
- 产品更新通知

## 配置要求

### 必需配置

在 `data/.crabpaw/config.json` 中配置以下参数：

```json
{
  "wecom": {
    "corpId": "your_corp_id",
    "agentId": "your_agent_id",
    "secret": "your_secret"
  },
  "user": {
    "wecomUserId": "your_user_id"
  }
}
```

### 可选配置

在技能目录下的 `config.json` 中可配置：

```json
{
  "newsSources": [
    "ai-news",
    "tech-crunch",
    "machine-learning-weekly"
  ],
  "maxItems": 5,
  "messageTemplate": "daily-news"
}
```

## 触发方式

### 1. 定时任务

在自动化任务中添加：

```json
{
  "id": "wecom-daily-news",
  "name": "每日AI资讯推送",
  "cron": "0 19 * * *",
  "action": "skill",
  "skill": "wecom-daily-news",
  "enabled": true
}
```

### 2. 手动触发

在对话中输入关键词：
- "推送今日AI资讯"
- "发送每日新闻"
- "AI资讯推送"

### 3. API调用

```bash
POST /api/skills/wecom-daily-news/execute
```

## 输出格式

消息采用 Markdown 格式，包含：

```markdown
## 🤖 AI资讯日报 - 2024-01-15

### 📰 今日要闻

1. **标题1**
   - 来源：XX媒体
   - 摘要：...
   [查看详情](链接)

2. **标题2**
   - 来源：XX媒体
   - 摘要：...
   [查看详情](链接)

---

> 由 CrabPaw 自动推送
> 订阅/退订请回复对应指令
```

## 错误处理

- 网络请求失败：自动重试3次
- 配置缺失：返回详细错误提示
- 消息发送失败：记录日志并通知管理员

## 依赖

- Node.js >= 18.0.0
- 无需额外依赖包

## 版本历史

- v1.0.0 (2024-01-15)
  - 初始版本
  - 支持基础资讯推送功能

## 作者

CrabPaw Team

## 标签

`企业微信` `资讯推送` `自动化` `定时任务` `AI新闻`
