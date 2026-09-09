/**
 * PDF 解析兼容测试（2026-08-22）
 *
 * 实机 bug：doc_read/pdf_extract 读取 PDF 全部失败，智能体换工具/换 Python
 * 都拿不到内容，最终向用户道歉放弃。
 *
 * 根因：package.json 声明 pdf-parse ^2.4.5（v2 版本线），v2 把导出从
 * 「可调用函数」(v1: pdfParse(buffer) → {text,numpages,info}) 改为
 * 「命名空间对象」(v2: { PDFParse } 类, new PDFParse({data}) → getText()）。
 * 代码全部按 v1 API 调用 → TypeError: pdfParse is not a function →
 * doc_read/pdf_extract/doc_to_markdown 的 PDF 分支全断。
 *
 * 修复：parsePdfBuffer 兼容封装（v1 callable / v2 PDFParse 类都支持，
 * 统一返回 v1 形状 {text,numpages,info}），document-tools.js 与
 * pdf-to-word-docx 技能共用。
 *
 * 说明：真实解析冒烟在 scripts/smoke-pdf-parse.js（裸 node 跑）——
 * pdfjs 的 fake worker 用动态 import 初始化，jest vm 环境不兼容
 * （A dynamic import callback was invoked without --experimental-vm-modules）。
 * 本测试 mock pdf-parse 验证封装分支选择/返回形状/destroy 调用，
 * 防止代码回归 v1 API 调用方式（v2 形态 mock 下会 TypeError 显红）。
 */

let mockCurrent = {};

// v2 形态假类：记录实例，验证 getText/getInfo/destroy 调用
class FakePDFParse {
  constructor(opts) {
    this.opts = opts;
    FakePDFParse.instances.push(this);
  }
  async getText() { return { text: 'Hello PDF', total: 2 }; }
  async getInfo() { return { total: 2, info: { Title: 'Mock Doc' } }; }
  async destroy() { this.destroyed = true; }
}
FakePDFParse.instances = [];

jest.mock('pdf-parse', () => mockCurrent);

async function withTools(fn) {
  await jest.isolateModulesAsync(async () => {
    const tools = require('../tools/document-tools');
    await fn(tools);
  });
}

beforeEach(() => {
  FakePDFParse.instances = [];
});

describe('PDF 解析兼容封装（pdf-parse v1/v2 双形态）', () => {
  test('v2 形态（{ PDFParse } 类）：new PDFParse({data}) → getText/getInfo → destroy', async () => {
    mockCurrent = { PDFParse: FakePDFParse };
    const buf = Buffer.from('fake pdf bytes');
    await withTools(async ({ parsePdfBuffer }) => {
      const result = await parsePdfBuffer(buf);
      // 统一返回 v1 形状 {text, numpages, info}
      expect(result.text).toBe('Hello PDF');
      expect(result.numpages).toBe(2);
      expect(result.info).toEqual({ Title: 'Mock Doc' });
      // 构造参数透传 data；解析完必须 destroy（防资源泄漏）
      expect(FakePDFParse.instances).toHaveLength(1);
      expect(FakePDFParse.instances[0].opts).toEqual({ data: buf });
      expect(FakePDFParse.instances[0].destroyed).toBe(true);
    });
  });

  test('v1 形态（可调用函数）：直接调用并原样返回', async () => {
    const v1Fn = async (buffer) => ({ text: 'v1 text', numpages: 1, info: {} });
    mockCurrent = v1Fn;
    const buf = Buffer.from('x');
    await withTools(async ({ parsePdfBuffer }) => {
      const result = await parsePdfBuffer(buf);
      expect(result.text).toBe('v1 text');
      expect(result.numpages).toBe(1);
    });
  });

  test('pdf-parse 未安装：parsePdfBuffer 抛清晰错误（不再是占位文本）', async () => {
    mockCurrent = null;
    await withTools(async ({ parsePdfBuffer }) => {
      await expect(parsePdfBuffer(Buffer.from('x'))).rejects.toThrow(/pdf-parse not installed/);
    });
  });

  test('extractPdfText（doc_read PDF 分支）：成功返回文本，不得返回占位/错误文本', async () => {
    mockCurrent = { PDFParse: FakePDFParse };
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'crabpaw_pdf_test_' + Date.now() + '.pdf');
    fs.writeFileSync(tmp, Buffer.from('fake'));
    try {
      await withTools(async ({ extractPdfText }) => {
        const text = await extractPdfText(tmp);
        expect(text).toContain('Hello PDF');
        expect(text).not.toMatch(/pdf-parse|needs/i);
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('extractPdfFull（pdf_extract/doc_to_markdown 分支）：返回结构化结果', async () => {
    mockCurrent = { PDFParse: FakePDFParse };
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'crabpaw_pdf_full_' + Date.now() + '.pdf');
    fs.writeFileSync(tmp, Buffer.from('fake'));
    try {
      await withTools(async ({ extractPdfFull }) => {
        const result = await extractPdfFull(tmp);
        expect(result.success).toBe(true);
        expect(result.text).toContain('Hello PDF');
        expect(result.metadata.pageCount).toBe(2);
        expect(Array.isArray(result.pages)).toBe(true);
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('extractPdfFull 解析失败：返回 success:false 而非抛错（智能体可见真实错误）', async () => {
    mockCurrent = { PDFParse: class Broken {
      constructor() {}
      async getText() { throw new Error('broken pdf'); }
      async destroy() {}
    } };
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'crabpaw_pdf_bad_' + Date.now() + '.pdf');
    fs.writeFileSync(tmp, Buffer.from('not a pdf'));
    try {
      await withTools(async ({ extractPdfFull }) => {
        const result = await extractPdfFull(tmp);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/broken pdf/);
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
