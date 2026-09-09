---
name: "multi-search-engine"
version: "2.0.0"
description: "多搜索引擎集成技能，自动路由到最佳引擎（中文Bing、英文SearXNG、学术Tavily），零配置即用。当用户需要联网搜索资料、查网页信息、找最新资料时使用。"
metadata:
  crabpaw:
    emoji: "🔍"
    category: search
    capabilities: [web_search]
    priority: 3
    tags: [search, research, web]
---

# 🔍 多搜索引擎

## 使用方法

直接使用 WebSearch 工具：

```
WebSearch({"query": "搜索关键词", "num": 10})
```

## 后端路由（自动选择，也可手动指定）

| 后端 | 优先级 | 适用场景 | 费用 |
|------|--------|---------|------|
| **Tavily** | 最高 | 通用/新闻/学术，需 API Key | API 计费 |
| **Bing** | 最高(中文) | 中英文搜索，国内直连 | 免费 |
| **Bing API** | 备用 | 企业级搜索 | 需 Key |
| Playwright | 渲染增强 | JS重度页面 | 需浏览器 |

> 2026-07-03 实测：baidu.com 触发反爬 ❌，DuckDuckGo/SearXNG/Sogou GFW 阻断 ❌，已从路由表中移除。

## 场景自动检测

- 含中文 → 优先 Bing → Tavily
- 含"新闻/最新/today" → 优先 Tavily news
- 含"论文/research/paper" → 优先 Tavily (学术源)
- 指定 backend 参数则不自动路由

## 手动指定后端

```
WebSearch({"query": "AI agent", "backend": "searxng_public"})
WebSearch({"query": "人工智能", "backend": "baidu"})
WebSearch({"query": "latest papers", "scenario": "academic"})
```

## 正文提取

搜索到链接后，用 WebExtract 获取全文：

```
WebExtract({"urls": ["https://example.com/article"]})
```

自动去除导航/广告/侧边栏，保留可读正文。

## 故障转移

单后端失败自动降级：
Tavily → Bing → Bing API → Playwright

## 注意事项

- Bing HTTP 零配置即可使用（国内直连）
- Tavily API 需配置 TAVILY_API_KEY（免费 1000 次/月，国内直连）
- 2026-07-03 实测：百度/搜狗/头条搜索触发反爬，DuckDuckGo/SearXNG GFW 阻断
