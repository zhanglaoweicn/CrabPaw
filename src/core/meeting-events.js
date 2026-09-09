/**
 * meeting-events.js — 会议记录事件模块（2026-08-18）
 *
 * 镜像 filegen-events.js：统一广播 meeting:start/stop/summary/error（SSE /events
 * 通道），维护内存当前会议态，并驱动 scene surface 'meeting-panel' 的打开与快照
 * 更新（面板重开时经 useSceneClient 快照恢复视图状态）。
 *
 * 单会议语义：新 start 顶掉旧会议（与 filegen 单任务覆盖一致）。
 * surface kind 用 'meeting-panel'（非旧 kind meeting_recording），避开
 * SceneShell kinds 注册表，防止静态纪要场景卡与宿主卡片双渲染。
 */
const { broadcastEvent } = require('./sse-broadcast');

const MEETING_PANEL_SURFACE = 'meeting-panel';
const MEETING_PANEL_KIND = 'meeting-panel';

// 进程内当前会议态（面板重开时经 surface 快照恢复；磁盘真相在 meeting-store）
let currentMeeting = null; // { meetingId, title, status, summary, keyPoints, segmentCount, duration, error }

function _snapshot() {
  const store = require('./meeting-store');
  let full = null;
  if (currentMeeting) {
    try {
      full = store.getMeeting(currentMeeting.meetingId);
    } catch (e) {
      console.warn('[meeting] 快照读取会议失败(用内存态兜底):', e.message);
    }
  }
  return {
    meetingId: currentMeeting ? currentMeeting.meetingId : null,
    title: (full && full.title) || (currentMeeting && currentMeeting.title) || '',
    status: (full && full.status) || (currentMeeting && currentMeeting.status) || 'idle',
    summary: full ? full.summary : '',
    keyPoints: full ? full.keyPoints || [] : [],
    segmentCount: full ? (full.segments || []).length : 0,
    duration: full ? full.duration || 0 : 0,
    error: currentMeeting ? currentMeeting.error : null,
  };
}

function _pushSurface() {
  const { getSceneStore } = require('./scene/scene-store');
  getSceneStore().upsertSurface(MEETING_PANEL_SURFACE, {
    kind: MEETING_PANEL_KIND,
    data: _snapshot(),
    intent: 'inform',
  });
}

function _openPanelState() {
  // 打开时刻同步 panel-state open（与 filegen-events 同模式，AI 上下文"面板已打开"
  // 感知不脱节；closed 侧由前端 handleClose 经 /api/scene/panel-state 写入）
  try {
    const { setPanelState, SURFACE_PANEL_MAP } = require('./panel-state');
    setPanelState(SURFACE_PANEL_MAP[MEETING_PANEL_SURFACE] || 'meeting', 'open');
  } catch (e) {
    console.warn('[meeting] panel-state open 写入失败(不阻塞广播):', e.message);
  }
}

/**
 * 开始记录：建会议（磁盘）→ 广播 meeting:start → 面板 surface 打开。
 * 前端收到 meeting:start 后用事件里的 meetingId 直接开录（语音本地命令路径
 * 则先 POST /api/meetings 再本地开录——两条路径最终都落到同一 UI 状态机）。
 */
function startMeeting({ title } = {}) {
  const store = require('./meeting-store');
  const meeting = store.createMeeting({ title });
  currentMeeting = {
    meetingId: meeting.id,
    title: meeting.title,
    status: meeting.status,
    error: null,
  };
  broadcastEvent('meeting:start', { meetingId: meeting.id, title: meeting.title });
  _pushSurface();
  _openPanelState();
  return meeting;
}

/** 快照更新（无广播；转写/时长落盘后由 handler 调用） */
function updateMeetingSurface() {
  if (!currentMeeting) return;
  _pushSurface();
}

/**
 * 总结完成：广播 meeting:summary（前端直接展示摘要）→ surface status done。
 * meetingId 未在录制中（如重放历史总结）也允许——以磁盘为准展示。
 */
function completeMeeting(meetingId, { summary, keyPoints } = {}) {
  const store = require('./meeting-store');
  const meeting = store.updateSummary(meetingId, { summary, keyPoints });
  if (currentMeeting && currentMeeting.meetingId === meetingId) {
    currentMeeting.status = 'done';
    currentMeeting.error = null;
  }
  broadcastEvent('meeting:summary', { meetingId, summary, keyPoints });
  _pushSurface();
  _openPanelState();
  return meeting;
}

/** 总结失败：广播 meeting:error → surface status error */
function failMeeting(meetingId, message) {
  const store = require('./meeting-store');
  try {
    store.setMeetingStatus(meetingId, 'error');
  } catch (e) {
    console.warn('[meeting] 状态落盘 error 失败(不阻塞广播):', e.message);
  }
  if (currentMeeting && currentMeeting.meetingId === meetingId) {
    currentMeeting.status = 'error';
    currentMeeting.error = message;
  }
  broadcastEvent('meeting:error', { meetingId, message });
  _pushSurface();
}

/**
 * 停止记录信号：广播 meeting:stop（前端收到后执行 flush → POST segments →
 * POST summarize 流程）；surface 先行 summarizing 态（未播摘要前 UI 显示转写中）。
 */
function stopMeetingSignal(meetingId) {
  if (!meetingId && currentMeeting) meetingId = currentMeeting.meetingId;
  if (!meetingId) return null;
  const store = require('./meeting-store');
  // 2026-09-01(R3): done 不降级——本地停 + LLM 停双路径竞态会把已完成会议打回
  // summarizing（实锤: mtg_mt6z1du7_18uy 卡死）。已完成 → 幂等返回, 不写不广播。
  let current = null;
  try {
    current = store.getMeeting(meetingId);
  } catch (e) {
    console.warn('[meeting] 读取会议状态失败(继续停止流程):', e.message);
  }
  if (current && current.status === 'done') {
    return meetingId;
  }
  try {
    store.setMeetingStatus(meetingId, 'summarizing');
  } catch (e) {
    console.warn('[meeting] 状态落盘 summarizing 失败(不阻塞广播):', e.message);
  }
  if (currentMeeting && currentMeeting.meetingId === meetingId) {
    currentMeeting.status = 'summarizing';
  }
  broadcastEvent('meeting:stop', { meetingId });
  _pushSurface();
  return meetingId;
}

/**
 * 打开历史列表信号（2026-09-01, R1）: 仅广播 meeting:history（前端 MeetingPanel
 * 收到后 openHistory()），不建会不落盘不写 panel-state——拆「查看历史被 LLM
 * 用 show 回应 → 新建空会议」的空壳制造机。
 */
function historyMeetingSignal() {
  broadcastEvent('meeting:history', {});
  return true;
}

function getMeetingStatus() {
  return _snapshot();
}

/** 仅测试用：清空当前会议内存态（真实运行中由新 start 覆盖式顶掉） */
function _resetForTest() {
  currentMeeting = null;
}

module.exports = {
  MEETING_PANEL_SURFACE,
  MEETING_PANEL_KIND,
  startMeeting,
  updateMeetingSurface,
  completeMeeting,
  failMeeting,
  stopMeetingSignal,
  historyMeetingSignal,
  getMeetingStatus,
  _resetForTest,
};
