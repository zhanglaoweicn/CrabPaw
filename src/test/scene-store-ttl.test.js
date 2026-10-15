/**
 * SceneStore per-surface TTL 测试（2026-08-17）
 *
 * 实机 bug：stocks-card/stocks-kline 查询结果卡无 TTL 永久残留右下角盖对话
 * （20:08 茅台 K线卡 20:23 仍挂窗口），用户反馈"一个卡片遮盖了部分窗口内容"。
 *
 * 修复：upsertSurface 支持 ttlMs——到期自动 removeSurface；内容变化重置
 * 计时（TTL 从最后一次内容变化起算），幂等 upsert 不续命（防 GUI 轮询
 * 无限延长），手动移除取消 timer。
 *
 * 2026-10-15 二次加固：2026-09-18 的轮询改造只覆盖了幂等测试一处，其余
 * "固定睡眠后断言过期"的用例在全量并行负载下仍会因 setTimeout 漂移偶发
 * 失败（实测：全量 237 套件并发时 120ms TTL 在 2s 内未触发的假失败）。
 * 统一改为 waitForExpiry 轮询（上限 5~10s，正常路径 ~150ms 即返回），
 * 并把重置类用例的 TTL 从 60ms 拉大到 500ms，让漂移余量远大于调度抖动。
 */

const { SceneStore } = require('../core/scene/scene-store');

// 2026-10-15 三次加固：全量 237 套件 / 7 worker 饱和负载下，120ms TTL 仍偶发
// 在 10s 轮询窗内未触发（CPU 饥饿导致定时器饥饿，实测单跑 5/5 全绿）。
// 双保险：① 各用例 TTL/余量再拉大；② 本文件声明失败重试 2 次
// （logErrorsBeforeRetry 保留首错详情，不掩盖真实回归）。
jest.retryTimes(2, { logErrorsBeforeRetry: true });

/** 轮询等待 surface 过期移除（默认上限 15s），返回是否如期消失 */
async function waitForExpiry(store, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && store.getSurface(id) !== undefined) {
    await new Promise((res) => setTimeout(res, 25));
  }
  return store.getSurface(id) === undefined;
}

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
      ttlMs: 200,
    });
    expect(r.changed).toBe(true);
    expect(store.getSurface('stocks-kline')).toBeTruthy();

    // 轮询等待过期（并行负载下 setTimeout 会漂移，固定睡眠偶发假失败）
    expect(await waitForExpiry(store, 'stocks-kline')).toBe(true);
    // 到期移除也是一次 change（op: remove）
    expect(changes.some((c) => c.ops.some((o) => o.op === 'remove' && o.id === 'stocks-kline'))).toBe(true);
  });

  test('内容变化重置 TTL（新 TTL 从最后一次变化起算）', async () => {
    // TTL 拉大到 1000ms：漂移余量(≈500ms)远大于调度抖动(通常 <20ms)
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a'], ohlc: [] }, ttlMs: 1000 });
    await new Promise((res) => setTimeout(res, 500)); // t=500 < 1000：未到期

    // 内容变化 + 重新声明 ttlMs → 重置计时（新 TTL 1000ms 从 t=500 起算，t=1500 到期）
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a','b'], ohlc: [{o:1,h:2,l:0.5,c:1.5}] }, ttlMs: 1000 });
    await new Promise((res) => setTimeout(res, 500)); // t=1000 < 1500：若未重置（原 t=1000 到期）此刻已消失，重置后仍在

    expect(store.getSurface('stocks-kline')).toBeTruthy(); // 重置后仍在

    // 轮询等待新 TTL 到期（t≈750）
    expect(await waitForExpiry(store, 'stocks-kline')).toBe(true);
  });

  test('内容变化无 ttlMs 时取消 TTL（旧 timer 不残留）', async () => {
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a'], ohlc: [] }, ttlMs: 100 });
    await new Promise((res) => setTimeout(res, 50));

    // 内容变化但不带 ttlMs → surface 变为永不过期
    store.upsertSurface('stocks-kline', { kind: 'chart', data: { labels: ['a','b'], ohlc: [{o:1,h:2,l:0.5,c:1.5}] } });
    await new Promise((res) => setTimeout(res, 300)); // 已远超原 TTL 100ms

    expect(store.getSurface('stocks-kline')).toBeTruthy();
  });

  test('幂等 upsert 不重置 TTL（防 GUI 轮询无限续命）', async () => {
    store.upsertSurface('stocks-card', { kind: 'stocks', data: { items: [{ code: '600519' }] }, ttlMs: 120 });

    // 幂等（内容相同）upsert × 3，间隔 25ms，全部在 TTL 窗口内完成
    for (let i = 0; i < 3; i++) {
      await new Promise((res) => setTimeout(res, 25));
      store.upsertSurface('stocks-card', { kind: 'stocks', data: { items: [{ code: '600519' }] } });
    }

    // 2026-09-18 加固: 并行 worker 负载下 setTimeout 会漂移, 固定睡眠偶发假失败
    // 2026-10-15 再加固: 上限 2s 在全量 237 套件并发时仍可能不够（实测假失败）,
    // 放宽到 10s——正常路径 ~150ms 即返回, 不拖慢测试
    expect(await waitForExpiry(store, 'stocks-card', 10000)).toBe(true);
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
