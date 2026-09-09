---
name: word-docx
version: "1.1.0"
description: "Word文档技能，创建、检查、编辑DOCX，覆盖样式、修订追踪、批注、表格、分节、一键美化，含中国公文与商务规范。当用户要写Word文档、Markdown转Word或起草公文时使用。"
metadata:
  crabpaw:
    emoji: "📘"
    category: document
    capabilities: [document_generation]
    triggers:
    priority: 4
    tags: [office, document, word]
      - word
      - docx
      - document_format
      - beautify_doc
      - official_document
    platforms: [linux, macos, windows]
---

# 📘 Word 文档技能

## 概述

创建、编辑、美化 Word 文档的全流程技能，覆盖从空白文档到专业排版。

## 核心能力

### 1. 创建文档
- 从 Markdown 创建（通过 MarkdownToWord 工具）
- 从模板创建（商务/公文/简历/报告）
- 从 AI 生成的内容直接输出 docx

#### ⭐ 原生生成（executor create 操作，无需 Python）

```
execute({ action: "create", title: "文档标题", content: "Markdown 内容（# 标题 / - 列表 / | 表格 | / ``` 代码 ``` / 段落）" })
→ { success: true, docxPath, url, message }
```

- 基于 docx 库原生生成，无需 Python/python-docx
- content 支持 Markdown 简化语法，自动排版（居中大标题、标题层级、列表、表格）
- 输出路径可用 `outputPath` 指定，默认生成到数据目录

### 2. 编辑文档
- 样式管理：标题/正文/引用/代码块
- 编号与列表：多级编号、自动编号、项目符号
- 表格操作：创建、合并单元格、样式
- 修订追踪：开启/关闭/接受/拒绝
- 批注：添加、回复、删除
- 分节和分页控制

### 3. 一键美化
支持以下预设美化方案：

| 模板 | 适用场景 | 效果 |
|------|---------|------|
| 商务报告 | 项目报告/商业计划书 | 深蓝标题、专业间距、A4页眉 |
| 中国公文 | 红头文件/通知/请示 | 红色标题、仿宋正文、标准格式 |
| 学术论文 | 论文/研究报告 | 宋体正文、标准行距、引用格式 |
| 简约现代 | 一般文档/备忘录 | 无衬线字体、宽松间距、清爽布局 |

使用方式：
/word beautify <文件路径> --style 商务报告
/word beautify <文件路径> --style 中国公文

### 4. 格式检查
- 中英文混排检查（中英文之间添加空格）
- 标点符号统一（中英文标点不混用）
- 字体一致性检查
- 标题层级合理性检查

## 中国公文格式规范

- 标题：方正小标宋简体，二号，居中
- 一级标题：黑体，三号
- 二级标题：楷体，三号，加粗
- 正文：仿宋，三号
- 行距：固定值 28 磅
- 页边距：上 3.7cm，下 3.5cm，左 2.8cm，右 2.6cm
- 发文字号：仿宋，三号，居中
- 红色分割线（红头文件）

## 商务文档规范

- 标题：微软雅黑或 Arial，16-18pt，深蓝色
- 正文：微软雅黑或 Calibri，11pt
- 行距：1.5 倍
- 页边距：标准（2.54cm）
- 页眉：公司名称 + 文档类型
- 页脚：页码居中
