/**
 * evidence-ledger.test.js — 长任务证据/接力账本（2026-09-18 LoopX P1）
 *
 * 锚定不变量：
 *   E1 blocked 必带 blocker（等待必须具体）
 *   E2 upsert 保留 createdAt（首记时刻不因更新丢失）
 *   E3 listResumable 只收可恢复态，running 超时标 stale（进程被强杀现场）
 *   E4 测试态（无 dir/无 CRABPAW_DATA_DIR）走内存态，不写盘
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-evidence-test-'));

function freshLedger(dir) {
  jest.resetModules();
  const { createLedger } = require('./evidence-ledger');
  return createLedger(dir ? { dir } : {});
}

describe('record · upsert 与校验', () => {
  test('正常记录：字段齐全，createdAt 首记保留（E2）', () => {
    const led = freshLedger(path.join(TMP, 'l1'));
    const r1 = led.record({ kind: 'filegen', id: 't1', status: 'running', step: 'collect', summary: '智能家居报告', evidence: { format: 'md' } });
    expect(r1.status).toBe('running');
    expect(r1.createdAt).toBeGreaterThan(0);
    const r2 = led.record({ kind: 'filegen', id: 't1', status: 'running', step: 'writing', summary: '智能家居报告' });
    expect(r2.createdAt).toBe(r1.createdAt); // 更新不清首记
    expect(r2.step).toBe('writing');
    expect(led.get('filegen', 't1').step).toBe('writing');
  });

  test('blocked 必须带 blocker（E1）；missing → 抛错', () => {
    const led = freshLedger(path.join(TMP, 'l2'));
    expect(() => led.record({ kind: 'k', id: 'a', status: 'blocked' })).toThrow(/blocker/);
    const ok = led.record({ kind: 'k', id: 'a', status: 'blocked', blocker: '等待用户补充信息' });
    expect(ok.blocker).toBe('等待用户补充信息');
  });

  test('kind/id 必填；evidence 必须为对象', () => {
    const led = freshLedger(path.join(TMP, 'l3'));
    expect(() => led.record({ id: 'a' })).toThrow(/kind/);
    expect(() => led.record({ kind: 'k' })).toThrow(/id/);
    expect(() => led.record({ kind: 'k', id: 'a', evidence: '不是对象' })).toThrow(/evidence/);
  });
});

describe('listResumable · 可恢复清单', () => {
  test('running/blocked 收录且降序；stale 标记；kinds 过滤（E3）', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-09-18T10:00:00+08:00'));
    const led = freshLedger(path.join(TMP, 'l4'));
    led.record({ kind: 'filegen', id: 'old', status: 'running', step: 'writing', summary: '旧任务' });
    led.record({ kind: 'filegen', id: 'paused', status: 'blocked', blocker: '等待补充', summary: '暂停任务' });
    led.record({ kind: 'video', id: 'v1', status: 'running', step: 'render', summary: '视频任务' });

    // 推进 40 分钟：old（running）变 stale；blocked 不受 stale 语义影响
    jest.setSystemTime(new Date('2026-09-18T10:40:00+08:00'));

    const all = led.listResumable();
    const old = all.find((r) => r.id === 'old');
    expect(old.stale).toBe(true); // running 超 30min 未更新 = 强杀现场
    const paused = all.find((r) => r.id === 'paused');
    expect(paused.stale).toBe(false); // blocked 无 stale 语义

    const onlyFg = led.listResumable({ kinds: ['filegen'] });
    expect(onlyFg).toHaveLength(2);
    expect(onlyFg.every((r) => r.kind === 'filegen')).toBe(true);
    jest.useRealTimers();
  });

  test('staleMs 可覆盖', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-09-18T10:00:00+08:00'));
    const led = freshLedger(path.join(TMP, 'l5'));
    led.record({ kind: 'k', id: 'a', status: 'running' });
    jest.setSystemTime(new Date('2026-09-18T10:05:00+08:00')); // +5min
    expect(led.listResumable()[0].stale).toBe(false); // 默认 30min 阈值未到
    expect(led.listResumable({ staleMs: 60 * 1000 })[0].stale).toBe(true); // 覆盖 1min → stale
    jest.useRealTimers();
  });
});

describe('clear / sweep · 生命周期', () => {
  test('clear 删除记录；sweep 清超龄记录', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-09-18T10:00:00+08:00'));
    const led = freshLedger(path.join(TMP, 'l6'));
    led.record({ kind: 'k', id: 'gone', status: 'running' });
    led.clear('k', 'gone');
    expect(led.get('k', 'gone')).toBeNull();
    expect(led.listResumable()).toHaveLength(0);

    led.record({ kind: 'k', id: 'fresh', status: 'blocked', blocker: '等' });
    expect(led.sweep(60 * 1000)).toBe(0); // 1 分钟内的不清
    jest.setSystemTime(new Date('2026-09-25T10:00:00+08:00')); // 7 天后
    expect(led.sweep(60 * 1000)).toBe(1);
    expect(led.listResumable()).toHaveLength(0);
    jest.useRealTimers();
  });
});

describe('测试态内存隔离（E4）', () => {
  test('无 dir/无 CRABPAW_DATA_DIR + NODE_ENV=test → 内存态，不写盘', () => {
    delete process.env.CRABPAW_DATA_DIR;
    const led = freshLedger(null); // NODE_ENV=test（jest 默认）→ memoryStore
    led.record({ kind: 'k', id: 'mem', status: 'running' });
    expect(led.get('k', 'mem')).not.toBeNull(); // 内存内可用
    // TMP 目录里没有新文件（真实 dir 模式会写 ev_k_mem.json）
    const files = fs.readdirSync(TMP).filter((f) => f.startsWith('ev_'));
    expect(files).toHaveLength(0);
  });

  test('CRABPAW_DATA_DIR 指向临时目录 → 真实写盘 + 跨模块重载可读', () => {
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-ev-data-'));
    process.env.CRABPAW_DATA_DIR = tmpData;
    const led = freshLedger(null);
    led.record({ kind: 'filegen', id: 'persist', status: 'blocked', blocker: '等', summary: '跨重载' });
    // 模拟重启：模块重载
    jest.resetModules();
    const { createLedger } = require('./evidence-ledger');
    const led2 = createLedger();
    const rec = led2.listResumable()[0];
    expect(rec.id).toBe('persist');
    expect(rec.summary).toBe('跨重载');
    delete process.env.CRABPAW_DATA_DIR;
  });
});
