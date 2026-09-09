# Domain Skills — 领域技能目录

> Browser Harness 启发: Agent 在熟练操作一个站点后，自动生成可复用的领域技能。

## 什么是领域技能？

领域技能是 Agent 为特定网站/服务生成的操作手册。每个文件包含：
- 关键选择器/aria-label
- 常见工作流程
- 边界情况和陷阱
- URL 模式和导航提示

## 技能生命周期

```
Agent 成功完成任务 → 自动生成 domain skill (status: active)
  → 每30天未使用 → status: stale
  → 每60天未使用 → status: archived
  → 被Agent再次使用时 → 验证选择器是否仍有效
    → 无效 → Agent 自动修复
    → 有效 → 继续使用
```

## 目录结构

```
skills/domain/
  ├── README.md           ← 本文件
  ├── _template.md        ← 技能模板
  ├── github/             ← GitHub 领域技能
  │   ├── repo-actions.md
  │   └── scraping.md
  ├── linkedin/           ← LinkedIn 领域技能
  └── ...                 ← Agent 自动生成更多
```

## 如何贡献

**不要手工编写这些文件。** 让 Agent 在成功完成任务后自动生成。
Agent 会提取真正有效的选择器和工作流，而不是猜测的。

如果你想帮助改进某个领域技能：
1. 让 Agent 操作该网站
2. Agent 会自动发现并记录有效的选择器
3. Agent 会更新或创建领域技能文件
