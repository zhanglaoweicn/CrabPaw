/**
 * meeting-events.test.js — 会议记录事件模块（2026-08-18）
 * mock sse-broadcast / scene-store / panel-state / meeting-store，
 * 锁定 start→stop→summary 广播序列 + surface 快照驱动 + panel-state open 写入。
 */
jest.mock('../core/sse-broadcast', () => ({
  broadcastEvent: jest.fn(),
}));
jest.mock('../core/scene/scene-store', () => {
  const mockStore = { upsertSurface: jest.fn() };
  return { getSceneStore: jest.fn(() => mockStore) };
});
const mockPanelStates = {};
jest.mock('../core/panel-state', () => ({
  SURFACE_PANEL_MAP: { 'meeting-panel': 'meeting' },
  setPanelState: jest.fn((panel, state) => { mockPanelStates[panel] = state; }),
  getEffectiveState: jest.fn((panel) => mockPanelStates[panel] ?? null),
}));
jest.mock('../core/meeting-store', () => {
  const live = {}; // meetingId → meeting（跨调用共享，模拟真实磁盘态）
  return {
    createMeeting: jest.fn(({ title } = {}) => {
      const m = { id: 'mtg_test_' + (Object.keys(live).length + 1), title: title || '会议', date: new Date().toISOString(), status: 'recording', segments: [] };
      live[m.id] = m;
      return m;
    }),
    getMeeting: jest.fn((id) => live[id] || null),
    updateSummary: jest.fn((id, { summary, keyPoints }) => {
      if (!live[id]) return null;
      live[id].summary = summary; live[id].keyPoints = keyPoints; live[id].status = 'done';
      return live[id];
    }),
    setMeetingStatus: jest.fn((id, status) => {
      if (!live[id]) return null;
      live[id].status = status;
      return live[id];
    }),
  };
});

const { broadcastEvent } = require('../core/sse-broadcast');
const { getSceneStore } = require('../core/scene/scene-store');
const {
  startMeeting, stopMeetingSignal, completeMeeting, failMeeting,
  updateMeetingSurface, getMeetingStatus, MEETING_PANEL_SURFACE, MEETING_PANEL_KIND,
  _resetForTest,
} = require('../core/meeting-events');

beforeEach(() => {
  jest.clearAllMocks();
  _resetForTest(); // 清模块级 currentMeeting，防用例间泄漏
});

