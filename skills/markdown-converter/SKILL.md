---
name: markdown-converter
version: "1.0.0"
description: "文档转Markdown，用uvx markitdown把PDF、Word、Excel、PPT、HTML、图片等转成Markdown供LLM处理，无需安装。当用户给文档文件说“转成markdown”“提取成纯文本”时使用。"
metadata:
  crabpaw:
    emoji: 📝
    category: document
    capabilities: [document_conversion]
    requires:
      bins:
        - uvx
---

# Markdown Converter

将多种文档格式转换为 Markdown，便于 LLM 处理和分析。

## ⚠️ 依赖要求

此技能需要 `uvx`（Python 包管理器）：

```bash
# 安装 uv
pip install uv

# 或使用 pipx
pipx install uv

# 验证安装
uvx --version
```

**注意**：`markitdown` 由 `uvx` 自动管理，无需单独安装。

## 🎯 支持的格式

| 类型 | 格式 | 说明 |
|------|------|------|
| **文档** | PDF, Word (.docx), PowerPoint (.pptx) | 保持结构 |
| **表格** | Excel (.xlsx, .xls) | 表格转 Markdown 表格 |
| **网页** | HTML | 提取正文内容 |
| **数据** | CSV, JSON, XML | 结构化输出 |
| **媒体** | 图片 (EXIF + OCR), 音频 (转录) | 提取文本信息 |
| **其他** | ZIP, YouTube URL, EPub | 遍历或下载处理 |

## 📖 基本用法

### 命令行使用

```bash
# 转换并输出到终端
uvx markitdown input.pdf

# 保存到文件
uvx markitdown input.pdf -o output.md

# 使用管道
uvx markitdown input.docx > output.md

# 从标准输入
cat input.pdf | uvx markitdown
```

### 常见转换示例

```bash
# PDF 转 Markdown
uvx markitdown document.pdf -o document.md

# Word 转 Markdown
uvx markitdown report.docx -o report.md

# Excel 转 Markdown
uvx markitdown data.xlsx -o data.md

# HTML 转 Markdown
uvx markitdown page.html -o page.md

# 图片 OCR
uvx markitdown scan.png -o scan.md

# 音频转录
uvx markitdown audio.mp3 -o transcript.md
```

## 🔧 高级选项

### PDF 增强（Azure Document Intelligence）

对于复杂 PDF，可使用 Azure Document Intelligence：

```bash
uvx markitdown scan.pdf -d -e "https://your-resource.cognitiveservices.azure.com/"
```

### 批量处理

```powershell
# PowerShell 批量转换
Get-ChildItem *.pdf | ForEach-Object {
    uvx markitdown $_.Name -o "$($_.BaseName).md"
}
```

```bash
# Bash 批量转换
for f in *.pdf; do
    uvx markitdown "$f" -o "${f%.pdf}.md"
done
```

## 📋 输出特性

转换后的 Markdown 保持：

- **标题层级**：H1-H6 对应文档结构
- **表格**：转换为 Markdown 表格格式
- **列表**：有序和无序列表
- **链接**：保留超链接
- **代码块**：保留代码格式
- **图片**：转换为图片链接或描述

## 🎯 使用场景

### 文档分析

```bash
# 将 PDF 报告转为 Markdown 供 LLM 分析
uvx markitdown report.pdf | llm "总结这份报告的要点"
```

### 内容提取

```bash
# 从网页提取正文
uvx markitdown page.html > content.md
```

### 数据处理

```bash
# 将 Excel 转为 Markdown 表格
uvx markitdown data.xlsx > table.md
```

### OCR 识别

```bash
# 扫描件文字识别
uvx markitdown scanned_document.png -o text.md
```

## 💡 最佳实践

### 1. 选择正确的输出方式

```bash
# 小文件：直接输出
uvx markitdown small.pdf

# 大文件：保存到文件
uvx markitdown large.pdf -o large.md
```

### 2. 处理复杂 PDF

```bash
# 普通 PDF
uvx markitdown simple.pdf

# 扫描件 PDF（需要 OCR）
uvx markitdown scanned.pdf -d

# 复杂排版 PDF（使用 Azure）
uvx markitdown complex.pdf -d -e "https://your-azure-endpoint/"
```

### 3. 链式处理

```bash
# 转换后直接处理
uvx markitdown input.pdf | your-processing-command
```

## 🔍 与其他技能配合

| 技能 | 配合方式 |
|------|----------|
| **pdf-generator** | 先用本技能转 Markdown，再用 pdf-generator 生成新 PDF |
| **pdf-smart-tool-cn** | PDF 处理后用本技能提取文本 |
| **summarize-pro** | 转换后用 summarize-pro 生成摘要 |

## ⚠️ 注意事项

1. **首次运行较慢**：uvx 需要缓存依赖，后续运行更快
2. **PDF 质量**：扫描件 PDF 需要启用 OCR 选项
3. **大文件**：建议保存到文件而非输出到终端
4. **网络需求**：YouTube URL 需要网络连接

## 📊 性能参考

| 文件类型 | 大小 | 转换时间 |
|----------|------|----------|
| Word 文档 | 1MB | ~2秒 |
| PDF 文档 | 5MB | ~5秒 |
| Excel 表格 | 2MB | ~3秒 |
| 图片 OCR | 500KB | ~10秒 |

---

**让文档转换变得简单 📝**
