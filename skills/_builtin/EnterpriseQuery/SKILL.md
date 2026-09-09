---
name: EnterpriseQuery
description: 内置工具 EnterpriseQuery
version: 2.0.0
author: crabpaw-tool-evolution
type: builtin-tool
generatedAt: "2026-06-12T08:35:03.838Z"
metadata:
  crabpaw:
    capabilities: [data_analysis]
---

# EnterpriseQuery

内置工具 EnterpriseQuery

## 运行状态

| 指标 | 值 |
|------|-----|
| 总调用 | 51 |
| 成功率 | 70.6% |
| 平均耗时 | 107862ms |
| 连续失败 | 0 |
| 最后执行 | 2026-06-12T08:35:03.832Z |

## 能力列表

- 执行工具功能

## 数据源架构

暂无数据源信息

## 降级策略

1. 主数据源失败 → 自动切换备选数据源
2. 所有 API 不可用 → FlashClaw Python 脚本
3. Python 脚本不可用 → WebSearch 网络搜索
4. 数据源质量评分 < 0.2 → 自动标记为废弃

## 已知错误模式

| 错误模式 | 次数 | 修复动作 |
|----------|------|----------|
| OTHER | 15 | 调查中 |



## 自修复机制

- 连续失败 3 次 → 触发紧急修复（API 切换/参数调整）
- 成功率低于 60% → 生成修复建议
- 特定错误模式高频出现 → 针对性修复
- 数据源质量评分过低 → 自动废弃并切换
- 高频使用且成功率高 → 生成增强建议

## 风险免责声明

分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。

## 进化记录
- [2026-06-12] FIX: 数据源 enterprise_aiqicha 质量评分 0.20 过低 → deprecate_source
