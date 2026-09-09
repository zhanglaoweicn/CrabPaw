/**
 * pdf-generator — PDF 生成执行器（2026-08-03 重写）
 *
 * 基于 pdf-lib 原生生成 PDF：标题 / 段落 / 列表 / 表格，嵌入中文字体
 * （Windows simhei.ttf 黑体，纯 TTF 可嵌入；无字体时回退 StandardFonts）。
 *
 * 调用约定：execute(input)
 *   input.title    文档标题
 *   input.content  Markdown 简化文本（# 标题、- 列表、| 表格 |、段落）
 *   input.outputPath / output  输出路径（可选，默认 CRABPAW_DATA_DIR）
 */
const path = require('path');
const fs = require('fs');

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// 2026-08-03: 自定义字体嵌入需要 fontkit（pdf-lib 依赖，需显式注册）
let _fontkit = null;
try { _fontkit = require('fontkit'); } catch (_) { _fontkit = null; }

const FONT_CANDIDATES = [
  'C:\\Windows\\Fonts\\simhei.ttf',           // 黑体（TTF，可嵌入）
  'C:\\Windows\\Fonts\\msyh.ttc',             // 微软雅黑（TTC，pdf-lib 部分支持）
  'C:\\Windows\\Fonts\\simsun.ttc',           // 宋体（TTC）
];

