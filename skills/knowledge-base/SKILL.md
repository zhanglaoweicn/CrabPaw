---
name: knowledge-base
version: 1.0.0
description: "个人知识库管理，从对话、文档、网页提取知识点，自动分类打标签、语义检索、关联发现、知识图谱与定期回顾。当用户说“帮我记下来”“存到知识库”“查一下我之前存的资料”时使用。"
metadata:
  crabpaw:
    emoji: "🧠"
    category: productivity
    capabilities: [knowledge_management]
    triggers: [knowledge, wiki, notes, knowledge_base, second_brain, pkm]
    platforms: [linux, macos, windows]
---

# 🧠 知识库管理

## 概述

帮助构建和管理个人知识体系，实现信息的结构化存储和高效检索。

## 核心功能

| 功能 | 说明 |
|------|------|
| **知识录入** | 从对话、文档、网页中提取并结构化存储知识点 |
| **自动分类** | 根据内容自动分配标签和分类 |
| **关联发现** | 自动发现知识点之间的关联关系 |
| **智能检索** | 语义搜索+关键词搜索，支持中英文 |
| **知识图谱** | 可视化展示知识之间的关联 |
| **定期回顾** | 基于间隔重复算法的知识复习提醒 |

## 知识结构

```
knowledge-base/
  tech/          # 技术知识
  business/      # 业务知识
  projects/      # 项目相关
  learning/      # 学习笔记
  personal/      # 个人知识
```

## 使用方式

/kb add <内容>
/kb search <关键词>
/kb tag <知识ID> <标签>
/kb relate <ID1> <ID2>
/kb review
/kb export
