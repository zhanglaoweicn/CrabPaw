/**
 * SceneStore per-surface TTL 测试（2026-08-17）
 *
 * 实机 bug：stocks-card/stocks-kline 查询结果卡无 TTL 永久残留右下角盖对话
 * （20:08 茅台 K线卡 20:23 仍挂窗口），用户反馈"一个卡片遮盖了部分窗口内容"。
 *
 * 修复：upsertSurface 支持 ttlMs——到期自动 removeSurface；内容变化重置
 * 计时（TTL 从最后一次内容变化起算），幂等 upsert 不续命（防 GUI 轮询
 * 无限延长），手动移除取消 timer。
 */

const { SceneStore } = require('../core/scene/scene-store');

describe('SceneStore TTL', () => {
  let store;

  beforeEach(() => {
    store = new SceneStore();
  });

  afterEach(() => {
    store.removeAllListeners();
  });

  test('ttlMs 到期自动移除 surface（rev 递增 + change 广播）', async () => {
    const changes = [];
    store.on('change', (c) => changes.push(c));

    const r = store.upsertSurface('stocks-kline', {
      kind: 'chart',
      data: { labels: ['a'], ohlc: [] },
      ttlMs: 50,
    });
    expect(r.changed).toBe(true);
    expect(store.getSurface('stocks-kline')).toBeTruthy();

    await new Promise((res) => setTimeout(res, 150));

    expect(store.getSurface('stocks-kline')).toBeUndefined();
    // 到期移除也是一次 change（op: remove）
    expect(changes.some((c) => c.ops.some((o) => o.op === 'remove' && o.id === 'stocks-kline'))).toBe(true);
  });

  test('内容变化重置 TTL（新 TTL 从最后一次变化起算）', async () => {
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a'], ohlc: [] }, ttlMs: 60 });
    await new Promise((res) => setTimeout(res, 40)); // 未到期

    // 内容变化 + 重新声明 ttlMs → 重置计时（新 TTL 60ms 从 t=40 起算，t=100 到期）
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a','b'], ohlc: [{o:1,h:2,l:0.5,c:1.5}] }, ttlMs: 60 });
    await new Promise((res) => setTimeout(res, 40)); // t=80 < 100：若未重置（原 t=60 到期）此刻已消失，重置后仍在

    expect(store.getSurface('stocks-kline')).toBeTruthy(); // 重置后仍在

    await new Promise((res) => setTimeout(res, 80)); // t=160 > 100：新 TTL 到期
    expect(store.getSurface('stocks-kline')).toBeUndefined();
  });

  test('内容变化无 ttlMs 时取消 TTL（旧 timer 不残留）', async () => {
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a'], ohlc: [] }, ttlMs: 60 });
    await new Promise((res) => setTimeout(res, 40));

    // 内容变化但不带 ttlMs → surface 变为永不过期
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a','b'], ohlc: [{o:1,h:2,l:0.5,c:1.5}] } });
    await new Promise((res) => setTimeout(res, 120));

    expect(store.getSurface('stocks-kline')).toBeTruthy();
  });

  test('幂等 upsert 不重置 TTL（防 GUI 轮询无限续命）', async () => {
    store.upsertSurface('stocks-card', { kind: 'stocks', data: { items: [{ code: '600519' }] }, ttlMs: 120 });

    // 幂等（内容相同）upsert × 3，间隔 25ms，全部在 TTL 窗口内完成
    for (let i = 0; i < 3; i++) {
      await new Promise((res) => setTimeout(res, 25));
      store.upsertSurface('stocks-card', { kind: 'stocks', data: { items: [{ code: '600519' }] } });
    }

    await new Promise((res) => setTimeout(res, 150)); // 超过首个 120ms TTL
    expect(store.getSurface('stocks-card')).toBeUndefined();
  });

  test('手动 removeSurface 取消 TTL timer', async () => {
    store.upsertSurface('stocks-card', { kind: 'stocks', data: { items: [] }, ttlMs: 60 });
    store.removeSurface('stocks-card');

    // 等待超过 TTL——不应有二次 change / 报错
    await new Promise((res) => setTimeout(res, 120));
    expect(store.getSurface('stocks-card')).toBeUndefined();
    expect(store.currentRev).toBe(2); // 仅 upsert + remove 两次变化
  });

  test('无 ttlMs 的 surface 不受影响（永不过期）', async () => {
    store.upsertSurface('persistent', { kind: 'text', data: { text: 'x' } });
    await new Promise((res) => setTimeout(res, 120));
    expect(store.getSurface('persistent')).toBeTruthy();
  });

  test('setScene 整体替换清除旧 surface 的 timer', async () => {
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a'], ohlc: [] }, ttlMs: 60 });
    store.setScene([{ id: 'other', kind: 'text', data: { text: 'y' } }]);

    // 旧 timer 已清——超过 TTL 不应把已移除的 surface 再操作
    await new Promise((res) => setTimeout(res, 120));
    expect(store.getSurface('stocks-kline')).toBeUndefined();
    expect(store.getSurface('other')).toBeTruthy();
  });
});
