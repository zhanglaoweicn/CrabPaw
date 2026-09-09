---
name: promo-planner
version: 1.0.0
description: "电商活动策划技能，提供大促节奏建议、优惠券策略、满减方案计算、活动复盘模板。当用户想策划促销活动、设计优惠券满减、规划618/双11大促时使用。"
metadata:
  crabpaw:
    emoji: "🎉"
    category: business
    capabilities: [marketing]
    triggers: [promo, promotion, campaign, sale, discount, coupon, shop_activity, shopping_festival]
    platforms: [linux, macos, windows]
    requires: [web_search]
---

# 🎉 活动策划

## 概述

电商促销活动的全流程策划助手，从策略到执行到复盘。

## 核心功能

### 1. 大促节奏
/promo calendar
全年大促日历（618/双11/双12/年货节/38节等）
每个节点的准备时间线
不同品类适合的主推节点

### 2. 优惠券策略
/promo coupon --budget 5000 --goal 清仓
基于预算和目标推荐券面和数量
满减门槛计算（客单价 x 1.2-1.5 法则）
预期核销率和 ROI 估算

### 3. 满减方案
/promo discount --avgPrice 89
计算最佳满减阶梯
例如：满199减20 / 满299减40 / 满499减80
预估连带率提升

### 4. 活动脚本
/promo script --type 直播
生成直播带货话术框架
限时折扣的紧迫感营造
产品介绍的黄金结构

### 5. 复盘模板
/promo review <活动名称>
活动数据复盘框架
ROI 计算模板
下次改进清单

## 营销日历速查

| 月份 | 节点 | 适合品类 |
|------|------|---------|
| 1月 | 年货节 | 食品/礼品/家居 |
| 3月 | 38女王节 | 美妆/服饰/个护 |
| 6月 | 618 | 全品类 |
| 9月 | 99大促 | 全品类 |
| 11月 | 双11 | 全品类 |
| 12月 | 双12 | 全品类 |
