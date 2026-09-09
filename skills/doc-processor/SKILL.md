---
name: doc-processor
version: 1.1.0
description: "文档处理：Word/PDF/Excel互转、合同关键信息提取（金额/日期/签约方/证件号）、表格检测、格式清洗与批量处理。当用户给出PDF/Word/Excel文档说“读取/转换/提取关键内容”时使用。"
metadata:
  crabpaw:
    emoji: "📄"
    category: office
    capabilities: [data_analysis, document_conversion]
    triggers: [document, doc, pdf, contract, convert, format, extract, file_process]
    platforms: [linux, macos, windows]
    requires: [doc_read, pdf_extract, doc_to_markdown, xlsx_query, bash]
---

# 📄 文档处理

## 概述

多格式文档的读取、转换、提取和分析。PDF 支持深度解析（文本+表格+关键字段）。

## 核心功能

### 1. PDF 深度解析
使用 pdf_extract 工具可提取：
- 全文文本（按页分割）
- 元数据（页数、作者、创建时间）
- 自动检测并提取表格
- 关键字段提取：
  - 金额（人民币/美元/欧元，含大写）
  - 日期（合同签署日/到期日）
  - 合同编号
  - 身份证号 / 统一社会信用代码
  - 手机号 / 邮箱

使用：/doc extract <合同PDF>

### 2. 格式互转
- Word -> PDF、Word -> Markdown
- Excel -> CSV/JSON
- PDF -> Markdown（含表格保留）

### 3. 合同信息提取
自动识别并提取合同关键信息：
- 签约双方名称
- 合同金额
- 签署日期 / 生效日期 / 到期日期
- 关键条款摘要
- 与标准模板的差异对比

### 4. 格式清洗
- 去除多余空格/空行
- 统一字体和字号
- 标题层级规范化
- 表格格式统一
