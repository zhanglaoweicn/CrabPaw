---
name: brainstorming
version: "1.0.0"
description: "编码前的5个苏格拉底式追问：问题是什么、最简单的方案、会破坏什么、如何验证成功、错了怎么回滚。当用户提出“想做个功能/设计个方案/怎么实现”但需求还没想清楚时使用。"
metadata:
  crabpaw:
    emoji: 🧠
    category: development
    capabilities: [prompt_design]
    triggers:
      - 设计
      - 方案
      - 架构
      - 怎么做
      - brainstorm
    priority: 5
    tags: [development, planning, design]
---

# 🧠 头脑风暴 — 编码前追问

Superpowers 启发: 在写任何代码之前，先回答 5 个关键问题。

## 5 个问题

1. **问题是什么？** — 描述具体问题，不是解决方案
2. **最简单的方案？** — 限制在 10 行代码内
3. **会破坏什么？** — 列出所有受影响的功能和文件
4. **如何验证成功？** — 具体测试用例
5. **如果错了？** — 回滚方案

## 核心原则

- 不跳步 — 全部回答完才能写代码
- 先简后繁 — 最简单的方案优先
- 写下来 — 口头不算，必须输出文字
