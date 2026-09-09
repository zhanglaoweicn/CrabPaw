---
name: presentation-builder
version: "1.0.0"
description: "智能PPT生成技能，自动分析主题→生成大纲→推断样式→路由到PPTX或HTML渲染，支持18种场景风格。当用户说「帮我做个PPT」「生成演示文稿」「写演讲稿」时使用。"
metadata:
  crabpaw:
    emoji: 📊
    category: document
    capabilities: [document_generation, presentation]
    triggers:
      - 做PPT
      - 生成PPT
      - 演示文稿
      - 做一份
      - 演讲稿
      - 汇报PPT
    priority: 5
    tags: [presentation, ppt, slides, office]
---

# 📊 Presentation Builder — 智能 PPT 生成

## 工作流程

### 1. 分析
自动分析主题 → 推断风格 → 推断页数 → 检测输出格式

### 2. 大纲
生成幻灯片大纲结构

### 3. 指令
输出执行指令，LLM 按指令填充内容并调用渲染工具

## 触发词
- 做一份XX的PPT
- 生成演示文稿
- 演讲稿PPT
- 汇报PPT
