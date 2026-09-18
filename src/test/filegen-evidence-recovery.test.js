/**
 * filegen-evidence-recovery.test.js — 文件生成任务跨重启恢复（2026-09-18 LoopX P1）
 *
 * 场景：7x24 一体机被 Windows Update 强杀时，生成任务死在半路——此前 currentTask
 * 纯内存，重启即失忆。现在：
 *   - 状态变更同步 evidence-ledger（ev_filegen_<taskId>.json）
 *   - 重启后（模块重载模拟）hasResumableTask/getPausedTask/getFileGenStatus 任一
 *     查询入口惰性复活为 paused 壳，走既有 resumeFileGenTask"继续"链路
 *   - 终态（done/error/cancelled）→ 账本清除，不再打扰
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-fg-ev-'));
process.env.CRABPAW_DATA_DIR = TMP_DATA_DIR;

jest.mock('../core/sse-broadcast', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../core/scene/scene-store', () => {
  const mockStore = { upsertSurface: jest.fn() };
  return { getSceneStore: jest.fn(() => mockStore) };
});
jest.mock('../core/panel-state', () => ({
  SURFACE_PANEL_MAP: { 'file-panel': 'filegen' },
  setPanelState: jest.fn(),
  getEffectiveState: jest.fn(() => null),
}));
jest.mock('../core/doc-artifacts/registry', () => ({
  registerArtifact: jest.fn(async () => ({ ok: true })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-09-18T10:00:00+08:00'));
});

afterEach(() => {
  jest.useRealTimers();
});

function loadFresh() {
  jest.resetModules();
  return require('../core/filegen-events');
}

describe('filegen × evidence-ledger 跨重启恢复', () => {
  test('生成中被杀 → 重启后查询入口复活 paused 壳 → "继续"链路可用', async () => {
    let fg = loadFresh();
    const taskId = fg.ensureFileGenTask({ title: '智能家居市场报告', format: 'md', originalMessage: '写一份智能家居市场报告' });
    fg.phaseFileGen(taskId, 'writing', '正在撰写…');

    // 模拟进程强杀 + 重启（模块重载，同一 CRABPAW_DATA_DIR）
    fg = loadFresh();
    expect(fg.hasResumableTask()).toBe(true);
    const paused = fg.getPausedTask();
    expect(paused).not.toBeNull();
    expect(paused.taskId).toBe(taskId);
    expect(paused.title).toBe('智能家居市场报告');

    // "继续"链路复活为 collect，返回任务上下文快照
    const ctx = fg.resumeFileGenTask();
    expect(ctx).not.toBeNull();
    expect(ctx.taskId).toBe(taskId);
    expect(ctx.phase).toBe('collect');
    // 恢复任务同步了 files 引用（面板快照不裂）
    expect(fg.getFileGenStatus().taskId).toBe(taskId);
  });

  test('证据记录带 step/summary/evidence（接力者够认任务）', () => {
    const fg = loadFresh();
    const taskId = fg.ensureFileGenTask({ title: '周报', format: 'md' });
    fg.phaseFileGen(taskId, 'collect', '准备内容…');
    const { createLedger } = require('../core/evidence-ledger');
    const rec = createLedger().get('filegen', taskId);
    expect(rec).not.toBeNull();
    expect(rec.step).toBe('collect');
    expect(rec.summary).toBe('周报');
    expect(rec.evidence.format).toBe('md');
  });

  test('done 终态 → 账本清除，重启后无可恢复任务', async () => {
    let fg = loadFresh();
    const taskId = fg.ensureFileGenTask({ title: '已完成文档', format: 'md' });
    await fg.doneFileGen(taskId, { path: '/tmp/final.md', name: 'final.md', format: 'md' });

    fg = loadFresh();
    expect(fg.hasResumableTask()).toBe(false);
    expect(fg.getPausedTask()).toBeNull();
    const { createLedger } = require('../core/evidence-ledger');
    expect(createLedger().get('filegen', taskId)).toBeNull();
  });

  test('fail 终态 → 账本清除', () => {
    let fg = loadFresh();
    const taskId = fg.ensureFileGenTask({ title: '失败文档', format: 'md' });
    fg.failFileGen(taskId, '模型超时');

    fg = loadFresh();
    expect(fg.hasResumableTask()).toBe(false);
    const { createLedger } = require('../core/evidence-ledger');
    expect(createLedger().get('filegen', taskId)).toBeNull();
  });

  test('恢复壳走"继续"不重播 filegen:start（重启不主动打扰）', () => {
    let fg = loadFresh();
    const taskId = fg.ensureFileGenTask({ title: '长任务', format: 'md' });
    fg.phaseFileGen(taskId, 'writing', '正在撰写…');

    fg = loadFresh(); // 重启
    const { broadcastEvent: freshBroadcast } = require('../core/sse-broadcast'); // 新注册表的 mock
    fg.resumeFileGenTask(); // 只广播 filegen:phase
    expect(freshBroadcast).not.toHaveBeenCalledWith('filegen:start', expect.anything());
    const t = fg.getFileGenStatus();
    expect(t.taskId).toBe(taskId); // startedAt 已由 resume 刷新 → 后续插桩不裂任务
  });
});
