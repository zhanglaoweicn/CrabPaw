/**
 * tool-result-storage 单元测试——P0-2(Runtime优化轮)
 * 覆盖: 迁移到 DATA_DIR/tool-results、旧 tmpdir 路径兜底读取、TTL 清理。
 *
 * 注意: DATA_DIR 在 config require 期固化,本文件在 require 之前设置
 * CRABPAW_DATA_DIR 指向临时目录(与 trajectory-rotation 同款机制)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-result-store-'));
process.env.CRABPAW_DATA_DIR = TMP_ROOT;

const storage = require('./tool-result-storage');
const { DATA_DIR } = require('./config');

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  // 旧 tmpdir 测试产物
  try { fs.rmSync(path.join(os.tmpdir(), 'crabpaw-results'), { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('P0-2: 工具结果落盘迁移', () => {
  test('大结果持久化到 DATA_DIR/tool-results(不再写 os.tmpdir)', () => {
    const big = 'x'.repeat(150000); // 默认阈值 100_000,超限才落盘
    const result = storage.persistToolResult({ toolUseId: 'tu_1', content: big, toolName: 'WebFetch' });
    expect(result.persisted).toBe(true);
    expect(result.filePath).toContain(path.join('tool-results'));
    expect(result.filePath).not.toContain('crabpaw-results');
    expect(fs.existsSync(result.filePath)).toBe(true);
    // 注入模型的是带持久化标记的预览
    expect(result.content).toContain(storage.PERSISTED_TAG_OPEN);
    expect(result.content.length).toBeLessThan(big.length);
  });

  test('小结果不落盘', () => {
    const result = storage.persistToolResult({ toolUseId: 'tu_2', content: 'small', toolName: 'Read' });
    expect(result.persisted).toBe(false);
    expect(result.content).toBe('small');
  });

  test('readPersistedResult 完整读回', () => {
    const big = 'y'.repeat(120000);
    const result = storage.persistToolResult({ toolUseId: 'tu_3', content: big, toolName: 'Bash' });
    expect(result.persisted).toBe(true);
    expect(storage.readPersistedResult(result.filePath)).toBe(big);
  });

  test('旧 tmpdir 路径兜底: 给文件名可读到 legacy crabpaw-results', () => {
    const legacyDir = path.join(os.tmpdir(), 'crabpaw-results');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'legacy_case.txt');
    fs.writeFileSync(legacyFile, 'legacy-content', 'utf-8');
    // 全路径直接可读(历史会话嵌入的旧路径)
    expect(storage.readPersistedResult(legacyFile)).toBe('legacy-content');
    // 只给文件名也能兜底读到
    expect(storage.readPersistedResult('legacy_case.txt')).toBe('legacy-content');
    expect(storage.readPersistedResult('no_such_file.txt')).toBeNull();
  });

  test('cleanOldResults 按 mtime 清理新目录+旧目录', () => {
    const dir = path.join(DATA_DIR, 'tool-results');
    const oldFile = path.join(dir, 'old_case.txt');
    fs.writeFileSync(oldFile, 'old', 'utf-8');
    const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 天前
    fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime)); // Windows 下须传 Date
    const freshFile = path.join(dir, 'fresh_case.txt');
    fs.writeFileSync(freshFile, 'fresh', 'utf-8');

    const cleaned = storage.cleanOldResults(7 * 24 * 60 * 60 * 1000);
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });
});
