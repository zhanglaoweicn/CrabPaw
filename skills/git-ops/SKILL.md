---
name: git-ops
version: 1.0.0
description: "Git 操作辅助，智能commit message、分支/PR管理、冲突解决、rebase/squash历史整理、状态查询。当用户要提交代码、创建PR、合并分支、解决冲突或整理提交历史时使用。"
metadata:
  crabpaw:
    emoji: "🔀"
    category: development
    capabilities: [git_operations]
    triggers: [git, commit, push, pull_request, branch, merge, rebase]
    platforms: [linux, macos, windows]
    priority: 3
    tags: [dev, git, version-control]
---

# 🔀 Git 操作

## 概述

智能 Git 操作辅助，理解项目上下文，提供安全可靠的版本控制操作。

## 核心能力

| 操作 | 说明 |
|------|------|
| **智能提交** | 自动分析变更生成规范的 commit message |
| **分支管理** | 创建/切换/合并/删除分支，冲突解决 |
| **PR 操作** | 创建 PR、添加描述、请求 Review |
| **历史整理** | rebase、squash、cherry-pick |
| **状态查询** | 查看 diff、log、blame、stash |

## Commit Message 规范

自动生成符合 Conventional Commits 规范的提交信息：

```
<type>(<scope>): <subject>
<body>
<footer>
```

类型：feat / fix / refactor / perf / style / docs / test / chore / ci

## 安全检查

- 推送前检查是否包含敏感信息（API Key、密码等）
- force push 需要二次确认
- 分支删除前检查是否已合并
- 操作前自动 stash 未提交变更

## 使用方式

/git status
/git commit
/git push
/git pr create
/git branch create <name>
/git merge <branch>
