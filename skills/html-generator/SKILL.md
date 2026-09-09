---
name: html-generator
version: "2.0.0"
description: "独立HTML报告/网页生成，融合UI/UX Pro Max设计智能，单文件零外部依赖，10种设计风格、响应式、暗色模式、WCAG AA、打印优化。当用户要报告/仪表盘/落地页/产品页网页或“把这数据做成网页”时使用。"
metadata:
  crabpaw:
    emoji: 🌐
    category: document
    capabilities: [document_generation]
    requires:
      npm:
        - marked
        - highlight.js
    priority: 3
    tags: [html, report, web, standalone, design]
---

# HTML Generator v2 — 专业级网页生成

从 Markdown / 数据 / 图表生成独立可交付的单文件 HTML。融合 UI/UX Pro Max 设计智能。

## 快速参考

| 项目 | 说明 |
|------|------|
| 输入 | Markdown / JSON 数据 / Chart 配置 |
| 输出 | 单文件 HTML（零外部依赖，CDN图表库除外） |
| 设计风格 | 10种：Minimalism / Glassmorphism / Dark Mode / Bento Grid / Flat Design / Brutalism / Neumorphism / Claymorphism / Skeuomorphism / Gradient Modern |
| 适用范围 | 项目报告、数据仪表盘、落地页、产品页、SaaS界面、周报 |

## 设计系统（UI/UX Pro Max 注入）

### 风格选择指南

| 风格 | 特征 | 适用场景 |
|------|------|---------|
| **Minimalism** | 大量留白、简洁线条、克制用色 | 企业报告、技术文档 |
| **Glassmorphism** | 半透明、背景模糊、层次感 | 现代仪表盘、SaaS |
| **Dark Mode** | 深色背景、低亮度、高对比 | 数据密集、夜间使用 |
| **Bento Grid** | 卡片网格、圆角、模块化 | 仪表盘、产品展示 |
| **Flat Design** | 无阴影、纯色、清晰边界 | 简单报告、移动优先 |
| **Gradient Modern** | 渐变背景、鲜艳色彩 | 营销页面、落地页 |

### 内置调色板

选择风格后自动匹配。核心组合：

| 风格 | 主色 | 辅色 | 背景 | 文字 |
|------|------|------|------|------|
| Minimalism | #2563EB | #3B82F6 | #FFFFFF | #1F2937 |
| Glassmorphism | #6366F1 | #818CF8 | rgba(255,255,255,0.1) | #F1F5F9 |
| Dark Mode | #60A5FA | #3B82F6 | #0F172A | #E2E8F0 |
| Bento Grid | #8B5CF6 | #A78BFA | #F8FAFC | #1E293B |
| Gradient Modern | #EC4899→#F97316 | #8B5CF6 | #FAFAFA | #18181B |

### 字体配对

| 配对 | 标题 | 正文 | 用途 |
|------|------|------|------|
| Modern Professional | Inter 600 | Inter 400 | 通用报告 |
| Tech Startup | Space Grotesk 700 | DM Sans 400 | SaaS、科技 |
| Classic Editorial | Playfair Display 700 | Lora 400 | 长文、博客 |
| Clean Swiss | Geist 600 | Geist 400 | 仪表盘、数据 |
| Warm Humanist | Cabinet Grotesk 800 | Inter 400 | 营销、品牌 |

默认使用 Modern Professional (Inter)。通过 Google Fonts CDN 加载。

### 间距系统

4pt 递增：4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64 / 96

### 圆角系统

4px / 8px / 12px / 16px / 24px / 9999px(全圆)

---

## 可访问性（必须遵守）

- **对比度**: 文字 4.5:1，大文字 3:1
- **焦点环**: 2-3px 可见边框
- **触摸目标**: 最小 44×44px
- **颜色不只是装饰**: 状态必须同时用图标/文字
- **支持 prefers-reduced-motion**: 减少动画
- **语义 HTML**: 正确使用 h1-h6 / nav / main / footer

---

## 响应式布局

```css
/* 系统断点 */
@media (max-width: 768px)  { /* 移动优先 — 单列 */ }
@media (min-width: 769px)  { /* 平板 — 双列 */ }
@media (min-width: 1025px) { /* 桌面 — 多列 */ }
@media (min-width: 1441px) { /* 宽屏 — 最大宽度容器 */ }

/* 移动端基础 */
body { font-size: 16px; line-height: 1.6; }
.container { max-width: 960px; margin: 0 auto; padding: 0 16px; }
```

---

## 动画（克制）

- 微交互: 150-300ms ease-out
- 页面加载: 淡入 + 上移 8px
- 悬停: 颜色/阴影过渡 200ms
- 暗色切换: transition 300ms
- **不**: 自动播放、无限循环、弹跳、旋转

---

## 模板

### report — 技术报告

```
┌──────────────────────────────┐
│  🔵 标题 + 日期               │
├──────────────────────────────┤
│  📑 侧边栏目录 (固定)         │
├──────────────────────────────┤
│  📊 主内容区:                 │
│    H2→图表→H2→表格→H2→代码   │
├──────────────────────────────┤
│  © 页脚                       │
└──────────────────────────────┘
```

### dashboard — 数据仪表盘

```
┌─────────────────────────────────────┐
│  🌙 暗色模式 ｜ 📊 标题              │
├─────────────────────────────────────┤
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐       │
│  │KPI1│ │KPI2│ │KPI3│ │KPI4│       │
│  └────┘ └────┘ └────┘ └────┘       │
│  ┌──────────┐ ┌──────────┐          │
│  │ 图表1     │ │ 图表2     │         │
│  └──────────┘ └──────────┘          │
│  ┌──────────────────────┐           │
│  │ 表格                  │          │
│  └──────────────────────┘           │
└─────────────────────────────────────┘
```

---

## 核心规则

### 1. 单文件独立
- CSS 内联，JS 内联（图表 CDN 除外）
- 图片 <100KB 用 Base64
- 字体用 Google Fonts CDN

### 2. 设计系统驱动
- 使用内置调色板（不用裸 hex）
- 使用字体配对（不一致混搭）
- 使用间距系统（不随意 px 值）

### 3. 移动优先
- 先写移动端 CSS，再用 min-width 扩展
- 表格用横向滚动
- 图片 max-width: 100%

### 4. 暗色模式
```css
@media (prefers-color-scheme: dark) {
  :root { /* 自动切换 CSS 变量 */ }
}
```

### 5. 打印优化
```css
@media print {
  nav, .no-print { display: none; }
  body { font-size: 12pt; }
  h2 { page-break-before: always; }
}
```

---

## 依赖

```bash
npm install marked highlight.js
```

---

## 工作流程

1. **选择风格** — 根据用途选 Minimalism/Glassmorphism/Dark Mode/Bento Grid
2. **生成内容** — Markdown → marked.parse() → HTML body
3. **注入模板** — 替换 {{TITLE}} {{BODY}} {{DATE}} + 自动注入调色板CSS + 字体CDN
4. **输出文件** — 写入 .html，可浏览器直接打开
