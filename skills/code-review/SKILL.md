---
name: code-review
version: 1.0.0
description: "系统化代码审查，覆盖安全性、正确性、性能、可维护性、代码风格等维度，输出审查报告与改进建议。当用户说“帮我审查这段代码”“Review一下这个PR”“看看有没有安全问题”时使用。"
metadata:
  crabpaw:
    emoji: "🔍"
    category: development
    capabilities: [code_review]
    triggers: [code_review, pr_review, code_check, code_quality]
    platforms: [linux, macos, windows]
    priority: 3
    tags: [dev, review, quality]
---

# 🔍 代码审查

## 概述

系统化代码审查技能，帮助发现代码中的问题并提供改进建议。

## 审查维度

| 维度 | 关注点 | 权重 |
|------|--------|------|
| **安全性** | SQL注入、XSS、敏感信息泄露、权限校验 | 最高 |
| **正确性** | 逻辑错误、边界条件、空值处理、类型安全 | 高 |
| **性能** | 算法复杂度、内存泄漏、不必要的IO、缓存策略 | 中 |
| **可维护性** | 代码重复、命名规范、模块耦合、注释质量 | 中 |
| **代码风格** | 格式一致性、最佳实践、语言惯用法 | 低 |

## 审查流程

1. 理解代码变更的意图和上下文
2. 逐文件扫描潜在问题
3. 按严重程度分类（Critical / Major / Minor / Suggestion）
4. 为每个问题提供具体的修改建议和代码示例
5. 给出整体评价和改进路线图

## 使用方式

/code-review [file-path]
/code-review --diff [branch-name]
/code-review --pr [pr-number]

## 输出格式

### Critical（需立即修复）
- 问题描述 + 修复建议

### Major（建议修复）

### Minor（可选优化）

### Suggestions（参考建议）

## 注意事项

- 审查范围包括前端（React/Vue/HTML/CSS）和后端（Node/Python/Go）
- 会检查依赖安全漏洞
- 可配置审查规则的严格程度
