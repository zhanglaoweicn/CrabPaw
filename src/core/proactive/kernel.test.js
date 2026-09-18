/**
 * kernel.test.js — ProactiveKernel 统一判定原语（2026-09-18 LoopX P0）
 *
 * 锚定三条不变量：
 *   I1 quiet 不计数 —— 静默入队/去重拒绝/等待确认/超配额一律不 spend，只有播出才记账
 *   I2 gate 是具体确认 —— 当日按内容哈希生效；数据变化哈希变 → 自然过期
 *   I3 单一真值落盘 —— statePath 启用后，去重/配额/确认跨"重启"（模块重载）有效
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

function freshKernel(statePath) {
  jest.resetModules();
  const k = require('./kernel');
  if (statePath) k.configure({ statePath });
  return k;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-kernel-test-'));

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-09-18T10:00:00+08:00'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('五连判定 · native profile', () => {
  test('① quota：cap=2 时第 3 条 deny/quota，且超配额不记账（I1）', () => {
    const k = freshKernel();
        const p = (t) => k.propose({ trigger: 'risk_alert', text: t, cap: 2, native: true });
    expect(p('第一条').decision).toBe('speak');
    k.spend('risk_alert');
    expect(p('第二条').decision).toBe('speak');
    k.spend('risk_alert');
    const v = p('第三条');
    expect(v.decision).toBe('deny');
    expect(v.reason).toBe('quota');
    expect(k.stats().counters.risk_alert).toBe(2); // deny 不 +1
  });

  test('② gate：当日确认同内容 → gate；内容变化哈希变 → 恢复 speak（I2）', () => {
    const k = freshKernel();
        k.markAcked('risk_alert', '应收逾期 1 笔');
    expect(k.propose({ trigger: 'risk_alert', text: '应收逾期 1 笔' }).decision).toBe('gate');
    expect(k.propose({ trigger: 'risk_alert', text: '应收逾期 1 笔' }).reason).toBe('acked_today');
    // 数据变化 → 文本变 → 新哈希 → gate 不命中
    expect(k.propose({ trigger: 'risk_alert', text: '应收逾期 2 笔' }).decision).toBe('speak');
  });

  test('③ dedup：窗内 quiet，且去重拒绝不记账（I1）；过窗恢复 speak', () => {
    const k = freshKernel();
    k.configure({ dedupMs: 60000 });
    const req = { trigger: 't', text: '同一条' };
    expect(k.propose(req).decision).toBe('speak');
    k.spend('t');
    expect(k.propose(req).decision).toBe('quiet');
    expect(k.propose(req).reason).toBe('dedup');
    expect(k.stats().counters.t).toBe(1); // quiet 不 +1
    jest.setSystemTime(new Date('2026-09-18T10:02:00+08:00')); // +2min > 1min 窗
    expect(k.propose(req).decision).toBe('speak');
  });

  test('③ dedup 滑动窗：窗内反复提案会顺延窗口（v1 语义）', () => {
    const k = freshKernel();
    k.configure({ dedupMs: 60000 });
    const req = { trigger: 't', text: '滑动' };
    expect(k.propose(req).decision).toBe('speak');
    jest.setSystemTime(new Date('2026-09-18T10:00:40+08:00')); // +40s < 60s
    expect(k.propose(req).decision).toBe('quiet'); // ts 顺延到 10:00:40
    jest.setSystemTime(new Date('2026-09-18T10:01:10+08:00')); // 距顺延点 30s < 60s
    expect(k.propose(req).decision).toBe('quiet'); // 固定窗此处已放行，滑动窗仍拦
  });

  test('④ intent 分档：confront 静默段豁免直出；inform/ambient 静默入队', () => {
    jest.setSystemTime(new Date('2026-09-18T23:00:00+08:00')); // 静默段（22-8）
    const k = freshKernel();
        expect(k.propose({ trigger: 'a', text: '催收', intent: 'confront', native: true }).decision).toBe('speak');
    const q = k.propose({ trigger: 'b', text: '日程提醒', intent: 'inform' });
    expect(q.decision).toBe('queued');
    expect(q.reason).toBe('silent_hours');
    expect(k.propose({ trigger: 'c', text: '热榜', intent: 'ambient' }).decision).toBe('queued');
  });

  test('静默段入队不记账（I1）', () => {
    jest.setSystemTime(new Date('2026-09-18T23:00:00+08:00'));
    const k = freshKernel();
        k.propose({ trigger: 'b', text: '日程提醒', intent: 'inform' });
    expect(k.stats().counters.b).toBeUndefined();
  });
});

describe('不变量 I1 · 混合路径只记实播', () => {
  test('speak×1 + 静默×1 + 去重×1 → counters 恰为 1', () => {
    const k = freshKernel();
        expect(k.propose({ trigger: 'x', text: '播出' }).decision).toBe('speak');
    k.spend('x');
    jest.setSystemTime(new Date('2026-09-18T23:00:00+08:00'));
    expect(k.propose({ trigger: 'x', text: '入队不记账' }).decision).toBe('queued');
    jest.setSystemTime(new Date('2026-09-18T10:00:00+08:00'));
    expect(k.propose({ trigger: 'x', text: '播出' }).decision).toBe('quiet'); // 同文本去重
    expect(k.stats().counters.x).toBe(1); // 只有首播那次记账
  });
});

describe('legacy profile · v1 行为等价', () => {
  test('无配额：超播不限', () => {
    const k = freshKernel();
    // 提案不带 native → legacy 语义
    for (let i = 0; i < 20; i++) {
      expect(k.propose({ trigger: 't', text: `第${i}条` }).decision).toBe('speak');
    }
  });

  test('confront 在静默段不豁免（v1 无豁免语义）', () => {
    jest.setSystemTime(new Date('2026-09-18T23:00:00+08:00'));
    const k = freshKernel();
    const v = k.propose({ trigger: 't', text: '夜间催收', intent: 'confront' });
    expect(v.decision).toBe('queued');
  });
});

describe('I3 · 单一真值落盘（重启恢复）', () => {
  const statePath = path.join(TMP, 'kernel-state.json');
  const LEGACY_ACK = path.join(TMP, 'proactive-ack.json');

  test('去重/确认/配额跨模块重载有效', () => {
    const k = freshKernel(statePath);
    k.configure({ dedupMs: 60000 });
    k.propose({ trigger: 'r', text: '持久化内容', cap: 1, native: true });
    k.spend('r');
    k.markAcked('r', '已被确认的内容');
    k._flushNow();

    // 模拟进程重启：模块重载 + 同一 statePath
    const k2 = freshKernel(statePath);
    k2.configure({ dedupMs: 60000 });
    expect(k2.propose({ trigger: 'r', text: '持久化内容' }).decision).toBe('quiet'); // 去重未丢
    expect(k2.isAckedToday('r', '已被确认的内容')).toBe(true); // 确认未丢
    expect(k2.propose({ trigger: 'r', text: '新内容', cap: 1, native: true }).decision).toBe('deny'); // 配额未丢
    expect(k2.propose({ trigger: 'r', text: '新内容', cap: 1, native: true }).reason).toBe('quota');
  });

  test('损坏的状态文件降级为全新状态（不抛错，宁可多提醒）', () => {
    const p = path.join(TMP, 'kernel-broken.json');
    fs.writeFileSync(p, '{broken json');
    const k = freshKernel(p);
        expect(k.propose({ trigger: 't', text: '损坏后首条' }).decision).toBe('speak');
  });

  test('旧 proactive-ack.json 一次性迁移：当日确认进入 kernel gates', () => {
    const legacyKey = require('crypto').createHash('sha1')
      .update('risk_alert|迁移确认内容').digest('hex').slice(0, 16);
    fs.writeFileSync(LEGACY_ACK, JSON.stringify({
      [legacyKey]: { day: '2026-09-18', ackedAt: Date.now() },
    }));
    const statePath = path.join(TMP, 'kernel-migrate.json');
    const k = freshKernel(statePath);
        expect(k.isAckedToday('risk_alert', '迁移确认内容')).toBe(true);
    // 迁移后 kernel 状态文件生成
    expect(fs.existsSync(statePath)).toBe(true);
    expect(k.propose({ trigger: 'risk_alert', text: '迁移确认内容' }).decision).toBe('gate');
  });
});

describe('isSilentHour · kernel 层', () => {
  test('跨零点 + 边界 + 相等禁用', () => {
    const k = freshKernel();
    k.configure({ silentStart: 22, silentEnd: 8 });
    jest.setSystemTime(new Date('2026-09-18T23:00:00+08:00'));
    expect(k.isSilentHour()).toBe(true);
    jest.setSystemTime(new Date('2026-09-18T07:59:00+08:00'));
    expect(k.isSilentHour()).toBe(true);
    jest.setSystemTime(new Date('2026-09-18T08:00:00+08:00'));
    expect(k.isSilentHour()).toBe(false);
    k.configure({ silentStart: 8, silentEnd: 8 });
    jest.setSystemTime(new Date('2026-09-18T23:00:00+08:00'));
    expect(k.isSilentHour()).toBe(false); // 相等 = 不启用
  });
});

describe('跨天轮换', () => {
  test('配额按日清零；gate 当日语义不跨天', () => {
    const k = freshKernel();
    k.configure({ dedupMs: 1000 });
    expect(k.propose({ trigger: 'd', text: '昨天那条', cap: 1, native: true }).decision).toBe('speak');
    k.spend('d');
    jest.setSystemTime(new Date('2026-09-19T10:00:00+08:00')); // 次日
    // 去重窗(1s)早已过期 → 同文本重获 speak；配额已轮换
    expect(k.propose({ trigger: 'd', text: '昨天那条', cap: 1, native: true }).decision).toBe('speak');
    expect(k.stats().counters.d).toBeUndefined(); // 新的一天从零起
    // gate 仍按当日：昨天的确认今天不生效
    k.markAcked('d', '昨天的确认');
    jest.setSystemTime(new Date('2026-09-20T10:00:00+08:00'));
    expect(k.isAckedToday('d', '昨天的确认')).toBe(false);
  });
});