function _findChineseFont() {
  for (const p of FONT_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

/** 极简 markdown 解析（与 word-docx create 保持一致） */
function _mdToBlocks(md) {
  const blocks = [];
  const lines = String(md || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i++; continue; }
    if (/^```/.test(trimmed)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (hm) { blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] }); i++; continue; }
    if (trimmed.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().split('|').slice(1, -1).map(c => c.trim());
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const lm = /^[-*•]\s+(.*)$/.exec(lines[i].trim());
        if (!lm) break;
        items.push(lm[1]);
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    blocks.push({ type: 'paragraph', text: trimmed });
    i++;
  }
  return blocks;
}

/** 按视觉宽度换行（中文≈1 字符宽，英文≈0.55 字符宽） */
function _wrapText(text, maxWidth, size) {
  const cw = size * 0.6; // 单字符平均宽度估算
  const maxChars = Math.max(8, Math.floor(maxWidth / cw));
  const out = [];
  let line = '';
  for (const ch of text) {
    if ((line.length + (ch.charCodeAt(0) > 255 ? 1 : 0.55)) > maxChars) {
      out.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out;
}

async function execute(input) {
  const parsed = typeof input === 'string' ? { content: input } : input || {};
  const title = parsed.title || '未命名文档';
  const content = parsed.content || parsed.text || parsed.markdown || '';
  if (!content) return { success: false, error: '请提供内容（content / markdown）' };

  const outputPath = parsed.outputPath || parsed.output || null;

  try {
    const doc = await PDFDocument.create();
    const PAGE_W = 595.28, PAGE_H = 841.89; // A4
    const MARGIN = 56;
    const maxWidth = PAGE_W - MARGIN * 2;

    // 中文字体嵌入（需 fontkit）
    let font = null;
    const std = await doc.embedFont(StandardFonts.Helvetica);
    const fontPath = _findChineseFont();
    if (fontPath && _fontkit) {
      try {
        doc.registerFontkit(_fontkit);
        const bytes = fs.readFileSync(fontPath);
        font = await doc.embedFont(bytes, { subset: true });
      } catch (e) {
        console.warn('[PDF] 中文字体嵌入失败，回退标准字体:', e.message);
        font = std;
      }
    } else {
      if (!_fontkit) console.warn('[PDF] fontkit 未安装（npm install fontkit），回退标准字体——中文将无法显示');
      font = std;
    }
    // 中文内容 + 无中文字体 → 直接失败并给出明确指引
    if (font === std && /[一-龥]/.test(content)) {
      return { success: false, error: 'PDF 生成失败: 未找到中文字体嵌入能力（需要 npm install fontkit + Windows simhei.ttf）' };
    }

    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    const NAVY = rgb(0.12, 0.2, 0.45);
    const DARK = rgb(0.12, 0.12, 0.14);
    const GRAY = rgb(0.45, 0.45, 0.5);

    function newPageIfNeeded(needed) {
      if (y - needed < MARGIN) {
        page = doc.addPage([PAGE_W, PAGE_H]);
        y = PAGE_H - MARGIN;
      }
    }

    // 标题
    page.drawText(title, { x: MARGIN, y: y - 20, size: 26, font, color: NAVY });
    y -= 20 + 34;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.2, color: NAVY });
    y -= 24;

    for (const block of _mdToBlocks(content)) {
      if (block.type === 'heading') {
        const size = block.level === 1 ? 18 : block.level === 2 ? 15 : 13;
        newPageIfNeeded(size + 16);
        page.drawText(block.text, { x: MARGIN, y: y - size, size, font, color: NAVY });
        y -= size + 14;
      } else if (block.type === 'paragraph') {
        for (const line of _wrapText(block.text, maxWidth, 11)) {
          newPageIfNeeded(18);
          page.drawText(line, { x: MARGIN, y: y - 11, size: 11, font, color: DARK });
          y -= 18;
        }
        y -= 4;
      } else if (block.type === 'list') {
        for (const item of block.items) {
          const wrapped = _wrapText(item, maxWidth - 16, 11);
          newPageIfNeeded(wrapped.length * 18 + 4);
          page.drawText('•', { x: MARGIN, y: y - 11, size: 11, font, color: NAVY });
          for (const line of wrapped) {
            page.drawText(line, { x: MARGIN + 14, y: y - 11, size: 11, font, color: DARK });
            y -= 18;
          }
        }
        y -= 4;
      } else if (block.type === 'table') {
        const colW = maxWidth / Math.max(1, block.rows[0]?.length || 1);
        const rowH = 22;
        for (let ri = 0; ri < block.rows.length; ri++) {
          newPageIfNeeded(rowH);
          const row = block.rows[ri];
          for (let ci = 0; ci < row.length; ci++) {
            page.drawRectangle({
              x: MARGIN + ci * colW, y: y - rowH,
              width: colW, height: rowH,
              borderColor: GRAY, borderWidth: 0.5,
              color: ri === 0 ? rgb(0.93, 0.95, 1) : undefined,
            });
            const text = String(row[ci] || '');
            page.drawText(text.slice(0, Math.max(1, Math.floor(colW / 7))), {
              x: MARGIN + ci * colW + 4, y: y - 15, size: 9, font, color: DARK,
            });
          }
          y -= rowH;
        }
        y -= 8;
      } else if (block.type === 'code') {
        for (const cl of block.text.split('\n')) {
          newPageIfNeeded(16);
          page.drawText(cl || ' ', { x: MARGIN + 8, y: y - 10, size: 8.5, font: std, color: DARK });
          y -= 15;
        }
        y -= 4;
      }
    }

    const buf = await doc.save();
    const finalPath = outputPath || path.join(
      process.env.CRABPAW_DATA_DIR || path.join(__dirname, '../..'),
      `${String(title).replace(/[<>:"/\\|?*\s]+/g, '-').slice(0, 60) || 'document'}-${Date.now()}.pdf`
    );
    fs.writeFileSync(finalPath, buf);

    const size = fs.statSync(finalPath).size;
    return {
      success: true,
      pdfPath: finalPath,
      size,
      sizeKB: (size / 1024).toFixed(1),
      url: `file:///${finalPath.replace(/\\/g, '/')}`,
      message: `PDF 已生成 (${(size / 1024).toFixed(1)} KB)`,
    };
  } catch (e) {
    console.error('[pdf-generator] 生成失败:', e?.message || e);
    return { success: false, error: `PDF 生成失败: ${e?.message || e}` };
  }
}

const schema = {
  name: 'pdf-generator', description: 'PDF 生成引擎（pdf-lib 原生，中文字体嵌入）',
  capabilities: ['pdf_export', 'document_formatting'],
  input: { content: { type: 'string' }, title: { type: 'string' }, outputPath: { type: 'string' } },
  output: { pdfPath: { type: 'file' }, url: { type: 'string' } },
};
module.exports = { execute, schema };
module.exports.execute = execute;
