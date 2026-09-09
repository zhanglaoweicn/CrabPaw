---
name: review-analyzer
version: 1.0.0
description: "评价分析技能，对商品评价做情感分析、高频关键词提取、差评聚类并生成改进建议。当用户想分析买家评论、评价口碑、差评原因或改进产品时使用。"
metadata:
  crabpaw:
    emoji: "💬"
    category: business
    capabilities: [data_analysis, review_analysis]
    triggers: [review, review_analysis, comment_analysis, sentiment, customer_feedback, rating]
    platforms: [linux, macos, windows]
    requires: [web_fetch]
---

# 💬 评价分析

## 概述

从海量用户评价中提炼可执行的洞察，变差评为产品迭代方向。

## 核心功能

### 1. 情感分析
/review sentiment <商品链接或评价文本>
正面/中性/负面评价占比
情感趋势变化（最近30天）
竞品情感对比

### 2. 关键词提取
/review keywords <商品链接>
好评高频词 Top 20（用户最满意什么）
差评高频词 Top 20（用户最不满意什么）
新兴关键词（最近新增的评价维度）

### 3. 差评聚类
/review complaints <商品链接>
差评自动归类为 3-5 个核心问题
每个问题标注严重程度和影响面
附带典型差评原文引用

### 4. 改进建议
/review improve <商品链接>
基于差评聚类的产品改进清单
按优先级排序（影响面 x 易修复程度）
每个建议预估改善效果

### 5. 竞品评价对比
/review compare <我的商品链接> <竞品链接>
评价维度的优劣势对比
竞品的差评里藏着你的卖点
你的差评里藏着竞品的机会

## 输出示例

💬 评价分析报告: 手机支架

情感分布: 🟢 正面 68% | 🟡 中性 22% | 🔴 负面 10%

好评关键词: 稳固(62%) 质感(45%) 角度好(38%) 颜值高(30%)
差评关键词: 松动(35%) 太重(28%) 异味(18%) 划痕(12%)

差评聚类:
1. 🔴 使用后松动 - 影响32%的差评
2. 🟡 产品偏重 - 影响25%的差评
3. 🟡 开箱有异味 - 影响18%的差评

改进建议:
P0: 铰链加固设计 -> 预计减少30%差评
P1: 换成轻质铝合金 -> 预计减少25%差评
