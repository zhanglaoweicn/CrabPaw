---
name: ui-ux-pro-max
version: "1.0.0"
description: "设计系统推荐技能，按行业/用途输出结构化设计规范JSON（风格、调色板、字体配对、间距、组件规格）。当用户做网页/App想定设计风格、选配色字体或搭UI规范时使用。"
metadata:
  crabpaw:
    emoji: 🎨
    category: design
    priority: 4
    tags: [design, ui, ux, color, typography, layout, style]
---

# 🎨 UI/UX Pro Max — 设计系统推荐引擎

为网页/应用提供确定性的设计系统推荐。输入行业+用途，输出完整的结构化设计规范。

## 行业预设

| 行业 | 推荐风格 | 推荐调色板 | 推荐字体 |
|------|---------|-----------|---------|
| 宠物医疗 | Warm Friendly | Medical Teal | Warm Friendly |
| 科技 SaaS | Glassmorphism | Ocean Blue | Tech Startup |
| 医疗健康 | Minimalism | Medical Teal | Modern Professional |
| 教育 | Claymorphism | Royal Purple | Rounded Soft |
| 金融保险 | Minimalism | Dark Navy | Modern Professional |
| 电商 | Gradient Modern | Rose Gold | Warm Friendly |

## 工作流程

1. 接收输入 → 匹配行业预设 → 2. 返回设计系统 JSON → 3. 下游技能消费此输出
