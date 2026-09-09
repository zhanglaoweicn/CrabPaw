---
name: pdf-generator
description: "生成专业PDF文档技能，从Markdown、HTML、数据或代码生成报告、发票、合同等，提供模板与打印优化。当用户要生成PDF、把文档导出成PDF或要PDF报表时使用。"
version: "1.0.1"
metadata:
  crabpaw:
    emoji: 📄
    category: document
    capabilities: [document_generation]
    requires:
    priority: 3
    tags: [office, pdf, document]
      - python3
---

# PDF Generator

从多种来源生成专业 PDF 文档。

## 快速参考

| 主题 | 说明 |
|------|------|
| 工具选择 | weasyprint (HTML), pandoc (Markdown), reportlab (数据) |
| 文档模板 | 发票、报告、合同、证书 |
| 高级操作 | 合并、拆分、水印 |

## ⭐ 原生执行器（首选，无需 Python）

本技能自带 Node.js 执行器（`executor.js`，基于 pdf-lib，嵌入中文字体）：

```
execute({ title: "文档标题", content: "Markdown 内容（# 标题 / - 列表 / | 表格 | / 段落）" })
→ { success: true, pdfPath, url, message }
```

- 直接调用执行器即可生成 PDF，无需 weasyprint/pandoc/Python
- 内容用 Markdown 简化语法：`# 标题`、`- 列表项`、`| a | b |` 表格、``` 代码块 ```、普通段落
- 输出路径可用 `outputPath` 指定，默认生成到数据目录

以下 weasyprint/pandoc 指南为备用方案（复杂排版需求时使用）。

## 工具选择指南

| 来源 | 推荐工具 | 原因 |
|------|----------|------|
| Markdown | pandoc | 原生支持、目录、模板 |
| HTML/CSS | weasyprint | 最佳 CSS 支持、无 LaTeX |
| 数据/JSON | reportlab | 编程控制、精确布局 |
| 简单文本 | fpdf2 | 轻量、快速 |

**默认推荐:** weasyprint 用于大多数 HTML 文档。

## 核心规则

### 1. 先结构后样式

```python
# 正确：语义结构
html = """
<article>
  <header><h1>报告标题</h1></header>
  <section>
    <h2>摘要</h2>
    <p>内容...</p>
  </section>
</article>
"""

# 错误：样式优先
html = "<div style='font-size:24px'>报告标题</div>"
```

### 2. 显式处理分页

```css
/* 强制分页 */
.new-page { page-break-before: always; }

/* 保持在一起 */
.keep-together { page-break-inside: avoid; }

/* 标题不分页 */
h2, h3 { page-break-after: avoid; }
```

### 3. 始终设置元数据

```python
html = """
<html>
<head>
  <title>文档标题</title>
  <meta name="author" content="作者名称">
</head>
...
"""
```

### 4. 使用打印优化 CSS

```css
@media print {
  body {
    font-family: 'Georgia', serif;
    font-size: 11pt;
    line-height: 1.5;
  }
  
  @page {
    size: A4;
    margin: 2cm;
  }
  
  .no-print { display: none; }
}
```

### 5. 验证输出

生成 PDF 后：
1. 检查文件大小（0 字节 = 失败）
2. 打开验证页数
3. 验证字体正确渲染

## 工具使用

### weasyprint (推荐)

```python
from weasyprint import HTML, CSS

# 从字符串
html = "<h1>Hello</h1><p>World</p>"
HTML(string=html).write_pdf("output.pdf")

# 从文件
HTML("document.html").write_pdf("output.pdf")

# 自定义 CSS
css = CSS(string="body { font-family: Arial; }")
HTML(string=html).write_pdf("output.pdf", stylesheets=[css])
```

### pandoc

```bash
# 基本转换
pandoc document.md -o output.pdf

# 带目录
pandoc document.md --toc -o output.pdf

# 自定义边距
pandoc document.md -V geometry:margin=1in -o output.pdf
```

### reportlab (编程)

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import cm

c = canvas.Canvas("output.pdf", pagesize=A4)
width, height = A4

c.setFont("Helvetica-Bold", 24)
c.drawString(2*cm, height - 3*cm, "报告标题")

c.setFont("Helvetica", 12)
c.drawString(2*cm, height - 5*cm, "正文内容...")

c.save()
```

### fpdf2 (轻量)

```python
from fpdf import FPDF

pdf = FPDF()
pdf.add_page()
pdf.set_font("Helvetica", size=16)
pdf.cell(200, 10, text="Hello World", align="C")

pdf.set_font("Helvetica", size=12)
pdf.multi_cell(0, 10, text="长段落文本...")

pdf.output("output.pdf")
```

### pypdf (合并/拆分)

```python
from pypdf import PdfWriter, PdfReader

# 合并 PDF
writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)
writer.write("merged.pdf")