describe('meeting-events 广播序列', () => {
  test('startMeeting 建会 + 广播 meeting:start + surface 打开(recording)', () => {
    const m = startMeeting({ title: '周会' });
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:start', { meetingId: m.id, title: '周会' });
    const upsert = getSceneStore().upsertSurface;
    expect(upsert).toHaveBeenCalledTimes(1);
    const [id, payload] = upsert.mock.calls[0];
    expect(id).toBe(MEETING_PANEL_SURFACE);
    expect(payload.kind).toBe(MEETING_PANEL_KIND);
    expect(payload.data.status).toBe('recording');
    expect(payload.data.meetingId).toBe(m.id);
  });

  test('startMeeting 写入 panel-state open（SURFACE_PANEL_MAP meeting-panel→meeting）', () => {
    const { setPanelState, getEffectiveState } = require('../core/panel-state');
    startMeeting({ title: 'T' });
    expect(setPanelState).toHaveBeenCalledWith('meeting', 'open');
    expect(getEffectiveState('meeting')).toBe('open');
  });

  test('stopMeetingSignal 广播 meeting:stop + surface summarizing + 磁盘状态迁移', () => {
    const m = startMeeting({ title: 'T' });
    broadcastEvent.mockClear();
    const store = require('../core/meeting-store');
    const ret = stopMeetingSignal(m.id);
    expect(ret).toBe(m.id);
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:stop', { meetingId: m.id });
    const upsert = getSceneStore().upsertSurface;
    expect(upsert.mock.calls[upsert.mock.calls.length - 1][1].data.status).toBe('summarizing');
    expect(store.setMeetingStatus).toHaveBeenCalledWith(m.id, 'summarizing');
  });

  test('completeMeeting 广播 meeting:summary + surface done + panel-state 重开', () => {
    const m = startMeeting({ title: 'T' });
    broadcastEvent.mockClear();
    const { setPanelState } = require('../core/panel-state');
    setPanelState.mockClear();
    completeMeeting(m.id, { summary: '摘要', keyPoints: ['k1'] });
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:summary', { meetingId: m.id, summary: '摘要', keyPoints: ['k1'] });
    const upsert = getSceneStore().upsertSurface;
    const last = upsert.mock.calls[upsert.mock.calls.length - 1][1].data;
    expect(last.status).toBe('done');
    expect(last.summary).toBe('摘要');
    expect(setPanelState).toHaveBeenCalledWith('meeting', 'open');
  });

  test('failMeeting 广播 meeting:error + surface error + 磁盘状态 error', () => {
    const m = startMeeting({ title: 'T' });
    broadcastEvent.mockClear();
    const store = require('../core/meeting-store');
    failMeeting(m.id, '总结超时');
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:error', { meetingId: m.id, message: '总结超时' });
    const upsert = getSceneStore().upsertSurface;
    expect(upsert.mock.calls[upsert.mock.calls.length - 1][1].data.status).toBe('error');
    expect(store.setMeetingStatus).toHaveBeenCalledWith(m.id, 'error');
    expect(getMeetingStatus().error).toBe('总结超时');
  });

  test('新会议顶掉旧会议（单会议覆盖语义）', () => {
    const a = startMeeting({ title: '旧' });
    const b = startMeeting({ title: '新' });
    expect(a.id).not.toBe(b.id);
    const st = getMeetingStatus();
    expect(st.meetingId).toBe(b.id);
    expect(st.title).toBe('新');
  });

  test('stopMeetingSignal 无参会话默认取当前会议；无会议返回 null 且不广播', () => {
    jest.clearAllMocks();
    expect(stopMeetingSignal()).toBeNull();
    expect(broadcastEvent).not.toHaveBeenCalled();
  });

  test('panel-state 写入失败不阻塞广播与 surface（隔离）', () => {
    const { setPanelState } = require('../core/panel-state');
    setPanelState.mockImplementation(() => { throw new Error('panel-state 爆炸'); });
    const m = startMeeting({ title: 'T' });
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:start', expect.objectContaining({ meetingId: m.id }));
    expect(getMeetingStatus().meetingId).toBe(m.id);
  });

  test('updateMeetingSurface 刷新快照但不广播', () => {
    startMeeting({ title: 'T' });
    broadcastEvent.mockClear();
    updateMeetingSurface();
    expect(broadcastEvent).not.toHaveBeenCalled();
    expect(getSceneStore().upsertSurface.mock.calls.length).toBeGreaterThan(1);
  });

  test('getMeetingStatus 快照含摘要字段（磁盘为准）', () => {
    const m = startMeeting({ title: 'T' });
    completeMeeting(m.id, { summary: 'S', keyPoints: ['k'] });
    const st = getMeetingStatus();
    expect(st.summary).toBe('S');
    expect(st.keyPoints).toEqual(['k']);
  });

  test('stopMeetingSignal 对已完成会议幂等: 不降级 summarizing、不重复广播（R3 竞态实锤）', () => {
    const m = startMeeting({ title: 'T' });
    completeMeeting(m.id, { summary: 'S', keyPoints: ['k'] });
    broadcastEvent.mockClear();
    const store = require('../core/meeting-store');
    store.setMeetingStatus.mockClear();
    const ret = stopMeetingSignal(m.id);
    expect(ret).toBe(m.id);
    expect(store.setMeetingStatus).not.toHaveBeenCalledWith(m.id, 'summarizing');
    expect(broadcastEvent).not.toHaveBeenCalledWith('meeting:stop', expect.anything());
  });

  test('historyMeetingSignal 仅广播 meeting:history, 不建会不落盘不写 panel-state', () => {
    const { historyMeetingSignal } = require('../core/meeting-events');
    broadcastEvent.mockClear();
    const { setPanelState } = require('../core/panel-state');
    setPanelState.mockClear();
    const ret = historyMeetingSignal();
    expect(ret).toBe(true);
    expect(broadcastEvent).toHaveBeenCalledTimes(1);
    expect(broadcastEvent).toHaveBeenCalledWith('meeting:history', {});
    expect(setPanelState).not.toHaveBeenCalled();
    const store = require('../core/meeting-store');
    expect(store.createMeeting).not.toHaveBeenCalled();
  });
});
