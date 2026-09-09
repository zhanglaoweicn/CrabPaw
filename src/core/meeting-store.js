/**
 * meeting-store.js — 会议记录磁盘持久化（2026-08-18）
 *
 * 会议卡片的后端存储层：data/.crabpaw/meetings/index.json（列表摘要，倒序）
 * + data/.crabpaw/meetings/<id>.json（全量含转写 segments）。
 * 替代旧前端 localStorage 方案（gui/src/components/MeetingsPanel/storage.ts，
 * 已于 c668248 随控制台页面删除）——数据跨重启存活、跨入口（语音/文本/LLM）一致。
 *
 * 语义：status: 'recording' → 'summarizing' → 'done'（fail 落 'error'）；
 * segments 上限 MAX_SEGMENTS（5000，沿用旧值，超出切尾部）；列表上限 200。
 */
const path = require('path');
const { atomicWriteJSON, atomicReadJSON } = require('./atomic-write');

const MAX_SEGMENTS = 5000;
const MAX_LIST = 200;
let _idSeq = 0;

/** 数据根目录：data/.crabpaw/meetings（测试可注入 baseDir） */
function meetingsDir(baseDir) {
  const { getDataDir } = require('./config');
  return path.join(baseDir || getDataDir(), 'meetings');
}

function indexPath(baseDir) {
  return path.join(meetingsDir(baseDir), 'index.json');
}

function meetingPath(id, baseDir) {
  return path.join(meetingsDir(baseDir), `${id}.json`);
}

function newMeetingId() {
  _idSeq += 1;
  return `mtg_${Date.now().toString(36)}_${_idSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function defaultTitle() {
  const d = new Date();
  return `会议 ${d.toLocaleDateString('zh-CN')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function _readIndex(baseDir) {
  try {
    const idx = atomicReadJSON(indexPath(baseDir));
    return Array.isArray(idx) ? idx : [];
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[meeting-store] index 读取失败(按空列表降级):', e.message);
    }
    return [];
  }
}

function _writeIndex(list, baseDir) {
  atomicWriteJSON(indexPath(baseDir), list);
}

function _toStored(m) {
  return {
    id: m.id,
    title: m.title,
    date: m.date,
    duration: m.duration || 0,
    segmentCount: Array.isArray(m.segments) ? m.segments.length : 0,
    hasSummary: !!(m.summary && m.summary.trim()),
    status: m.status || 'recording',
    summary: m.summary,
    keyPoints: m.keyPoints,
    scheduleId: m.scheduleId || null,
  };
}

/**
 * 新建会议（recording 态，仅写索引，全量文件惰性在 appendSegments 时创建）
 */
function createMeeting({ title, scheduleId, baseDir } = {}) {
  const meeting = {
    id: newMeetingId(),
    title: (title && title.trim()) || defaultTitle(),
    date: new Date().toISOString(),
    duration: 0,
    segments: [],
    status: 'recording',
    scheduleId: (scheduleId && String(scheduleId).trim()) || undefined,
  };
  const list = _readIndex(baseDir);
  list.unshift(_toStored(meeting));
  _writeIndex(list.slice(0, MAX_LIST), baseDir);
  // 全量文件立即落盘（保证 GET /:id 在首个 segment 到达前也 404 不了）
  atomicWriteJSON(meetingPath(meeting.id, baseDir), meeting);
  return meeting;
}

/**
 * 追加转写 segments（批量）。录制结束 flush 一次调用；重复调用幂等追加。
 * segments 上限 MAX_SEGMENTS，超出切尾部保留最新。返回更新后的全量会议。
 */
function appendSegments(id, segments, { duration, bookmarks, baseDir } = {}) {
  const meeting = atomicReadJSON(meetingPath(id, baseDir));
  if (!meeting || !meeting.id) return null;
  const incoming = Array.isArray(segments)
    ? segments.filter(s => s && typeof s.text === 'string' && s.text.trim())
    : [];
  if (incoming.length > 0) {
    meeting.segments = [...(meeting.segments || []), ...incoming].slice(-MAX_SEGMENTS);
  }
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    meeting.duration = Math.max(meeting.duration || 0, duration);
  }
  if (Array.isArray(bookmarks)) {
    meeting.bookmarks = bookmarks.filter(b => b && typeof b.time === 'number' && typeof b.at === 'number');
  }
  atomicWriteJSON(meetingPath(id, baseDir), meeting);
  _upsertIndex(meeting, baseDir);
  return meeting;
}

