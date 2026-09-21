/**
 * 用量统计日键口径测试（2026-09-21 UTC 日界修复配套）
 *
 * 背景：写入/读取此前用 toISOString() 取 UTC 日键，北京时间 0-8 点的调用
 * 被记入"昨天"，早晨看经营数据直接错数。修复后统一本地日键 localDayKey。
 *
 * 本测试用假时钟把系统时间钉在"本地 0:30"复现日界边界：
 * - 在 UTC+8 机器上此时 UTC 键=昨天，旧实现会把账写到昨天（断言抓住回归）；
 * - 在 UTC 机器（CI）上两键重合，日界差异断言自动跳过，基础断言仍验证口径一致。
 * CRABPAW_DATA_DIR 指向临时目录隔离落盘（同 roundtable.test.js 模式）。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-daykey-test-'));
process.env.CRABPAW_DATA_DIR = TEST_DATA_DIR;

const { localDayKey, recordUsage, getTodayUsage, getRecentUsage } = require('../core/usage-stats');

function todayKeyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

afterAll(() => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
});

describe('usage-stats 本地日键', () => {
  afterEach(() => {
    try { jest.useRealTimers(); } catch (e) { /* 未启 fake timers */ }
  });

  test('localDayKey 输出本地日历天的 YYYY-MM-DD', () => {
    const d = new Date(2026, 8, 21, 0, 30); // 本地 2026-09-21 00:30
    expect(localDayKey(d)).toBe('2026-09-21');
    expect(localDayKey()).toBe(todayKeyOf(new Date()));
  });

  test('本地 0:30 的调用记入当天（0-8 点不再落昨天）', () => {
    const fakeNow = new Date();
    fakeNow.setHours(0, 30, 0, 0); // 本地零点三十分——旧实现的日界危险区
    jest.useFakeTimers();
    jest.setSystemTime(fakeNow);

    const localKey = localDayKey(fakeNow);
    const utcKey = fakeNow.toISOString().split('T')[0];

    recordUsage('test-provider', 'test-model', { prompt_tokens: 100, completion_tokens: 50 });

    const raw = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'usage-stats.json'), 'utf-8'));
    expect(Object.keys(raw.byDay)).toContain(localKey);
    expect(raw.byDay[localKey].requests).toBe(1);
    expect(raw.byDay[localKey].totalTokens).toBe(150);

    // 时区与 UTC 存在日界偏移时（本机 UTC+8 的 0:30 → UTC 键是"昨天"），旧实现写错键
    if (utcKey !== localKey) {
      expect(Object.keys(raw.byDay)).not.toContain(utcKey);
    }
  });

  test('getTodayUsage 与写入同键读取', () => {
    const fakeNow = new Date();
    fakeNow.setHours(0, 30, 0, 0);
    jest.useFakeTimers();
    jest.setSystemTime(fakeNow);

    recordUsage('test-provider', 'test-model', { prompt_tokens: 10, completion_tokens: 5 });
    const today = getTodayUsage();
    expect(today.requests).toBeGreaterThanOrEqual(1);
  });

  test('getRecentUsage 返回本地日历天序列（今天在前反序后今天在末位）', () => {
    const recent = getRecentUsage(3);
    expect(recent).toHaveLength(3);
    const now = new Date();
    expect(recent[2].date).toBe(todayKeyOf(now));
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    expect(recent[1].date).toBe(todayKeyOf(yesterday));
  });
});
