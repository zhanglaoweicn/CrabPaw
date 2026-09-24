/**
 * PDF-to-Word-DOCX 技能执行器
 *
 * 提供 PDF 转 Word（.docx）真实转换。
 * 提取流程：pdf-parse 提取文本 → docx 库构建 .docx 文件。
 *
 * 调用约定：execute(input)
 *   input 必填字段：filePath
 *   input 可选字段：targetFormat（默认 'word'）
 *
 * 依赖：pdf-parse（PDF 文本提取）、docx（Word 文档生成）
 */

const path = require('path');
const fs = require('fs');
// 2026-08-22: 共用 document-tools 的 parsePdfBuffer（pdf-parse v1/v2 双兼容）——
// 直接 require('pdf-parse') 按 v1 API 调用在 v2.4.5 下 TypeError: pdfParse is not a function
const { parsePdfBuffer } = require('../../../src/tools/document-tools');

async function execute(input) {
  const parsed = typeof input === 'string' ? { filePath: input } : (input || {});
  const filePath = parsed.filePath || parsed.file || '';
  const targetFormat = (parsed.targetFormat || 'word').toLowerCase();

  // Validation
  if (!filePath) {
    return {
      success: false,
      error: '缺少必要参数 filePath：请提供要转换的 PDF 文件路径',
    };
  }

  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      success: false,
      error: `文件不存在: ${resolvedPath}`,
      input: { path: resolvedPath, exists: false },
    };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== '.pdf') {
    return {
      success: false,
      error: `不支持的文件格式: ${ext}，当前仅支持 .pdf 输入`,
      input: { path: resolvedPath, exists: true, extension: ext },
    };
  }

  try {
    switch (targetFormat) {
      case 'word':
      case 'docx':
        return await convertToWord(resolvedPath, parsed);
      case 'txt':
      case 'text':
        return await convertToText(resolvedPath, parsed);
      default:
        return {
          success: false,
          error: `不支持的目标格式: ${targetFormat}，当前支持: word, txt`,
        };
    }
  } catch (err) {
    console.error('[pdf-to-word-docx] 转换失败:', err);
    return { success: false, error: `转换失败: ${err.message}` };
  }
}

async function convertToWord(pdfPath, input) {
  // Step 1: Extract text from PDF
  const pdfBuffer = fs.readFileSync(pdfPath);

  let pdfData;
  try {
    pdfData = await parsePdfBuffer(pdfBuffer);
  } catch (parseErr) {
    console.error('[pdf-to-word-docx] PDF 解析失败:', parseErr.message);
    return { success: false, error: `PDF 解析失败: ${parseErr.message}` };
  }

  const text = pdfData.text || '';
  const pageCount = pdfData.numpages || 0;

  if (!text.trim()) {
    return {
      success: false,
      error: 'PDF 文件中未提取到文本内容。如果是扫描件/图片型 PDF，请使用 OCR 工具先进行文字识别。',
      extracted: { pageCount, textLength: 0 },
    };
  }

  // Step 2: Create DOCX with extracted text
  const Docx = require('docx');
  const {
    Document, Paragraph, TextRun, HeadingLevel,
    Packer, SectionType,
  } = Docx;

  // Split text into paragraphs and create document
  const lines = text.split(/\n/);
  const paragraphs = [];

  // Add title
  const baseName = path.basename(pdfPath, '.pdf');
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: baseName, bold: true, size: 32 })],
    heading: HeadingLevel.TITLE,
    spacing: { after: 300 },
  }));

  // Add metadata line
  paragraphs.push(new Paragraph({
    children: [
      new TextRun({
        text: `来源: ${path.basename(pdfPath)}  |  页数: ${pageCount}  |  转换时间: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        italics: true,
        size: 20,
        color: '888888',
      }),
    ],
    spacing: { after: 200 },
  }));

  // Add content paragraphs
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: trimmed, size: 22 })],
        spacing: { after: 120 },
      }));
    } else {
      paragraphs.push(new Paragraph({ spacing: { after: 120 } }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: { type: SectionType.CONTINUOUS },
      children: paragraphs,
    }],
  });

  // Step 3: Write DOCX file
  const outputPath = input.outputPath ||
    path.join(path.dirname(pdfPath), `${baseName}-converted.docx`);
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  return {
    success: true,
    outputPath,
    conversion: {
      from: 'pdf',
      to: 'docx',
      description: 'PDF 文本提取 → DOCX 文档生成',
    },
    extracted: {
      pageCount,
      textLength: text.length,
      paragraphCount: lines.filter(l => l.trim()).length,
    },
    input: { path: pdfPath, exists: true },
    message: `已转换「${path.basename(pdfPath)}」→「${path.basename(outputPath)}」(共 ${pageCount} 页, ${text.length} 字符)`,
  };
}

async function convertToText(pdfPath, input) {
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfData = await parsePdfBuffer(pdfBuffer);

  const outputPath = input.outputPath ||
    path.join(path.dirname(pdfPath), `${path.basename(pdfPath, '.pdf')}-extracted.txt`);

  fs.writeFileSync(outputPath, pdfData.text, 'utf-8');

  return {
    success: true,
    outputPath,
    conversion: { from: 'pdf', to: 'txt' },
    extracted: {
      pageCount: pdfData.numpages || 0,
      textLength: (pdfData.text || '').length,
    },
    message: `已提取文本 (${pdfData.numpages || 0} 页, ${(pdfData.text || '').length} 字符)`,
  };
}

const schema = {
  name: 'pdf-to-word-docx',
  description: 'PDF 转 Word 文档引擎（pdf-parse 提取文本 + docx 构建 .docx）',
  capabilities: ['document_conversion', 'content_extraction'],
  input: {
    filePath: { type: 'file', required: true, description: 'PDF 文件路径' },
    targetFormat: { type: 'string', enum: ['word', 'txt'], description: '目标格式，默认 word' },
    outputPath: { type: 'file', description: '输出路径（可选）' },
  },
  output: {
    outputPath: { type: 'file' },
    conversion: { type: 'object' },
    extracted: { type: 'object' },
  },
  whenNotToUse: '仅需读取 PDF 文本内容时直接用 pdf-parse；图片型/扫描件 PDF 建议先用 OCR 工具',
};

module.exports = { execute, schema };
