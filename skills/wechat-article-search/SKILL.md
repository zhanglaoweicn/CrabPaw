---
name: wechat-article-search
version: "0.2.0"
description: "公众号文章搜索技能，通过搜狗微信搜索获取文章标题、摘要、时间、来源与链接。当用户说「帮我搜关于AI的公众号文章」「微信上有没有讨论XX的」时使用。"
metadata:
  crabpaw:
    emoji: 🔍
    category: search
    capabilities: [web_search]
    triggers:
      - wechat-search
      - 公众号搜索
      - 微信文章
---

# 微信公众号文章搜索

通过搜狗微信搜索（weixin.sogou.com）搜索微信公众号文章，获取标题、摘要、发布时间、来源公众号和文章链接。

## 激活条件

当用户需要搜索微信公众号文章时激活，例如：
- "帮我搜一下关于 AI 的公众号文章"
- "找几篇微信上关于 XX 的文章"
- "微信公众号里有没有讨论 XX 的"

## 依赖

需要 Node.js 包 `cheerio`：

```bash
npm install cheerio
```

## 使用方法

### 基本搜索

```bash
node scripts/search_wechat.js "关键词"
```

### 限制数量

```bash
node scripts/search_wechat.js "人工智能" -n 15
```

### 保存结果到文件

```bash
node scripts/search_wechat.js "关键词" -n 20 -o result.json
```

### 解析真实链接

```bash
node scripts/search_wechat.js "关键词" -n 5 -r
```

`-r` 参数会将搜狗中间链接解析为微信真实链接（`mp.weixin.qq.com`），但会额外请求每条结果，速度较慢。

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `query` | 搜索关键词（必填） | - |
| `-n, --num` | 返回数量 | 10（最大 50） |
| `-o, --output` | 输出 JSON 文件路径 | 无（输出到控制台） |
| `-r, --resolve-url` | 解析真实微信链接 | 否 |

## 输出字段

每篇文章包含：

| 字段 | 说明 |
|------|------|
| `title` | 文章标题 |
| `url` | 文章链接（搜狗中间链接或真实链接） |
| `summary` | 文章摘要 |
| `datetime` | 发布时间（YYYY-MM-DD HH:mm:ss） |
| `date_text` | 日期文本（X年X月X日） |
| `date_description` | 相对时间（如"2小时前"、"3天前"） |
| `source` | 来源公众号名称 |

## 使用建议

1. **关键词精炼** — 使用具体关键词效果更好，避免过于宽泛的词
2. **数量控制** — 默认 10 条足够，避免大量请求触发反爬
3. **真实链接** — `-r` 参数解析成功率受搜狗反爬限制，不保证 100% 成功
4. **频率控制** — 不要短时间内频繁搜索，建议间隔 30 秒以上
5. **结果为空** — 尝试更换关键词、减少特殊字符、或稍后重试

## 注意事项

- 本工具仅用于学习和研究目的
- 请遵守相关网站的使用条款
- 过度使用可能导致 IP 被封禁
- 搜狗微信搜索有反爬机制，部分请求可能失败
- 解析真实 URL 受反爬限制，成功率不保证

## 限制

- 最多返回 50 条结果
- 搜狗可能返回验证码页面（IP 被封）
- 部分文章链接可能已失效
- 不支持搜索特定公众号（仅关键词搜索）
