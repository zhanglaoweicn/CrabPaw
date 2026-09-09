---
name: StockQuery
description: 面向中国 A 股及港股的综合股票分析工具，提供实时行情、技术分析、资金流向、行业对比、智能预警等多维度分析能力。
version: 2.0.0
author: crabpaw-tool-evolution
type: builtin-tool
generatedAt: "2026-06-17T17:16:25.466Z"
metadata:
  crabpaw:
    capabilities: [data_analysis]
---

# StockQuery

面向中国 A 股及港股的综合股票分析工具，提供实时行情、技术分析、资金流向、行业对比、智能预警等多维度分析能力。

## 运行状态

| 指标 | 值 |
|------|-----|
| 总调用 | 9 |
| 成功率 | 88.9% |
| 平均耗时 | 35119ms |
| 连续失败 | 0 |
| 最后执行 | 2026-06-17T17:16:25.460Z |

## 能力列表

- 实时行情查询（东方财富 API）
- 技术指标分析（RSI/MA/MACD/布林带）
- 主力资金流向趋势（10日）
- 行业横向对比分析
- 技术形态自动识别（7种形态）
- 智能预警系统（多级风险提示）
- 融资融券数据
- 北向资金流向
- 多股票并行查询
- 三级降级机制（东方财富→FlashClaw→WebSearch）

## 数据源架构

| 数据源 | 说明 | 优先级 |
|--------|------|--------|
| eastmoney_quote | 东方财富实时行情 | P1 |
| eastmoney_kline | 东方财富K线数据 | P2 |
| eastmoney_search | 东方财富股票搜索 | P3 |
| sina_kline | 新浪K线数据 | P4 |
| eastmoney_margin | 东方财富融资融券 | P5 |
| eastmoney_northflow | 东方财富北向资金 | P6 |
| flashclaw_python | FlashClaw Python脚本 | P7 |
| websearch_fallback | 网络搜索降级 | P8 |


## 降级策略

1. 主数据源失败 → 自动切换备选数据源
2. 所有 API 不可用 → FlashClaw Python 脚本
3. Python 脚本不可用 → WebSearch 网络搜索
4. 数据源质量评分 < 0.2 → 自动标记为废弃

## 已知错误模式

| 错误模式 | 次数 | 修复动作 |
|----------|------|----------|
| OTHER | 1 | 调查中 |

## 进化记录
- [2026-06-17] FIX: 数据源 enterprise_aiqicha 质量评分 0.20 过低 → deprecate_source

- 融资融券 API 已从 RPT_RZRQ_LSHJ 迁移到 RPT_RZRQ_DETIAL
- 新增行业对比、资金趋势、技术形态、智能预警四大维度
- 支持多股票并行查询（逗号/顿号/和 分隔）

## 自修复机制

- 连续失败 3 次 → 触发紧急修复（API 切换/参数调整）
- 成功率低于 60% → 生成修复建议
- 特定错误模式高频出现 → 针对性修复
- 数据源质量评分过低 → 自动废弃并切换
- 高频使用且成功率高 → 生成增强建议

## 风险免责声明

分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。