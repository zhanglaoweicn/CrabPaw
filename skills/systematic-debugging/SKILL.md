---
name: systematic-debugging
version: "1.0.0"
description: "系统化调试技能（Superpowers启发），按复现→隔离→修复→验证四阶段排查，禁止猜测式修复。当出现bug、报错、测试失败或异常行为需要找根因时使用。"
metadata:
  crabpaw:
    emoji: 🔍
    category: development
    capabilities: [code_review]
    triggers:
      - bug
      - 报错
      - 失败
      - 调试
      - debug
    priority: 5
    tags: [development, debugging]
---

# 🔍 系统化调试 — 4 阶段法

Superpowers 启发: 不允许猜测式修复。

## Phase 1: 复现
- 最小可复现步骤描述 bug
- 确认 bug 在当前代码上真实存在

## Phase 2: 隔离
- 二分法缩小范围
- 找到最小触发条件
- 识别根因，不是症状

## Phase 3: 修复
- 先写会失败的测试
- 实施最小修复
- 确认测试变绿

## Phase 4: 验证
- `npm test` — 完整测试套件
- `npm run eval` — Harness 合规
- `npm run eval:regression` — 回归检查

## 核心原则
- 严禁猜测式修复
- 先写测试，再修代码
- 最小修复行数
