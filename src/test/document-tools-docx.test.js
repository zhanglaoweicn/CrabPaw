/**
 * document-tools-docx.test.js — docx_generate 回归（2026-08-22）
 * 锁定两个生产 bug：
 *   1. [Content_Types].xml 被数组解构截成 1 字节（'<'）→ WPS 打开报「文件损坏」
 *   2. title 缺失时裸 .replace 崩（Cannot read properties of undefined (reading 'replace')）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { _generateDocx } = require('../tools/document-tools');
const { registry } = require('../tools/registry');

// zip 条目读取：按 central directory 定位 → local header 解析 → 解压
function readZipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(pos + 28);
    const entryName = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const localOff = buf.readUInt32LE(pos + 42);
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const data = buf.slice(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + compSize);
      return method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
    }
    pos += 46 + nameLen + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  throw new Error(`条目不存在: ${name}`);
}

describe('docx_generate 产物完整性（2026-08-22 修复回归）', () => {
  test('zip 内 [Content_Types].xml 完整（>100 字节且含 <Types）——此前被截成 1 字节「<」', async () => {
    const buf = await _generateDocx('# 标题\n\n正文段落', '测试文档', '商务报告');
    expect(buf.slice(0, 2).toString('hex')).toBe('504b'); // PK
    const ct = readZipEntry(buf, '[Content_Types].xml');
    expect(ct.length).toBeGreaterThan(100);
    expect(ct).toContain('<Types');
    expect(ct).toContain('wordprocessingml.document.main+xml');
  });

  test('document.xml / styles.xml / footer1.xml 均可解出且内容合法', async () => {
    const buf = await _generateDocx('# 标题\n\n**加粗** 与 `代码`', '测试文档', '商务报告');
    const doc = readZipEntry(buf, 'word/document.xml');
    expect(doc).toContain('<w:document');
    expect(doc).toContain('标题');
    expect(readZipEntry(buf, 'word/styles.xml')).toContain('<w:styles');
    expect(readZipEntry(buf, 'word/footer1.xml')).toContain('<w:ftr');
  });
});

describe('docx_generate handler 参数防御', () => {
  const getTool = () => registry._tools.get('DocxGenerate');

  test('title 缺失不崩（回归: Cannot read properties of undefined (reading \'replace\')）', async () => {
    const tool = getTool();
    expect(tool).toBeTruthy();
    const out = path.join(os.tmpdir(), `docx-no-title-${Date.now()}.docx`);
    const res = await tool.handler({ content: '# 标题\n\n正文', outputPath: out });
    expect(res.success).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out).slice(0, 2).toString('hex')).toBe('504b');
    fs.unlinkSync(out);
  });

  test('content 缺失仍返回明确错误（不抛异常）', async () => {
    const tool = getTool();
    const res = await tool.handler({ title: '文档' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Word generation failed');
  });
});
