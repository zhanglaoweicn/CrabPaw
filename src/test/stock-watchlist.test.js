/**
 * stock-watchlist.test.js — 收藏持久化（2026-08-16）
 * 文件路径注入（tmpdir），验证增删查/去重/上限/损坏恢复。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-test-')), 'watchlist.json');
const wl = require('../tools/stock-watchlist');

beforeEach(() => { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); });

describe('stock-watchlist 存储', () => {
  test('add → 列表含条目；重复 add 去重', () => {
    wl.addWatchlist({ code: '600519', name: '贵州茅台' }, tmp);
    wl.addWatchlist({ code: '600519', name: '贵州茅台' }, tmp);
    const list = wl.listWatchlist(tmp);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('贵州茅台');
  });

  test('remove → 移除；不存在返回 false', () => {
    wl.addWatchlist({ code: '600519', name: '贵州茅台' }, tmp);
    expect(wl.removeWatchlist('600519', tmp)).toBe(true);
    expect(wl.removeWatchlist('600519', tmp)).toBe(false);
    expect(wl.listWatchlist(tmp)).toHaveLength(0);
  });

  test('超上限 → error（WATCHLIST_LIMIT=30）', () => {
    for (let i = 0; i < 30; i++) wl.addWatchlist({ code: String(600000 + i), name: `股${i}` }, tmp);
    const r = wl.addWatchlist({ code: '999999', name: '超限股' }, tmp);
    expect(r.error).toContain('上限');
  });

  test('文件损坏 → 空列表不炸', () => {
    fs.writeFileSync(tmp, '{{{bad json', 'utf8');
    expect(wl.listWatchlist(tmp)).toEqual([]);
  });
});
