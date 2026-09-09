---
name: listing-optimizer
version: 1.0.0
description: "商品详情优化，淘宝SEO关键词优化、卖点提取、A+页面文案生成、主图优化建议。当电商卖家说“帮我优化商品标题/详情页/主图”“这个产品怎么描述更好卖”时使用。"
metadata:
  crabpaw:
    emoji: "💰"
    category: business
    capabilities: [marketing]
    triggers: [listing, product_description, taobao_seo, product_copy, detail_page, product_page]
    platforms: [linux, macos, windows]
    requires: [web_search]
---

# 💰 商品详情优化

## 概述

帮助电商卖家优化商品标题、详情页、主图，提升搜索排名和转化率。

## 核心功能

### 1. 标题优化
/listing title "产品词" --platform taobao
分析竞品标题的高频关键词
生成标题方案（包含：核心词+属性词+场景词+营销词）
淘宝标题30字限制自动适配

### 2. 卖点提取
/listing selling-points "产品描述"
从产品特性中提取 3-5 个核心卖点
区分：功能卖点（解决什么问题）vs 情感卖点（带来什么感觉）
每个卖点附带具体数据支撑建议

### 3. A+页面文案
/listing aplus "产品品牌故事"
生成品牌故事框架
视觉+文案搭配建议
模块化布局指导

### 4. 主图优化
/listing images --check
主图合规性检查（淘宝/拼多多规则）
对比竞品主图风格
建议主图视频脚本

### 5. 评价转化
/listing review-insights <商品链接>
从评价中提取买家最关心的点
融入详情页文案
常见疑虑的预答复话术

## 输出示例

💰 标题优化方案: 桌面手机支架

方案A（搜索优先）:
"手机支架桌面铝合金可折叠升降直播拍摄多功能通用懒人支架便携"

方案B（转化优先）:
"铝合金手机支架桌面 可折叠升降不挡屏 直播网课追剧通用便携支架"

关键词覆盖: 手机支架/桌面/铝合金/可折叠/升降/直播/通用/便携
