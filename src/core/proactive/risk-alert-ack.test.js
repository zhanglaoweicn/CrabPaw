/**
 * risk-alert-ack.test.js — 风险告警用户确认（2026-09-06）
 *
 * 实机：应收逾期告警每 30 分钟巡检一次、proactive 去重窗口恰好也是 30 分钟 →
 * 同一告警全天重复播报；卡片"知道了"只清本地显示，无持久确认态 → "无法关闭"。
 * 修复：ack-store 按 trigger+内容哈希落盘当日确认，checkAndAlert 命中即跳过；
 * 内容变化（笔数/金额/客户）→ 文本变哈希变 → 自动恢复提醒。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

// ack-store / config 在 require 时读 CRABPAW_DATA_DIR——必须先于模块加载指向临时目录
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-ack-test-'));
process.env.CRABPAW_DATA_DIR = TMP_DATA_DIR;

jest.mock('../sse-broadcast', () => ({ broadcastEvent: jest.fn() }));
// notify mock——断言"告警是否发出"用
jest.mock('./index', () => ({
  notify: jest.fn(() => ({ ok: true })),
  init: jest.fn(),
  isSilentHour: jest.fn(() => false),
  getQueue: jest.fn(() => []),
  flushQueue: jest.fn(() => []),
  flushAndBroadcast: jest.fn(() => 0),
  getCacheSize: jest.fn(() => 0),
  getSilentEnd: jest.fn(() => 8),
}));
// 扫描结果 mock——不碰真实业务库
jest.mock('./morning-briefing-service', () => ({
  scanBusinessRisks: jest.fn(),
}));

const ackStore = require('./ack-store');
const { RiskAlertService } = require('./risk-alert-service');
const { scanBusinessRisks } = require('./morning-briefing-service');
const { notify } = require('./index');

const RISKS = {
  receivableOverdue: 1,
  contractsExpiring: 0,
  totalReceivable: 8800,
  topOverdueCustomers: [{ customer: '某某公司', amount: 8800 }],
};
const ALERT_TEXT = '注意：有 1 笔应收款已逾期，合计约 8,800 元，欠款最多的是 某某公司（8,800元）。';

beforeEach(() => {
  jest.clearAllMocks();
  ackStore._reset();
  // 工作时段（checkAndAlert 有 _inWorkHours 闸：9-20 点）
  jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-09-06T10:00:00+08:00'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ack-store 当日确认存储', () => {
  test('ack 后同内容当日命中；跨天/内容变化自动失效', () => {
    expect(ackStore.isAckedToday('risk_alert', ALERT_TEXT)).toBe(false);
    ackStore.ack('risk_alert', ALERT_TEXT);
    expect(ackStore.isAckedToday('risk_alert', ALERT_TEXT)).toBe(true);
    // 内容变化（数据变了）→ 新哈希 → 未确认
    expect(ackStore.isAckedToday('risk_alert', ALERT_TEXT + '，另有 1 份合同临期。')).toBe(false);
    // 跨天 → day 不匹配 → 未确认
    jest.setSystemTime(new Date('2026-09-07T10:00:00+08:00'));
    expect(ackStore.isAckedToday('risk_alert', ALERT_TEXT)).toBe(false);
  });

  test('确认状态落盘，跨模块重载仍可读（模拟进程重启前的持久化语义）', () => {
    ackStore.ack('risk_alert', ALERT_TEXT);
    jest.resetModules();
    const fresh = require('./ack-store');
    expect(fresh.isAckedToday('risk_alert', ALERT_TEXT)).toBe(true);
  });

  test('损坏/缺失的存储文件降级为未确认（不抛错）', () => {
    fs.writeFileSync(path.join(TMP_DATA_DIR, 'proactive-ack.json'), '{broken json');
    jest.resetModules();
    const fresh = require('./ack-store');
    expect(fresh.isAckedToday('risk_alert', ALERT_TEXT)).toBe(false);
    expect(() => fresh.ack('risk_alert', ALERT_TEXT)).not.toThrow();
  });
});

describe('RiskAlertService 确认后跳过', () => {
  function freshService() {
    // 每个用例新实例——绕开 _lastScan 30 分钟节流
    return new RiskAlertService();
  }

  test('未确认 → 正常告警', async () => {
    scanBusinessRisks.mockReturnValue(RISKS);
    const svc = freshService();
    const n = await svc.checkAndAlert({ businessDbPath: 'fake.db', today: '2026-09-06' });
    expect(n).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].trigger).toBe('risk_alert');
  });

  test('用户确认同内容 → 当日不再告警；确认状态与内容哈希绑定', async () => {
    scanBusinessRisks.mockReturnValue(RISKS);
    const svc = freshService();
    await svc.checkAndAlert({ businessDbPath: 'fake.db', today: '2026-09-06' });
    ackStore.ack('risk_alert', ALERT_TEXT);

    const svc2 = freshService();
    const n = await svc2.checkAndAlert({ businessDbPath: 'fake.db', today: '2026-09-06' });
    expect(n).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1); // 仍是首次那一条
  });

  test('数据变化（告警文本变化）→ 自动恢复提醒', async () => {
    ackStore.ack('risk_alert', ALERT_TEXT);
    scanBusinessRisks.mockReturnValue({ ...RISKS, receivableOverdue: 2, totalReceivable: 17600 });
    const svc = freshService();
    const n = await svc.checkAndAlert({ businessDbPath: 'fake.db', today: '2026-09-06' });
    expect(n).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('确认覆盖静默判断之前：零风险照旧不告警', async () => {
    scanBusinessRisks.mockReturnValue({ receivableOverdue: 0, contractsExpiring: 0 });
    const svc = freshService();
    const n = await svc.checkAndAlert({ businessDbPath: 'fake.db', today: '2026-09-06' });
    expect(n).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });
});
