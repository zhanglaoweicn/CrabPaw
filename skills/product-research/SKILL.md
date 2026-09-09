---
name: product-research
version: 1.0.0
description: "电商选品分析技能，支持竞品销量评估、价格带分析、1688/拼多多货源比价、评价情感分析、蓝海品类发现。当用户想选品、找货源、做市场调研或决定卖什么时使用。"
metadata:
  crabpaw:
    emoji: "📦"
    category: business
    capabilities: [data_analysis, product_research]
    triggers: [product, product_research, sourcing, dropshipping, competitor, pricing, category, niche, taobao, pdd, jd]
    platforms: [linux, macos, windows]
---

# 📦 电商选品分析

## 概述

数据驱动的选品分析工具，从竞品、价格带、评价、趋势四个维度帮你做出上架决策。

## 五大分析维度

### 1. 竞品分析 (/product competitor <关键词>)
- 同类商品销量估算（月销/评价数反推）
- Top 10 卖家价格/主图/卖点对比
- 新入局者的机会窗口判断

### 2. 价格带分析 (/product pricing <品类>)
- 品类价格带分布（热销/利润/垃圾区间）
- 各价格带竞争密度
- 建议定价区间及理由

### 3. 评价挖掘 (/product reviews <链接>)
- 好评高频词（用户到底在夸什么）
- 差评聚类（5种差评模式）
- 未满足需求清单（新卖点来源）

### 4. 1688货源 (/product source <关键词>)
- 同款/类似款货源列表
- 拿货价区间 + 建议零售价
- 供应商可靠性初筛（年限/复购率/回头率）
- 一件代发支持情况

### 5. 蓝海发现 (/product blueocean <品类>)
- 高需求低竞争关键词
- 搜索量/在线商品数比值
- 新店入局可行性评分

## 输出格式

📦 选品分析报告: [品类名]

📊 市场概况
月搜索量 / 在线商品数 / 竞争度 / 均价

🏆 Top竞品对比
排名 | 店铺 | 月销 | 价格 | 核心卖点

💰 价格带分布
区间 + 销量占比 + 竞争程度 + 建议

💬 评价关键发现
用户最在意什么 / 高频差评 / 未满足需求

📦 货源参考
拿货价 + 建议零售价 + 预估利润率

✅ 最终建议: 可入/谨慎/不建议 + 差异化方向
