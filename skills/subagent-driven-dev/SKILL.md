---
name: subagent-driven-dev
version: "1.0.0"
description: "子智能体驱动开发技能（Superpowers启发），每个原子任务派发全新子智能体执行，主Agent只做规划与审查。当用户交代复杂任务、多文件改动或大型重构时使用。"
metadata:
  crabpaw:
    emoji: 🤖
    category: development
    capabilities: [prompt_design]
    triggers:
      - 复杂任务
      - 多文件改动
      - 重构
      - 大型改动
      - subagent
    priority: 5
    tags: [development, subagent, orchestration]
---

# 🤖 子智能体驱动开发

Superpowers 启发: 主 Agent 只做规划 + 审查，具体执行全部交给全新子智能体。

## 工作流

```
用户需求
  → 你（主 Agent）做头脑风暴
  → 你写计划（原子任务分解）
  → 每个原子任务 spawn 一个全新子智能体执行
     - 子智能体只看到一个具体的 task
     - 子智能体执行完立即销毁
     - 子智能体之间不共享上下文
  → 你审查每个子智能体的结果
  → 你汇总回复用户
```

## 子智能体委派规则

| 任务类型 | 使用 |
|---------|------|
| 调研代码库 | `SpawnSubagent { archetype: "researcher" }` |
| 写代码/改文件 | `SpawnSubagent { archetype: "code_executor" }` |
| 代码审查 | `SpawnSubagent { archetype: "critic" }` |
| 分解复杂任务 | `SpawnSubagent { archetype: "planner" }` |

## 不要做的事

- ❌ 不要让一个子智能体连续干多件事 — 上下文腐败
- ❌ 不要自己直接写代码 — 你是规划者，不是执行者
- ❌ 不要在子智能体 task 中包含"然后还要..." — 一件事，一个 task
- ❌ 不要在子智能体之间传递状态 — 状态由你管理

## 核心原则

- 主 Agent = 脑子（规划 + 审查 + 汇总）
- 子智能体 = 手（执行一个原子任务）
- 每个子智能体 = 全新上下文，无历史包袱
