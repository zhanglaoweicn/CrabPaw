---
name: pdf-to-word-docx
version: "1.1.0"
description: "PDF/图片格式转换技能，基于ComPDFKit把PDF和图片转成Word/Excel/PPT/HTML等10种格式，含OCR，试用License限200次。当用户说「把这个PDF转成Word」「PDF转Excel」时使用。"
metadata:
  crabpaw:
    emoji: 📑
    category: document
    capabilities: [document_conversion]
    triggers:
      - pdf转word
      - pdf转docx
      - pdf转换
      - pdf-to-word
      - pdf-to-excel
      - pdf-to-ppt
      - pdf转excel
      - pdf转ppt
      - pdf转html
      - pdf转图片
      - pdf转markdown
      - 图片转word
      - OCR
---

# PDF/图片格式转换技能

将 PDF 和图片文件转换为 10 种可编辑格式，基于 ComPDFKit Conversion SDK，支持 AI 布局分析和多语言 OCR。

## 何时使用

- "把这个 PDF 转成 Word"
- "PDF 转 Excel，保留表格"
- "把这份报告转成可编辑的 DOCX"
- "PDF 转 PPT"
- "提取 PDF 中的文字"
- "把图片转成 Word"
- "PDF 转 Markdown"

## 支持的转换格式

| 输出格式 | 命令参数 | 输出文件 |
|----------|----------|----------|
| Word | `word` | `.docx` |
| Excel | `excel` | `.xlsx` |
| PowerPoint | `ppt` | `.pptx` |
| HTML | `html` | HTML 目录 |
| RTF | `rtf` | `.rtf` |
| 图片 | `image` | `.jpg/.png/...` |
| 纯文本 | `txt` | `.txt` |
| JSON | `json` | `.json` |
| Markdown | `markdown` | `.md` |
| CSV | `csv` | `.csv` |

## 前置条件

### 1. 安装 SDK

```bash
pip install ComPDFKitConversion
```

### 2. License 文件

首次运行时自动从 ComPDF 服务器下载 `license.xml` 到 `scripts/` 目录。

**⚠️ 试用限制：试用 License 最多 200 次转换。** 超出后需购买正式 License：
- 购买地址：https://www.compdf.com/contact-sales
- 购买后将自定义 `license.xml` 放入 `scripts/` 目录覆盖即可

### 3. AI 模型（~525MB）

首次使用 AI 布局分析或 OCR 时自动下载 `documentai.model` 到 `scripts/` 目录。

如网络不通，可手动放置模型文件，或设置环境变量：
```bash
set COMPDF_DOCUMENT_AI_MODEL=D:\path\to\documentai.model
```

## 核心工作流

### 基本转换

```bash
python scripts/pdf-to-word-docx.py <格式> <输入文件> <输出文件>
```

### PDF 转 Word（默认启用 AI 布局分析）

```bash
python scripts/pdf-to-word-docx.py word input.pdf output.docx
```

### PDF 转 Excel（保留表格）

```bash
python scripts/pdf-to-word-docx.py excel input.pdf output.xlsx
```

### PDF 转 PPT

```bash
python scripts/pdf-to-word-docx.py ppt input.pdf output.pptx
```

### PDF 转 Markdown

```bash
python scripts/pdf-to-word-docx.py markdown input.pdf output.md
```

### 图片转 Word（OCR 自动启用）

```bash
python scripts/pdf-to-word-docx.py word input.png output.docx --ocr-language chinese
```

### PDF 转 HTML（多页带书签）

```bash
python scripts/pdf-to-word-docx.py html input.pdf output_dir --html-option multiple-page-with-bookmark
```

### 启用 OCR（多语言）

```bash
python scripts/pdf-to-word-docx.py word input.pdf output.docx --enable-ocr --ocr-language chinese english japanese
```

### 指定页面范围

```bash
python scripts/pdf-to-word-docx.py excel input.pdf output.xlsx --page-ranges "1-3,5"
```

## 智能默认值

| 触发条件 | 自动行为 | 可覆盖 |
|----------|----------|--------|
| 输入为图片 | 自动启用 `--enable-ocr` | 否 |
| 输出为 HTML | 自动设置 `--page-layout-mode box` | 是，显式传 `--page-layout-mode flow` |

## 常用参数

### 通用参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--source-type` | `auto` | 输入类型：`auto`/`pdf`/`image` |
| `--password` | `""` | PDF 打开密码 |
| `--page-ranges` | 无 | 页面范围，如 `1-3,5` |
| `--enable-ocr` | False | 启用 OCR（图片输入自动启用） |
| `--ocr-language` | `auto` | OCR 语言，可指定多个：`chinese english` |
| `--enable-ai-layout` | True | AI 布局分析（用 `--no-enable-ai-layout` 关闭） |

### OCR 支持语言

`auto` / `chinese` / `chinese-tra` / `english` / `korean` / `japanese` / `latin` / `cyrillic` / `arabic` / `thai` / `greek` 等 16 种

### Excel 专用参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--excel-all-content` | False | 包含所有内容 |
| `--excel-worksheet-option` | `for-table` | 工作表拆分：`for-table`/`for-page`/`for-document` |

### Word 专用参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--page-layout-mode` | `flow` | 页面布局：`box`（框式）/ `flow`（流式） |
| `--contain-image` | True | 保留图片（`--no-contain-image` 关闭） |
| `--contain-annotation` | True | 保留批注（`--no-contain-annotation` 关闭） |

## 试用 License 使用计数

每次成功转换后，脚本会输出当前使用计数：
```
Trial license: 5/200 conversions used, 195 remaining.
```

达到 200 次上限时拒绝转换并提示购买正式 License。

## 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| License 认证失败 | 试用过期或网络不通 | 购买正式 License 或检查网络 |
| 模型下载失败 | 网络不通 | 手动放置 `documentai.model` |
| 输入文件不存在 | 路径错误 | 检查文件路径 |
| SDK 未安装 | 缺少依赖 | `pip install ComPDFKitConversion` |

## 交付清单

- [ ] `ComPDFKitConversion` 已安装
- [ ] `license.xml` 已下载或手动放置
- [ ] 输出文件生成成功
- [ ] 转换结果视觉检查（表格/布局/图片保留）
- [ ] OCR 结果文字准确性检查（如启用）

## 相关技能

- `pdf-generator` — 生成 PDF
- `word-docx` — Word 文档编辑
- `excel-xlsx` — Excel 工作簿编辑
- `powerpoint-pptx` — PowerPoint 演示文稿编辑