/** 索引内 upsert（appendSegments/updateSummary 共用） */
function _upsertIndex(meeting, baseDir) {
  const list = _readIndex(baseDir);
  const stored = _toStored(meeting);
  const i = list.findIndex(m => m.id === meeting.id);
  if (i >= 0) list[i] = stored;
  else list.unshift(stored);
  _writeIndex(list.slice(0, MAX_LIST), baseDir);
}

/** 列表（倒序：新在前） */
function listMeetings(baseDir) {
  return _readIndex(baseDir);
}

/** 全量会议（含 segments） */
function getMeeting(id, baseDir) {
  try {
    return atomicReadJSON(meetingPath(id, baseDir));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[meeting-store] 读取会议 ${id} 失败:`, e.message);
    }
    return null;
  }
}

/** 落摘要（status → done；hasSummary 随索引刷新） */
function updateSummary(id, { summary, keyPoints, baseDir } = {}) {
  const meeting = atomicReadJSON(meetingPath(id, baseDir));
  if (!meeting || !meeting.id) return null;
  meeting.summary = summary || '';
  meeting.keyPoints = Array.isArray(keyPoints) ? keyPoints : [];
  meeting.status = 'done';
  atomicWriteJSON(meetingPath(id, baseDir), meeting);
  _upsertIndex(meeting, baseDir);
  return meeting;
}

/** 状态迁移（'summarizing' | 'error' | 'done'） */
function setMeetingStatus(id, status, baseDir) {
  const meeting = atomicReadJSON(meetingPath(id, baseDir));
  if (!meeting || !meeting.id) return null;
  meeting.status = status;
  atomicWriteJSON(meetingPath(id, baseDir), meeting);
  _upsertIndex(meeting, baseDir);
  return meeting;
}

/**
 * 启动 GC（2026-09-01, R4）: recording/summarizing 是进程内存语义——后端重启后
 * 磁盘上遗留的录制态永远是僵尸（实测 20 个「录制中」空壳横跨两周）。
 * 每次启动把遗留 recording/summarizing 标记为 interrupted（仅展示语义）。
 * @returns 清理条数
 */
function gcStaleRecordings(baseDir) {
  const list = _readIndex(baseDir);
  const stale = list.filter(m => m.status === 'recording' || m.status === 'summarizing');
  for (const m of stale) {
    try {
      setMeetingStatus(m.id, 'interrupted', baseDir);
    } catch (e) {
      console.warn(`[meeting-store] GC 标记 ${m.id} interrupted 失败:`, e.message);
    }
  }
  if (stale.length > 0) {
    console.log(`[meeting-store] 启动 GC: ${stale.length} 条遗留录制态 → interrupted`);
  }
  return stale.length;
}

/** 实时提取快照（覆盖写; 仅全量文件, 索引无此字段）。非法字段归一为空数组。 */
function setInsights(id, insights, baseDir) {
  const meeting = atomicReadJSON(meetingPath(id, baseDir));
  if (!meeting || !meeting.id) return null;
  const norm = v => (Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim()) : []);
  meeting.insights = {
    todos: norm(insights && insights.todos),
    decisions: norm(insights && insights.decisions),
    points: norm(insights && insights.points),
  };
  atomicWriteJSON(meetingPath(id, baseDir), meeting);
  return meeting;
}

/** 删除（索引 + 全量文件） */
function deleteMeeting(id, baseDir) {
  const list = _readIndex(baseDir);
  const before = list.length;
  const rest = list.filter(m => m.id !== id);
  if (rest.length !== before) _writeIndex(rest, baseDir);
  try {
    const fs = require('fs');
    fs.unlinkSync(meetingPath(id, baseDir));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[meeting-store] 删除会议 ${id} 文件失败:`, e.message);
  }
  return rest.length !== before;
}

