/**
 * smoke-pdf-parse.js — PDF 解析真实链路冒烟（2026-08-22）
 * 用法: node scripts/smoke-pdf-parse.js [pdf路径]
 * 链路: extractPdfText(≈doc_read) / extractPdfFull(≈pdf_extract/doc_to_markdown)
 *       / pdf-to-word-docx 技能 → 真实 pdf-parse v2 解析
 * 背景: 2026-08-22 实机 bug——doc_read 读 PDF 全失败（pdf-parse v2 API 断裂，
 *       TypeError: pdfParse is not a function），修复后本脚本守真实解析链路。
 *       注意: 该真实链路依赖 pdfjs 动态 import worker，无法在 jest vm 下运行
 *       （须 --experimental-vm-modules），故独立为裸 node 冒烟。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const KEY = (...a) => process.stderr.write(a.join(' ') + '\n');

const { extractPdfText, extractPdfFull, parsePdfBuffer } = require(path.join(ROOT, 'src/tools/document-tools'));

// 极简单页 PDF（文本 'Hello PDF'），自包含
function makeMinimalPdf() {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    '4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const parts = ['%PDF-1.4\n'];
  let offset = Buffer.byteLength(parts.join(''), 'latin1');
  const offsets = [];
  for (const o of objects) {
    offsets.push(offset);
    parts.push(o);
    offset += Buffer.byteLength(o, 'latin1');
  }
  const xrefPos = offset;
  parts.push('xref\n0 6\n0000000000 65535 f \n');
  for (const off of offsets) parts.push(String(off).padStart(10, '0') + ' 00000 n \n');
  parts.push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
  return Buffer.from(parts.join(''), 'latin1');
}

async function main() {
  const tmpPdf = path.join(require('os').tmpdir(), 'crabpaw_smoke_pdf_' + Date.now() + '.pdf');
  fs.writeFileSync(tmpPdf, makeMinimalPdf());

  let failures = 0;
  try {
    // 1) 最小 PDF：parsePdfBuffer / extractPdfText / extractPdfFull
    const direct = await parsePdfBuffer(fs.readFileSync(tmpPdf));
    KEY(`[1] parsePdfBuffer 最小PDF: text=${JSON.stringify(direct.text.slice(0, 20))} numpages=${direct.numpages}`);
    if (!direct.text.includes('Hello PDF')) { KEY('[1] FAIL: 最小PDF文本缺失'); failures++; }

    const txt = await extractPdfText(tmpPdf);
    KEY(`[2] extractPdfText 最小PDF: ${txt.length} 字符`);
    if (!txt.includes('Hello PDF')) { KEY('[2] FAIL: extractPdfText 文本缺失'); failures++; }

    const full = await extractPdfFull(tmpPdf);
    KEY(`[3] extractPdfFull 最小PDF: success=${full.success} pages=${full.pages?.length} text=${(full.text || '').length}字符`);
    if (!full.success || !full.text.includes('Hello PDF')) { KEY('[3] FAIL: extractPdfFull 结构异常'); failures++; }

    // 2) pdf-to-word-docx 技能（若 docx 依赖可用）
    try {
      const { execute } = require(path.join(ROOT, 'skills/pdf-to-word-docx/executor'));
      const res = await execute({ filePath: tmpPdf, targetFormat: 'txt', outputPath: path.join(require('os').tmpdir(), 'crabpaw_smoke_' + Date.now() + '.txt') });
      KEY(`[4] pdf→txt 技能: success=${res.success}${res.error ? ' err=' + res.error : ''}`);
      if (!res.success) { failures++; }
    } catch (e) {
      KEY(`[4] pdf→txt 技能: 异常 ${e.message}`);
      failures++;
    }

    // 3) 真实 PDF（存在时）：用户上传/工作区 PDF
    const argPdf = process.argv[2];
    const candidates = [
      argPdf,
      path.join(ROOT, 'data/.crabpaw/workspace/uploads/1787344010331_OpenClaw_Windows___________.pdf'),
      path.join(ROOT, 'data/workspace/documents/小龙女智能体介绍.pdf'),
    ].filter(Boolean);
    const realPdf = candidates.find(f => fs.existsSync(f));
    if (realPdf) {
      const real = await extractPdfText(realPdf);
      KEY(`[5] 真实PDF ${path.basename(realPdf)}: ${real.length} 字符 | preview=${JSON.stringify(real.slice(0, 40))}`);
      if (real.length < 10) { KEY('[5] FAIL: 真实PDF文本过短(可能是扫描件无文本层)'); failures++; }
    } else {
      KEY('[5] 无真实PDF样本，跳过（可传路径: node scripts/smoke-pdf-parse.js <file.pdf>）');
    }
  } catch (e) {
    KEY(`[FATAL] ${e.stack || e.message}`);
    failures++;
  } finally {
    try { fs.rmSync(tmpPdf, { force: true }); } catch (_) {}
  }

  KEY(failures === 0 ? '[RESULT] PASS' : `[RESULT] FAIL (${failures} 处失败)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
