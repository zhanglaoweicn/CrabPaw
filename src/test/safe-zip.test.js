// safe-zip 安全解压测试——extract-zip 全版本 zip-slip (CVSS 8.1, 无上游补丁) 收口
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

function makeZip(entries) {
  const z = new AdmZip();
  for (const [name, content] of entries) {
    if (content === null) z.addFile(name, null); // 目录
    else z.addFile(name, Buffer.from(content));
  }
  return z.toBuffer();
}

// 手工构造 zip 字节（stored 不压缩）：adm-zip 的 addFile 在写入侧就会把 ../ 等
// 危险名"修复"掉（zipnamefix），测不到真实恶意包；读侧 getEntries 不消毒，
// 故恶意 fixture 必须绕过 adm-zip 写入、直接造原始字节。
// 条目格式 [name, content, externalAttr?]：externalAttr 写入 CEN 目录记录
// offset 38 处（adm-zip EntryHeader 从该处读 external attributes，高 16 位是
// unix st_mode）——用于构造 S_IFLNK 符号链接条目。
function rawZip(entries) {
  const { crc32 } = require('adm-zip/util/utils');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, externalAttr] of entries) {
    const nameBuf = Buffer.from(name, 'binary');
    const data = Buffer.from(content);
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([lh, nameBuf, data]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(externalAttr >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('safeExtractZip 安全解压', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-zip-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('正常 zip 解压成功且返回条目', async () => {
    const zip = path.join(dir, 'ok.zip');
    fs.writeFileSync(zip, makeZip([['a.txt', 'hello'], ['sub/b.txt', 'world']]));
    const { safeExtractZip } = require('../core/safe-zip');
    const files = await safeExtractZip(zip, dir);
    expect(files.sort()).toEqual(['a.txt', path.join('sub', 'b.txt')]);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('hello');
  });

  test('目录条目被创建且不计入返回列表', async () => {
    const zip = path.join(dir, 'with-dir.zip');
    fs.writeFileSync(zip, makeZip([['sub/', null], ['sub/c.txt', 'z']]));
    const { safeExtractZip } = require('../core/safe-zip');
    const files = await safeExtractZip(zip, dir);
    expect(files).toEqual([path.join('sub', 'c.txt')]);
    expect(fs.readFileSync(path.join(dir, 'sub', 'c.txt'), 'utf8')).toBe('z');
  });

  // 精确断言各自命中的校验分支（不再共用过宽 /unsafe|越界|条目/i）：
  // 越界=resolve 上跳出 destDir 先抛; 危险路径形态=resolve 拦不住的显式形态
  // (前导 / 与 ..\ 在 Windows resolve 阶段即越界, 盘符段形态在第二道抛)。
  test.each([
    ['../evil.txt', 'zip-slip 相对上跳', /越界/],
    ['abs/C:/evil.txt', '绝对路径形态', /危险路径形态/],
    ['a/../../evil.txt', '嵌套上跳', /越界/],
    ['/etc/evil.txt', '绝对路径前导斜杠', /越界/],
    ['..\\win\\evil.txt', '反斜杠上跳', /越界/],
  ])('恶意条目 %s 被拒绝且不落盘 (%s)', async (name, _desc, expected) => {
    const zip = path.join(dir, 'evil.zip');
    fs.writeFileSync(zip, rawZip([[name, 'x'], ['ok.txt', 'y']]));
    const { safeExtractZip } = require('../core/safe-zip');
    await expect(safeExtractZip(zip, dir)).rejects.toThrow(expected);
    expect(fs.existsSync(path.join(dir, 'ok.txt'))).toBe(false); // 全有或全无
    expect(fs.existsSync(path.resolve(dir, 'evil.txt'))).toBe(false);
  });

  test('符号链接条目被拒绝(S_IFLNK external attrs, 可指向任意路径)', async () => {
    const zip = path.join(dir, 'symlink.zip');
    // unix external attrs 高 16 位是 st_mode, S_IFLNK=0xA000; 内容=链接目标
    const linkAttr = (0xa000 | 0o777) << 16;
    fs.writeFileSync(zip, rawZip([['link.txt', '/etc/passwd', linkAttr], ['ok.txt', 'y']]));
    const { safeExtractZip } = require('../core/safe-zip');
    await expect(safeExtractZip(zip, dir)).rejects.toThrow(/符号链接|symlink/i);
    expect(fs.existsSync(path.join(dir, 'ok.txt'))).toBe(false); // 全有或全无
    expect(fs.existsSync(path.join(dir, 'link.txt'))).toBe(false);
  });

  test.each([
    ['', '空条目名'],
    ['.', '点号条目名'],
  ])('%s 被拒绝(防 resolve 归一到 destDir 本身绕过越界检查)', async (name, _desc) => {
    const zip = path.join(dir, 'weird-name.zip');
    fs.writeFileSync(zip, rawZip([[name, 'x'], ['ok.txt', 'y']]));
    const { safeExtractZip } = require('../core/safe-zip');
    await expect(safeExtractZip(zip, dir)).rejects.toThrow(/空条目名/);
    expect(fs.existsSync(path.join(dir, 'ok.txt'))).toBe(false);
  });

  test('条目数超上限被拒绝', async () => {
    const zip = path.join(dir, 'many.zip');
    const entries = [];
    for (let i = 0; i < 5; i++) entries.push([`f${i}.txt`, 'x']);
    fs.writeFileSync(zip, makeZip(entries));
    const { safeExtractZip } = require('../core/safe-zip');
    await expect(safeExtractZip(zip, dir, { maxEntries: 4 })).rejects.toThrow(/条目超上限/);
    expect(fs.existsSync(path.join(dir, 'f0.txt'))).toBe(false);
  });

  test('解压总量超上限被拒绝', async () => {
    const zip = path.join(dir, 'big.zip');
    fs.writeFileSync(zip, makeZip([['big.bin', Buffer.alloc(1024).fill('a')]]));
    const { safeExtractZip } = require('../core/safe-zip');
    await expect(safeExtractZip(zip, dir, { maxTotalBytes: 512 })).rejects.toThrow(/总量超上限/);
    expect(fs.existsSync(path.join(dir, 'big.bin'))).toBe(false);
  });

  test('zip 文件不存在抛错', async () => {
    const { safeExtractZip } = require('../core/safe-zip');
    await expect(safeExtractZip(path.join(dir, 'nope.zip'), dir)).rejects.toThrow();
  });
});
