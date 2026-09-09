---
name: writing-plans
version: "1.0.0"
description: "写计划技能（Superpowers启发），把复杂任务拆成2-5分钟原子步骤，每步含文件路径、改动、验证与回滚。当用户要求规划方案、拆解任务或创建实施计划时使用。"
metadata:
  crabpaw:
    emoji: 📋
    category: development
    capabilities: [prompt_design]
    triggers:
      - 规划
      - 步骤
      - 计划
      - 拆分
      - 分解
      - plan
    priority: 5
    tags: [development, planning]
---

# 📋 写计划 — 原子任务分解

Superpowers 启发: 复杂任务必须拆成 2-5 分钟的原子步骤。

## 格式要求

每个步骤必须包含：

```
步骤 N: [一句话描述]
  文件: [具体文件路径，如 src/core/ai.js:1835]
  改动: [具体改什么，不超过 3 行描述]
  验证: [改完后如何确认正确，如 npm test / grep 检查 / 手动验证]
  回滚: [如果不对，如何撤销]
```

## 约束

- 每步 2-5 分钟 — 超过 5 分钟说明拆得不够细
- 每步改一个文件 — 尽量不改多个文件
- 步骤间有明确的依赖关系 — 标注哪些步骤可以并行
- 完成后逐条打勾

## 示例

```
步骤 1: 修复 BrowserControl action enum 不匹配
  文件: src/core/tool-contract.js:106
  改动: 将 action enum 从 camelCase 改为 snake_case
  验证: node -e "const c=require('./src/core/tool-contract'); console.log(c.BrowserControl.schema.properties.action.enum)"
  回滚: git checkout src/core/tool-contract.js

步骤 2: 验证修复是否生效
  文件: src/tools/browser-tools.js
  改动: 无改动，仅验证
  验证: npm test
  回滚: 无需回滚
```
