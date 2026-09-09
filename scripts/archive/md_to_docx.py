#!/usr/bin/env python3
"""
Markdown to Word Converter — CrabPaw v2.0
将 Markdown 文件转换为经过专业排版的 Word 文档。

用法:
    python md_to_docx.py <input.md> <output.docx> [title] [--style <模板名>]

模板:
    商务报告 (默认)   — 微软雅黑/深蓝标题/1.5倍行距/A4标准边距
    中国公文          — 仿宋正文/黑体标题/28磅行距/公文边距
    学术论文          — 宋体正文/黑体标题/1.5倍行距
    简约现代          — Arial/无衬线/宽松间距/清爽布局
"""

import sys
import os
import re
import io
from pathlib import Path

# Windows 控制台 UTF-8 兼容
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from docx import Document
from docx.shared import Inches, Pt, Cm, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_BREAK
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn, nsdecls
from docx.oxml import parse_xml, OxmlElement

# ============================================================
# 美化模板配置
# ============================================================

STYLE_PRESETS = {
    "商务报告": {
        "page": {"width": Cm(21), "height": Cm(29.7),
                 "top": Cm(2.54), "bottom": Cm(2.54),
                 "left": Cm(2.54), "right": Cm(2.54)},
        "title_font":    {"name": "微软雅黑",    "size": Pt(22), "bold": True,  "color": RGBColor(0x1A, 0x3A, 0x5C)},
        "title_align":   WD_ALIGN_PARAGRAPH.CENTER,
        "h1_font":       {"name": "微软雅黑", "size": Pt(16), "bold": True,  "color": RGBColor(0x1A, 0x3A, 0x5C)},
        "h1_before":     Pt(18), "h1_after": Pt(8),
        "h2_font":       {"name": "微软雅黑", "size": Pt(14), "bold": True,  "color": RGBColor(0x2B, 0x57, 0x97)},
        "h2_before":     Pt(14), "h2_after": Pt(6),
        "h3_font":       {"name": "微软雅黑", "size": Pt(12), "bold": True,  "color": RGBColor(0x2B, 0x57, 0x97)},
        "h3_before":     Pt(10), "h3_after": Pt(4),
        "h4_font":       {"name": "微软雅黑", "size": Pt(11), "bold": True,  "color": RGBColor(0x2B, 0x57, 0x97)},
        "h4_before":     Pt(8),  "h4_after": Pt(4),
        "h5_font":       {"name": "微软雅黑", "size": Pt(11), "bold": True,  "color": RGBColor(0x2B, 0x57, 0x97)},
        "h5_before":     Pt(6),  "h5_after": Pt(2),
        "h6_font":       {"name": "微软雅黑", "size": Pt(11), "bold": True,  "color": RGBColor(0x55, 0x55, 0x55)},
        "h6_before":     Pt(6),  "h6_after": Pt(2),
        "body_font":     {"name": "微软雅黑", "size": Pt(11), "bold": False, "color": RGBColor(0x1A, 0x1A, 0x1A)},
        "body_line_spacing": 1.5,
        "body_after":    Pt(6),
        "code_font":     {"name": "Consolas", "size": Pt(9)},
        "code_bg":       "F5F5F5",
        "table_header_bg": "1A3A5C",
        "table_header_fg": "FFFFFF",
        "table_alt_bg":  "F2F6FA",
        "table_font":    {"name": "微软雅黑", "size": Pt(10)},
        "hr_text":       "─" * 50,
        "page_number":   True,
        "header_text":   None,
        "footer_text":   None,
    },
    "中国公文": {
        "page": {"width": Cm(21), "height": Cm(29.7),
                 "top": Cm(3.7),  "bottom": Cm(3.5),
                 "left": Cm(2.8), "right": Cm(2.6)},
        "title_font":    {"name": "方正小标宋简体", "size": Pt(22), "bold": False, "color": RGBColor(0xD4, 0x1C, 0x1C)},
        "title_align":   WD_ALIGN_PARAGRAPH.CENTER,
        "h1_font":       {"name": "黑体", "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h1_before":     Pt(12), "h1_after": Pt(6),
        "h2_font":       {"name": "楷体", "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h2_before":     Pt(10), "h2_after": Pt(4),
        "h3_font":       {"name": "仿宋", "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h3_before":     Pt(8),  "h3_after": Pt(4),
        "h4_font":       {"name": "仿宋", "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h4_before":     Pt(6),  "h4_after": Pt(2),
        "h5_font":       {"name": "仿宋", "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h5_before":     Pt(6),  "h5_after": Pt(2),
        "h6_font":       {"name": "仿宋", "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h6_before":     Pt(6),  "h6_after": Pt(2),
        "body_font":     {"name": "仿宋", "size": Pt(16), "bold": False, "color": RGBColor(0x00, 0x00, 0x00)},
        "body_line_spacing": Pt(28),  # 固定值 28 磅
        "body_after":    Pt(0),
        "code_font":     {"name": "仿宋", "size": Pt(14)},
        "code_bg":       "F5F5F0",
        "table_header_bg": "C00000",
        "table_header_fg": "FFFFFF",
        "table_alt_bg":  "FFF0F0",
        "table_font":    {"name": "仿宋", "size": Pt(14)},
        "hr_text":       "─" * 60,
        "page_number":   True,
        "header_text":   None,
        "footer_text":   None,
    },
    "学术论文": {
        "page": {"width": Cm(21), "height": Cm(29.7),
                 "top": Cm(2.54), "bottom": Cm(2.54),
                 "left": Cm(3.17), "right": Cm(3.17)},
        "title_font":    {"name": "黑体",    "size": Pt(16), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "title_align":   WD_ALIGN_PARAGRAPH.CENTER,
        "h1_font":       {"name": "黑体", "size": Pt(14), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h1_before":     Pt(12), "h1_after": Pt(6),
        "h2_font":       {"name": "楷体", "size": Pt(12), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h2_before":     Pt(8),  "h2_after": Pt(4),
        "h3_font":       {"name": "宋体", "size": Pt(12), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h3_before":     Pt(6),  "h3_after": Pt(2),
        "h4_font":       {"name": "宋体", "size": Pt(12), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h4_before":     Pt(6),  "h4_after": Pt(2),
        "h5_font":       {"name": "宋体", "size": Pt(12), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h5_before":     Pt(4),  "h5_after": Pt(2),
        "h6_font":       {"name": "宋体", "size": Pt(12), "bold": True,  "color": RGBColor(0x00, 0x00, 0x00)},
        "h6_before":     Pt(4),  "h6_after": Pt(2),
        "body_font":     {"name": "宋体", "size": Pt(12), "bold": False, "color": RGBColor(0x00, 0x00, 0x00)},
        "body_line_spacing": 1.5,
        "body_after":    Pt(0),
        "code_font":     {"name": "Consolas", "size": Pt(9)},
        "code_bg":       "F5F5F5",
        "table_header_bg": "333333",
        "table_header_fg": "FFFFFF",
        "table_alt_bg":  "F5F5F5",
        "table_font":    {"name": "宋体", "size": Pt(10)},
        "hr_text":       "─" * 40,
        "page_number":   True,
        "header_text":   None,
        "footer_text":   None,
    },
    "简约现代": {
        "page": {"width": Cm(21), "height": Cm(29.7),
                 "top": Cm(2.5),  "bottom": Cm(2.5),
                 "left": Cm(2.5), "right": Cm(2.5)},
        "title_font":    {"name": "Arial",    "size": Pt(20), "bold": True,  "color": RGBColor(0x33, 0x33, 0x33)},
        "title_align":   WD_ALIGN_PARAGRAPH.LEFT,
        "h1_font":       {"name": "Arial", "size": Pt(14), "bold": True,  "color": RGBColor(0x33, 0x33, 0x33)},
        "h1_before":     Pt(20), "h1_after": Pt(8),
        "h2_font":       {"name": "Arial", "size": Pt(12), "bold": True,  "color": RGBColor(0x55, 0x55, 0x55)},
        "h2_before":     Pt(16), "h2_after": Pt(6),
        "h3_font":       {"name": "Arial", "size": Pt(11), "bold": True,  "color": RGBColor(0x55, 0x55, 0x55)},
        "h3_before":     Pt(12), "h3_after": Pt(4),
        "h4_font":       {"name": "Arial", "size": Pt(11), "bold": True,  "color": RGBColor(0x66, 0x66, 0x66)},
        "h4_before":     Pt(10), "h4_after": Pt(2),
        "h5_font":       {"name": "Arial", "size": Pt(10), "bold": True,  "color": RGBColor(0x66, 0x66, 0x66)},
        "h5_before":     Pt(8),  "h5_after": Pt(2),
        "h6_font":       {"name": "Arial", "size": Pt(10), "bold": True,  "color": RGBColor(0x77, 0x77, 0x77)},
        "h6_before":     Pt(8),  "h6_after": Pt(2),
        "body_font":     {"name": "Arial", "size": Pt(10.5), "bold": False, "color": RGBColor(0x33, 0x33, 0x33)},
        "body_line_spacing": 1.15,
        "body_after":    Pt(8),
        "code_font":     {"name": "Consolas", "size": Pt(9)},
        "code_bg":       "F8F8F8",
        "table_header_bg": "444444",
        "table_header_fg": "FFFFFF",
        "table_alt_bg":  "FAFAFA",
        "table_font":    {"name": "Arial", "size": Pt(9.5)},
        "hr_text":       "· · ·",
        "page_number":   True,
        "header_text":   None,
        "footer_text":   None,
    },
}

# ============================================================
# 工具函数
# ============================================================

def _apply_font(run, font_cfg):
    """将字体配置应用到 run 对象."""
    run.font.name = font_cfg["name"]
    run.font.size = font_cfg["size"]
    run.bold = font_cfg.get("bold", False)
    run.font.color.rgb = font_cfg.get("color", RGBColor(0, 0, 0))
    # 设置东亚字体 (确保中文正确渲染)
    r = run._element
    rPr = r.find(qn('w:rPr'))
    if rPr is None:
        rPr = OxmlElement('w:rPr')
        r.insert(0, rPr)
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rPr.insert(0, rFonts)
    rFonts.set(qn('w:eastAsia'), font_cfg["name"])
    rFonts.set(qn('w:ascii'), font_cfg["name"])
    rFonts.set(qn('w:hAnsi'), font_cfg["name"])


def _set_paragraph_spacing(para, before=Pt(0), after=Pt(6), line_spacing=None):
    """设置段落间距和行距."""
    pPr = para._element.find(qn('w:pPr'))
    if pPr is None:
        pPr = OxmlElement('w:pPr')
        para._element.insert(0, pPr)

    # 段前间距
    spacing = pPr.find(qn('w:spacing'))
    if spacing is None:
        spacing = OxmlElement('w:spacing')
        pPr.append(spacing)
    if before is not None:
        spacing.set(qn('w:before'), str(int(before.pt * 20)))  # twips
    if after is not None:
        spacing.set(qn('w:after'), str(int(after.pt * 20)))

    if line_spacing is not None:
        if isinstance(line_spacing, (int, float)):
            # 倍数行距
            spacing.set(qn('w:line'), str(int(line_spacing * 240)))
            spacing.set(qn('w:lineRule'), 'auto')
        else:
            # 固定值 (Pt 对象)
            spacing.set(qn('w:line'), str(int(line_spacing.pt * 20)))
            spacing.set(qn('w:lineRule'), 'exact')


def _set_cell_bg(cell, hex_color):
    """给表格单元格设置背景色."""
    tcPr = cell._element.find(qn('w:tcPr'))
    if tcPr is None:
        tcPr = OxmlElement('w:tcPr')
        cell._element.insert(0, tcPr)
    shading = OxmlElement('w:shd')
    shading.set(qn('w:fill'), hex_color)
    shading.set(qn('w:val'), 'clear')
    tcPr.append(shading)


def _set_cell_border(cell, **kwargs):
    """设置单元格边框."""
    tcPr = cell._element.find(qn('w:tcPr'))
    if tcPr is None:
        tcPr = OxmlElement('w:tcPr')
        cell._element.insert(0, tcPr)
    tcBorders = OxmlElement('w:tcBorders')
    for edge, color_val in kwargs.items():
        edge_el = OxmlElement(f'w:{edge}')
        edge_el.set(qn('w:val'), 'single')
        edge_el.set(qn('w:sz'), '4')
        edge_el.set(qn('w:space'), '0')
        edge_el.set(qn('w:color'), color_val)
        tcBorders.append(edge_el)
    tcPr.append(tcBorders)


def _add_page_number(doc):
    """在页脚添加页码."""
    for section in doc.sections:
        footer = section.footer
        footer.is_linked_to_previous = False
        para = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        # 页码字段
        run = para.add_run()
        fldChar1 = OxmlElement('w:fldChar')
        fldChar1.set(qn('w:fldCharType'), 'begin')
        run._element.append(fldChar1)
        run2 = para.add_run()
        instrText = OxmlElement('w:instrText')
        instrText.set(qn('xml:space'), 'preserve')
        instrText.text = ' PAGE '
        run2._element.append(instrText)
        run3 = para.add_run()
        fldChar2 = OxmlElement('w:fldChar')
        fldChar2.set(qn('w:fldCharType'), 'end')
        run3._element.append(fldChar2)


def _add_header_text(doc, text):
    """在页眉添加文字."""
    for section in doc.sections:
        header = section.header
        header.is_linked_to_previous = False
        para = header.paragraphs[0] if header.paragraphs else header.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        run = para.add_run(text)
        run.font.size = Pt(8)
        run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)


# ============================================================
# 页面设置
# ============================================================

def _setup_page(doc, style):
    """设置页面尺寸和边距."""
    for section in doc.sections:
        pg = style["page"]
        section.page_width = pg["width"]
        section.page_height = pg["height"]
        section.top_margin = pg["top"]
        section.bottom_margin = pg["bottom"]
        section.left_margin = pg["left"]
        section.right_margin = pg["right"]


# ============================================================
# 内联格式解析
# ============================================================

def process_inline_formatting(para, text, style):
    """解析 Markdown 内联格式并写入段落.

    支持: **粗体**, *斜体*, `代码`, ~~删除线~~, [链接](url)
    """
    body_font = style["body_font"]
    code_font = style.get("code_font", {"name": "Consolas", "size": Pt(9)})

    # 分词：按格式标记切分
    parts = []
    current = ''
    i = 0
    length = len(text)

    while i < length:
        # 粗体 **...**
        if text[i:i+2] == '**':
            if current:
                parts.append(('normal', current))
                current = ''
            j = i + 2
            while j < length - 1 and text[j:j+2] != '**':
                j += 1
            parts.append(('bold', text[i+2:j]))
            i = j + 2
        # 斜体 *...* (单星号，不匹配 **)
        elif text[i] == '*' and (i == 0 or text[i-1] != '*') and (i + 1 < length and text[i+1] != '*'):
            if current:
                parts.append(('normal', current))
                current = ''
            j = i + 1
            while j < length and text[j] != '*':
                j += 1
            parts.append(('italic', text[i+1:j]))
            i = j + 1
        # 删除线 ~~...~~
        elif text[i:i+2] == '~~':
            if current:
                parts.append(('normal', current))
                current = ''
            j = i + 2
            while j < length - 1 and text[j:j+2] != '~~':
                j += 1
            parts.append(('strikethrough', text[i+2:j]))
            i = j + 2
        # 行内代码 `...`
        elif text[i] == '`':
            if current:
                parts.append(('normal', current))
                current = ''
            j = i + 1
            while j < length and text[j] != '`':
                j += 1
            parts.append(('code', text[i+1:j]))
            i = j + 1
        # 链接 [text](url) — 简化为仅显示链接文字
        elif text[i] == '[':
            if current:
                parts.append(('normal', current))
                current = ''
            j = i + 1
            while j < length and text[j] != ']':
                j += 1
            link_text = text[i+1:j]
            if j + 1 < length and text[j+1] == '(':
                k = j + 2
                while k < length and text[k] != ')':
                    k += 1
                i = k + 1
                parts.append(('link', link_text))
            else:
                parts.append(('normal', '[' + link_text))
                i = j + 1
        else:
            current += text[i]
            i += 1

    if current:
        parts.append(('normal', current))

    # 如果没有格式标记，直接写入
    if len(parts) == 1 and parts[0][0] == 'normal':
        run = para.add_run(text)
        _apply_font(run, body_font)
        return text

    # 逐段写入
    for fmt, txt in parts:
        if not txt:
            continue
        run = para.add_run(txt)
        if fmt == 'bold':
            _apply_font(run, {**body_font, "bold": True})
        elif fmt == 'italic':
            _apply_font(run, {**body_font})
            run.italic = True
        elif fmt == 'strikethrough':
            _apply_font(run, {**body_font})
            run.font.strike = True
        elif fmt == 'code':
            _apply_font(run, code_font)
            # 灰色背景效果（通过高亮色）
            rPr = run._element.find(qn('w:rPr'))
            if rPr is None:
                rPr = OxmlElement('w:rPr')
                run._element.insert(0, rPr)
            highlight = OxmlElement('w:highlight')
            highlight.set(qn('w:val'), 'lightGray')
            rPr.append(highlight)
        elif fmt == 'link':
            _apply_font(run, {**body_font, "color": RGBColor(0x2B, 0x57, 0x97)})
            run.underline = True
        else:
            _apply_font(run, body_font)

    return text


# ============================================================
# Markdown → Word 核心转换
# ============================================================

def parse_markdown_to_word(md_content, output_path, title=None, style_name="商务报告", author=None):
    """将 Markdown 内容转换为专业排版的 Word 文档.

    Args:
        md_content:    Markdown 文本内容
        output_path:   输出 .docx 路径
        title:         文档标题（可选，显示在文档开头）
        style_name:    模板名称 ("商务报告" / "中国公文" / "学术论文" / "简约现代")
        author:        作者名（可选，用于文档属性）
    """
    style = STYLE_PRESETS.get(style_name, STYLE_PRESETS["商务报告"])
    doc = Document()

    # --- 文档属性 ---
    if title:
        doc.core_properties.title = title
    if author:
        doc.core_properties.author = author

    # --- 修改默认样式 ---
    normal_style = doc.styles['Normal']
    normal_font = normal_style.font
    body_font = style["body_font"]
    normal_font.name = body_font["name"]
    normal_font.size = body_font["size"]
    normal_font.color.rgb = body_font.get("color", RGBColor(0, 0, 0))
    # 设置东亚字体
    rPr = normal_style.element.find(qn('w:rPr'))
    if rPr is None:
        rPr = OxmlElement('w:rPr')
        normal_style.element.append(rPr)
    rFonts = rPr.find(qn('w:rFonts'))
    if rFonts is None:
        rFonts = OxmlElement('w:rFonts')
        rPr.insert(0, rFonts)
    rFonts.set(qn('w:eastAsia'), body_font["name"])

    # --- 页面设置 ---
    _setup_page(doc, style)

    # --- 文档标题 ---
    if title:
        title_para = doc.add_paragraph()
        title_para.alignment = style.get("title_align", WD_ALIGN_PARAGRAPH.CENTER)
        _set_paragraph_spacing(title_para, before=Pt(0), after=Pt(16),
                               line_spacing=style.get("body_line_spacing"))
        title_run = title_para.add_run(title)
        _apply_font(title_run, style["title_font"])

        # 标题下方分隔线（中国公文风格红色线，其他风格细灰线）
        if style_name == "中国公文":
            sep = doc.add_paragraph()
            sep.alignment = WD_ALIGN_PARAGRAPH.CENTER
            sep_run = sep.add_run("━" * 30)
            sep_run.font.size = Pt(10)
            sep_run.font.color.rgb = RGBColor(0xD4, 0x1C, 0x1C)
            _set_paragraph_spacing(sep, before=Pt(4), after=Pt(20))
        else:
            sep = doc.add_paragraph()
            sep.alignment = WD_ALIGN_PARAGRAPH.CENTER
            sep_run = sep.add_run("─" * 40)
            sep_run.font.size = Pt(8)
            sep_run.font.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)
            _set_paragraph_spacing(sep, before=Pt(4), after=Pt(16))

    # --- 解析 Markdown 行 ---
    lines = md_content.split('\n')
    i = 0
    in_table = False
    table_data = []
    in_code_block = False
    code_content = []
    in_blockquote = False
    blockquote_lines = []

    while i < len(lines):
        line = lines[i]

        # --- 代码块 ---
        if line.strip().startswith('```'):
            if in_code_block:
                # 结束代码块
                code_text = '\n'.join(code_content)
                _add_code_block(doc, code_text, style)
                code_content = []
                in_code_block = False
            else:
                in_code_block = True
            i += 1
            continue

        if in_code_block:
            code_content.append(line)
            i += 1
            continue

        # --- 引用块 ---
        if line.strip().startswith('> '):
            blockquote_lines.append(line.strip()[2:])
            in_blockquote = True
            # 检查下一行是否仍是引用
            if i + 1 < len(lines) and lines[i+1].strip().startswith('> '):
                i += 1
                continue
            # 否则输出引用块
            if in_blockquote:
                _add_blockquote(doc, blockquote_lines, style)
                blockquote_lines = []
                in_blockquote = False
            i += 1
            continue
        elif in_blockquote:
            # 引用块已结束
            _add_blockquote(doc, blockquote_lines, style)
            blockquote_lines = []
            in_blockquote = False
            # 继续处理当前行（fall through）

        # --- 表格 ---
        if line.strip().startswith('|') and '|' in line[1:]:
            if not in_table:
                in_table = True
                table_data = []

            cells = [cell.strip() for cell in line.split('|')[1:-1]]
            # 跳过仅含分隔符的行 (| --- | --- |)
            if cells and not _is_table_separator(cells):
                table_data.append(cells)
            i += 1
            continue
        elif in_table:
            # 表格结束，渲染表格
            if table_data:
                _add_table(doc, table_data, style)
                doc.add_paragraph()  # 表格后空行
            table_data = []
            in_table = False
            # 继续处理当前行（fall through）

        # --- 标题 ---
        heading_match = re.match(r'^(#{1,6})\s+(.+)$', line)
        if heading_match:
            level = len(heading_match.group(1))
            text = heading_match.group(2).strip()
            _add_heading(doc, text, level, style)
            i += 1
            continue

        # --- 水平分割线 ---
        if re.match(r'^(\*{3,}|-{3,}|_{3,})\s*$', line.strip()):
            hr = doc.add_paragraph()
            hr.alignment = WD_ALIGN_PARAGRAPH.CENTER
            hr_run = hr.add_run(style.get("hr_text", "─" * 40))
            hr_run.font.size = Pt(10)
            hr_run.font.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)
            _set_paragraph_spacing(hr, before=Pt(12), after=Pt(12))
            i += 1
            continue

        # --- 无序列表 ---
        if re.match(r'^(\s*)[-*+]\s+(.+)$', line):
            indent = len(re.match(r'^(\s*)', line).group(1))
            text = re.sub(r'^\s*[-*+]\s+', '', line)
            _add_list_item(doc, text, bullet=True, indent=indent, style=style)
            i += 1
            continue

        # --- 有序列表 ---
        ordered_match = re.match(r'^(\s*)(\d+)\.\s+(.+)$', line)
        if ordered_match:
            indent = len(ordered_match.group(1))
            text = ordered_match.group(3)
            _add_list_item(doc, text, bullet=False, indent=indent, style=style)
            i += 1
            continue

        # --- 整行粗体标题 ---
        bold_title_match = re.match(r'^\*\*(.+)\*\*\s*$', line)
        if bold_title_match:
            para = doc.add_paragraph()
            _set_paragraph_spacing(para, before=Pt(8), after=Pt(4),
                                   line_spacing=style.get("body_line_spacing"))
            run = para.add_run(bold_title_match.group(1))
            _apply_font(run, {**style["body_font"], "bold": True})
            i += 1
            continue

        # --- 空行 ---
        if not line.strip():
            # 添加一个带有最小间距的空白段落做视觉间隔
            para = doc.add_paragraph()
            _set_paragraph_spacing(para, before=Pt(0), after=Pt(0),
                                   line_spacing=style.get("body_line_spacing"))
            i += 1
            continue

        # --- 普通段落 ---
        para = doc.add_paragraph()
        _set_paragraph_spacing(para, before=Pt(0), after=style.get("body_after", Pt(6)),
                               line_spacing=style.get("body_line_spacing"))
        process_inline_formatting(para, line, style)
        i += 1

    # --- 残留表格处理 ---
    if in_table and table_data:
        _add_table(doc, table_data, style)

    # --- 页脚：页码 ---
    if style.get("page_number"):
        _add_page_number(doc)

    # --- 页眉 ---
    if style.get("header_text"):
        _add_header_text(doc, style["header_text"])

    # --- 保存 ---
    doc.save(output_path)
    return output_path


# ============================================================
# 元素渲染函数
# ============================================================

def _is_table_separator(cells):
    """检查表格行是否为分隔符行 (如 | --- | :--- | ---: |)."""
    return all(
        re.match(r'^:?-{3,}:?$', c.replace(' ', ''))
        for c in cells
    )


def _add_heading(doc, text, level, style):
    """添加格式化标题."""
    font_key = f"h{level}_font"
    font_cfg = style.get(font_key, style["body_font"])
    before = style.get(f"h{level}_before", Pt(8))
    after = style.get(f"h{level}_after", Pt(4))

    para = doc.add_paragraph()
    _set_paragraph_spacing(para, before=before, after=after,
                           line_spacing=style.get("body_line_spacing"))

    # 设置段落大纲级别
    pPr = para._element.find(qn('w:pPr'))
    if pPr is None:
        pPr = OxmlElement('w:pPr')
        para._element.insert(0, pPr)
    outlineLvl = OxmlElement('w:outlineLvl')
    outlineLvl.set(qn('w:val'), str(level - 1))
    pPr.append(outlineLvl)

    run = para.add_run(text)
    _apply_font(run, font_cfg)


def _add_code_block(doc, code_text, style):
    """添加代码块（带背景色的段落组）."""
    code_font = style.get("code_font", {"name": "Consolas", "size": Pt(9)})
    code_lines = code_text.split('\n')

    for line in code_lines:
        para = doc.add_paragraph()
        _set_paragraph_spacing(para, before=Pt(0), after=Pt(0),
                               line_spacing=1.0)
        # 设置段落背景色
        pPr = para._element.find(qn('w:pPr'))
        if pPr is None:
            pPr = OxmlElement('w:pPr')
            para._element.insert(0, pPr)
        shd = OxmlElement('w:shd')
        shd.set(qn('w:val'), 'clear')
        shd.set(qn('w:fill'), style.get("code_bg", "F5F5F5"))
        pPr.append(shd)

        if line:
            run = para.add_run(line)
        else:
            run = para.add_run(' ')  # 空行
        _apply_font(run, code_font)

    # 代码块后添加间隔
    spacer = doc.add_paragraph()
    _set_paragraph_spacing(spacer, before=Pt(2), after=Pt(4))


def _add_blockquote(doc, lines, style):
    """添加引用块（左缩进 + 左边框 + 灰色文字）."""
    body_font = style["body_font"]
    text = ' '.join(lines)

    para = doc.add_paragraph()
    _set_paragraph_spacing(para, before=Pt(4), after=Pt(4),
                           line_spacing=style.get("body_line_spacing"))

    # 左缩进
    pPr = para._element.find(qn('w:pPr'))
    if pPr is None:
        pPr = OxmlElement('w:pPr')
        para._element.insert(0, pPr)
    ind = OxmlElement('w:ind')
    ind.set(qn('w:left'), '720')  # 0.5 inch
    pPr.append(ind)

    # 左边框
    pBdr = OxmlElement('w:pBdr')
    left_border = OxmlElement('w:left')
    left_border.set(qn('w:val'), 'single')
    left_border.set(qn('w:sz'), '12')
    left_border.set(qn('w:space'), '8')
    left_border.set(qn('w:color'), style.get("h1_font", {}).get("color",
                         RGBColor(0x1A, 0x3A, 0x5C)).__repr__().replace('#', '')
                     if False else '2B5797')
    pBdr.append(left_border)
    pPr.append(pBdr)

    run = para.add_run(text)
    quote_font = dict(body_font)
    quote_font["color"] = RGBColor(0x66, 0x66, 0x66)
    run.italic = True
    _apply_font(run, quote_font)


def _add_table(doc, table_data, style):
    """添加美化表格."""
    if not table_data:
        return

    num_cols = max(len(row) for row in table_data)
    # 补齐列数
    normalized = [row + [''] * (num_cols - len(row)) for row in table_data]
    num_rows = len(normalized)

    table = doc.add_table(rows=num_rows, cols=num_cols)
    table.style = 'Table Grid'
    table.autofit = True

    table_font = style.get("table_font", {"name": style["body_font"]["name"], "size": Pt(10)})
    header_bg = style.get("table_header_bg", "1A3A5C")
    header_fg = style.get("table_header_fg", "FFFFFF")
    alt_bg = style.get("table_alt_bg", "F2F6FA")

    for row_idx, row_data in enumerate(normalized):
        for col_idx, cell_text in enumerate(row_data):
            cell = table.rows[row_idx].cells[col_idx]

            # 清除默认段落
            for p in cell.paragraphs:
                p.clear()

            para = cell.paragraphs[0]
            _set_paragraph_spacing(para, before=Pt(2), after=Pt(2), line_spacing=1.0)

            if row_idx == 0:
                # 表头行
                _set_cell_bg(cell, header_bg)
                run = para.add_run(cell_text)
                header_font = dict(table_font)
                header_font["bold"] = True
                header_font["color"] = RGBColor(
                    int(header_fg[0:2], 16),
                    int(header_fg[2:4], 16),
                    int(header_fg[4:6], 16),
                )
                _apply_font(run, header_font)
                para.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                # 数据行 — 交替背景色
                if row_idx % 2 == 0:
                    _set_cell_bg(cell, alt_bg)
                run = para.add_run(cell_text)
                _apply_font(run, table_font)

    # 表格宽度自适应
    for row in table.rows:
        for cell in row.cells:
            tcPr = cell._element.find(qn('w:tcPr'))
            if tcPr is None:
                tcPr = OxmlElement('w:tcPr')
                cell._element.insert(0, tcPr)
            tcW = OxmlElement('w:tcW')
            tcW.set(qn('w:w'), str(int(9000 / num_cols)))
            tcW.set(qn('w:type'), 'dxa')
            tcPr.append(tcW)


def _add_list_item(doc, text, bullet=True, indent=0, style=None):
    """添加列表项（带合适的字体和缩进）."""
    if style is None:
        style = STYLE_PRESETS["商务报告"]

    para = doc.add_paragraph()
    _set_paragraph_spacing(para, before=Pt(1), after=Pt(1),
                           line_spacing=style.get("body_line_spacing"))

    # 左缩进
    pPr = para._element.find(qn('w:pPr'))
    if pPr is None:
        pPr = OxmlElement('w:pPr')
        para._element.insert(0, pPr)
    ind = OxmlElement('w:ind')
    left_indent = 360 + indent * 360  # 基础 0.25in + 每级 0.25in
    ind.set(qn('w:left'), str(left_indent))
    ind.set(qn('w:hanging'), '360')
    pPr.append(ind)

    # 项目符号或编号
    if bullet:
        bullet_run = para.add_run('• ')
        _apply_font(bullet_run, style["body_font"])
    else:
        # 编号由外层通过段落编号处理，这里简单添加
        num_run = para.add_run('')
        _apply_font(num_run, style["body_font"])

    process_inline_formatting(para, text, style)


# ============================================================
# 主入口
# ============================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description='CrabPaw Markdown to Word Converter — 专业文档生成器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
模板参数:
  商务报告  — 微软雅黑/深蓝标题/1.5倍行距/A4标准边距（默认）
  中国公文  — 仿宋正文/黑体标题/28磅行距/公文边距/红头样式
  学术论文  — 宋体正文/黑体标题/1.5倍行距/论文边距
  简约现代  — Arial/无衬线/宽松间距/清爽布局

示例:
  python md_to_docx.py report.md output.docx
  python md_to_docx.py report.md output.docx "年度报告" --style 商务报告
  python md_to_docx.py doc.md output.docx "通知" --style 中国公文
        """)
    parser.add_argument('input', help='输入的 Markdown 文件路径')
    parser.add_argument('output', help='输出的 Word (.docx) 文件路径')
    parser.add_argument('title', nargs='?', default=None, help='文档标题（可选）')
    parser.add_argument('--style', '-s', default='商务报告',
                        choices=['商务报告', '中国公文', '学术论文', '简约现代'],
                        help='美化模板（默认: 商务报告）')
    parser.add_argument('--author', '-a', default=None, help='文档作者（可选）')

    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"❌ Error: 输入文件不存在: {args.input}", file=sys.stderr)
        sys.exit(1)

    with open(args.input, 'r', encoding='utf-8') as f:
        md_content = f.read()

    try:
        output_path = parse_markdown_to_word(
            md_content, args.output,
            title=args.title,
            style_name=args.style,
            author=args.author,
        )
        file_size = os.path.getsize(output_path)
        size_kb = file_size / 1024
        print(f"✅ Word 文档已生成: {output_path} ({size_kb:.1f} KB) [模板: {args.style}]")
    except Exception as e:
        print(f"❌ 转换失败: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    # 兼容旧版调用方式 (无 argparse)
    if len(sys.argv) >= 3 and '--style' not in sys.argv and '--help' not in sys.argv \
            and '-h' not in sys.argv and '-s' not in sys.argv and '-a' not in sys.argv:
        # 旧版: python md_to_docx.py input.md output.docx [title]
        input_path = sys.argv[1]
        output_path = sys.argv[2]
        title = sys.argv[3] if len(sys.argv) > 3 else None

        if not os.path.exists(input_path):
            print(f"❌ Error: 输入文件不存在: {input_path}", file=sys.stderr)
            sys.exit(1)

        with open(input_path, 'r', encoding='utf-8') as f:
            md_content = f.read()

        try:
            result = parse_markdown_to_word(md_content, output_path, title=title)
            file_size = os.path.getsize(result)
            size_kb = file_size / 1024
            print(f"✅ Word 文档已生成: {result} ({size_kb:.1f} KB) [模板: 商务报告]")
        except Exception as e:
            print(f"❌ 转换失败: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc()
            sys.exit(1)
    else:
        main()