/** 转写归一化（截断 8000 字供总结上下文用，沿用旧 MeetingsPanel 口径） */
function sanitizeTranscript(segments) {
  return (segments || [])
    .map(s => (s && s.text ? String(s.text).trim() : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, 8000);
}

/**
 * 解析 AI 摘要回复 → { summary, keyPoints }。宽松正则家族迁移自旧
 * MeetingsPanel.handleSummarize（支持 ## / ** / 纯文本标题 + emoji 变体，
 * 两段降级兜底）。纯函数，handler 与测试直接可用。
 */
function parseSummaryReply(reply) {
  const text = String(reply || '');
  if (!text.trim()) return { summary: '', keyPoints: [] };

  let summary = '';
  // 前导支持 ## / # / **（加粗）标题，分隔符允许冒号 / 双破折号 / 换行（无冒号形态）
  const HEAD = '(?:#{1,2}\\s*|\\*\\*\\s*)?';
  // 分隔符：冒号 / 双破折号 / 空白 / **（加粗标题的闭合标记，如 `**会议摘要**：`）
  const SEP = '(?:[：:：]|——|\\s|\\*\\*)?';
  // u flag 必须：字符类按 code point 匹配，否则 🔑/📝 共享高代理 \ud83d 会互相误截
  const summaryPatterns = [
    new RegExp(`${HEAD}[📋✏]?\\s*会议摘要${SEP}([\\s\\S]*?)(?=${HEAD}[🔑✏]?\\s*核心要点|${HEAD}[📝✏]?\\s*完整转写|$)`, 'u'),
    new RegExp(`${HEAD}[📋✏]?\\s*会议摘要${SEP}([\\s\\S]*?)(?=##|\\*\\*|$)`, 'u'),
  ];
  for (const pat of summaryPatterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].trim()) {
      summary = m[1].trim().replace(/^[：:：]/, '');
      break;
    }
  }
  if (!summary) {
    // fallback: 取回复前 500 字作为摘要
    summary = text.replace(/^##?\s*[📋🔑📝✏]/gmu, '').trim().slice(0, 500);
  }

  let keyPoints = [];
  const pointsPatterns = [
    new RegExp(`${HEAD}[🔑✏]?\\s*核心要点${SEP}([\\s\\S]*?)(?=${HEAD}[📝✏]?\\s*完整转写|${HEAD}[📋✏]?\\s*会议摘要|$)`, 'u'),
    new RegExp(`${HEAD}[🔑✏]?\\s*核心要点${SEP}([\\s\\S]*?)(?=##|\\*\\*|$)`, 'u'),
  ];
  for (const pat of pointsPatterns) {
    const m = text.match(pat);
    if (m && m[1]) {
      // 先 trim 行首空白再剥离符号（支持缩进列表项）
      keyPoints = m[1]
        .split('\n')
        .map(l => l.trim())
        .map(l => l.replace(/^[-•*]\s*/, '').replace(/^\d+[.、]\s*/, '').trim())
        .filter(Boolean);
      if (keyPoints.length > 0) break;
    }
  }
  if (keyPoints.length === 0) {
    // fallback: 提取所有以 - • 1. 开头的行
    keyPoints = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[-•*>]\s/.test(l) || /^\d+[.、]\s/.test(l))
      .map(l => l.replace(/^[-•*>]\s*/, '').replace(/^\d+[.、]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  return { summary, keyPoints };
}

module.exports = {
  MAX_SEGMENTS,
  MAX_LIST,
  meetingsDir,
  createMeeting,
  appendSegments,
  listMeetings,
  getMeeting,
  updateSummary,
  setMeetingStatus,
  setInsights,
  deleteMeeting,
  sanitizeTranscript,
  parseSummaryReply,
  gcStaleRecordings,
};