# 拆分 PDF
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    writer.write(f"page_{i+1}.pdf")
```

## 文档模板

### 发票

```python
from weasyprint import HTML

def generate_invoice(data):
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body {{ font-family: Arial, sans-serif; margin: 40px; }}
            .header {{ display: flex; justify-content: space-between; }}
            .company {{ font-size: 24px; font-weight: bold; }}
            table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
            th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
            th {{ background: #f5f5f5; }}
            .total {{ font-size: 18px; font-weight: bold; text-align: right; }}
        </style>
    </head>
    <body>
        <div class="header">
            <div class="company">{data['company']['name']}</div>
            <div style="font-size: 32px;">发票</div>
        </div>
        
        <p><strong>发票号:</strong> {data['invoice']['number']}</p>
        <p><strong>日期:</strong> {data['invoice']['date']}</p>
        
        <h3>收票方:</h3>
        <p>{data['client']['name']}<br>{data['client']['address']}</p>
        
        <table>
            <tr><th>描述</th><th>数量</th><th>单价</th><th>金额</th></tr>
            {''.join(f"<tr><td>{item['desc']}</td><td>{item['qty']}</td><td>¥{item['rate']}</td><td>¥{item['qty'] * item['rate']}</td></tr>" for item in data['items'])}
        </table>
        
        <p class="total">合计: ¥{sum(item['qty'] * item['rate'] for item in data['items'])}</p>
    </body>
    </html>
    """
    HTML(string=html).write_pdf(f"invoice-{data['invoice']['number']}.pdf")
```

### 报告

```python
def generate_report(title, sections):
    toc = "".join(f'<li><a href="#section-{i}">{s["title"]}</a></li>' 
                  for i, s in enumerate(sections))
    
    content = "".join(f'''
        <section id="section-{i}">
            <h2>{s["title"]}</h2>
            <p>{s["content"]}</p>
        </section>
    ''' for i, s in enumerate(sections))
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            @page {{ size: A4; margin: 2cm; }}
            body {{ font-family: Georgia, serif; line-height: 1.6; }}
            h1 {{ color: #2c3e50; border-bottom: 2px solid #3498db; }}
            h2 {{ color: #34495e; page-break-after: avoid; }}
            section {{ page-break-inside: avoid; }}
            .toc {{ background: #f9f9f9; padding: 20px; margin: 20px 0; }}
        </style>
    </head>
    <body>
        <h1>{title}</h1>
        <div class="toc">
            <h3>目录</h3>
            <ol>{toc}</ol>
        </div>
        {content}
    </body>
    </html>
    """
    HTML(string=html).write_pdf("report.pdf")
```

### 合同

```python
def generate_contract(data):
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            @page {{ 
                size: A4; 
                margin: 1in;
                @bottom-center {{ content: "第 " counter(page) " 页"; }}
            }}
            body {{ font-family: SimSun, serif; font-size: 12pt; line-height: 1.8; }}
            h1 {{ text-align: center; }}
            .parties {{ margin: 30px 0; }}
            .clause {{ margin: 20px 0; }}
            .signatures {{ margin-top: 50px; display: flex; justify-content: space-between; }}
            .signature-line {{ border-top: 1px solid black; margin-top: 50px; padding-top: 5px; }}
        </style>
    </head>
    <body>
        <h1>{data['title']}</h1>
        
        <div class="parties">
            <p>本协议于 {data['date']} 由以下双方签署：</p>
            <p><strong>{data['party1']['name']}</strong></p>
            <p><strong>{data['party2']['name']}</strong></p>
        </div>
        
        {''.join(f'<div class="clause"><strong>{i+1}. {c["title"]}</strong> {c["text"]}</div>' for i, c in enumerate(data['clauses']))}
        
        <div class="signatures">
            <div>
                <div class="signature-line">{data['party1']['name']}</div>
                <p>日期: _______________</p>
            </div>
            <div>
                <div class="signature-line">{data['party2']['name']}</div>
                <p>日期: _______________</p>
            </div>
        </div>
    </body>
    </html>
    """
    HTML(string=html).write_pdf("contract.pdf")
```

## 常见陷阱

| 陷阱 | 后果 | 解决 |
|------|------|------|
| 缺少字体 | 回退到默认 | 使用 Web 安全字体 |
| 绝对图片路径 | 图片丢失 | 使用相对路径 |
| 未设置页面大小 | 布局不可预测 | 设置 `@page { size: A4; }` |
| 大图片 | 文件过大 | 使用前压缩 |

## 安全与隐私

**这是参考技能。** 仅提供模式和指导。

**本地数据处理：**
- 所有 PDF 生成在用户机器上完成
- 不发送数据到外部

**本技能不：**
- 执行代码或创建文件
- 发起网络请求
- 访问系统文件
