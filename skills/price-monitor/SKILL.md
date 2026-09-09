---
name: price-monitor
version: 1.0.0
description: "竞品价格监控技能，追踪商品价格变动、促销活动、库存变化，异常波动即时告警。当用户想盯竞品价格、设置降价提醒、监控商品链接价格变化时使用。"
metadata:
  crabpaw:
    emoji: "📉"
    category: business
    capabilities: [price_monitoring]
    triggers: [price, price_watch, competitor_price, price_alert, price_change, promotion_track]
    platforms: [linux, macos, windows]
    requires: [browser_control, web_fetch]
---

# 📉 竞品价格监控

## 概述

自动追踪竞品价格，价格变动超阈值即时告警，促销活动追踪。

## 核心功能

### 1. 添加监控
/price watch <商品链接> --name "竞品A" --threshold 5%
添加商品到监控列表
设置价格变动告警阈值
支持淘宝/拼多多/京东链接

### 2. 价格看板
/price dashboard
当前监控商品列表
今日价格变动汇总
近7天价格走势

### 3. 异常告警
/price alerts
主动推送：
- 降价超过阈值
- 竞品突然提价
- 促销活动开始/结束
- 库存告急

### 4. 促销追踪
/price promo <品类>
追踪同类目促销节奏
大促前竞品预热动作
优惠券发放策略

### 5. 定价建议
/price suggest <商品ID>
基于竞品价格带推荐定价
考虑利润率目标
动态定价策略建议

## 输出示例

📉 价格异动告警 | 2026-06-21

🔴 竞品A 降价 15%: 39.9 -> 33.9
🟡 竞品B 提价 8%: 29.9 -> 32.9
🟢 竞品C 开启满减: 满200减30
