---
name: report-generator
version: 1.0.0
description: "自动报表技能，模板化生成日报/周报/月报，多数据源自动填充并生成图表。当用户说「帮我写个周报」「写日报/月报」或要汇总数据成报表时使用。"
metadata:
  crabpaw:
    emoji: "📊"
    category: office
    capabilities: [data_analysis, document_generation]
    triggers: [report, daily_report, weekly_report, monthly_report, dashboard, auto_report]
    platforms: [linux, macos, windows]
    requires: [xlsx_query, web_fetch]
---

# 📊 自动报表

## 概述

模板化报表自动生成器，数据自动填充，图表一键输出。

## 核心功能

### 1. 日报
/report daily --date 2026-06-21
今日工作内容总结
数据指标更新
明日计划
阻塞项和需要的支持

### 2. 周报
/report weekly --week 25
本周关键成果
数据趋势图
下周重点
风险提示

### 3. 月报
/report monthly --month 6
月度关键指标 (KPI)
环比/同比分析
重点项目进展
下月规划

### 4. 自定义模板
/report template --columns "日期,销售额,订单数,客单价"
自定义报表模板
保存为可复用的模板
下次一键填充

### 5. 数据对接
/report connect --source "数据库/API/Excel"
从多种数据源自动拉取数据
定时生成并推送
支持导出 PDF/Excel

## 模板变量

{date} {week} {month} {year}
{revenue} {orders} {customers}
{growth_rate} {completion_rate}
自定义...
