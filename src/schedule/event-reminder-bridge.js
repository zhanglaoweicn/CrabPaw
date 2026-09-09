/**
 * event-reminder-bridge — 日程事件提醒触发桥（2026-09-02, R2）。
 *
 * 背景：CalendarEvent.reminders 此前纯纸面（存取/统计/同步有，触发无）。
 * 本桥每分钟扫描 schedule.json 未来 24h 事件的 reminders，把「事件开始前
 * N 分钟」翻译成一次性 cron 任务写进 schedules.json（id=evt_<eventId>_<lead>），
 * 触发复用现有 action:'reminder' 链（proactive 通知卡+TTS+企微/飞书）。
 * 本桥只排任务不触发——触发由 server cron 独占执行，避免竞写。
 */
const { LocalScheduleStorage } = require('./storage/local-storage');
const { loadSchedules, saveSchedules, loadConfig } = require('../core/config');
const { reloadGlobalScheduler } = require('../core/scheduler-bridge');

const EVT_PREFIX = 'evt_';
const SCAN_WINDOW_MS = 24 * 3600 * 1000;

/** cron 是 Asia/Shanghai 墙钟（scheduler 固定 tz）——用 +8 偏移取墙钟分量 */
function wallParts(date) {
  const wall = new Date(date.getTime() + 8 * 3600 * 1000);
  return {
    minute: wall.getUTCMinutes(),
    hour: wall.getUTCHours(),
    day: wall.getUTCDate(),
    month: wall.getUTCMonth() + 1,
  };
}

/**
 * 纯函数：事件数组 → 期望的提醒任务集。
 * 跳过：过去事件、reminders 禁用/非数值、提醒时刻已过（迟到不补响）。
 */
function computeDesiredReminders(events, now = new Date()) {
  const out = [];
  // 与 reminder-tool.js 同款归一化：chatChannel 可能是数组 ['none']
  const raw = (loadConfig().chatChannel) || 'none';
  const channel = Array.isArray(raw) ? raw[0] : raw;
  for (const ev of events || []) {
    const start = ev.startTime ? new Date(ev.startTime) : null;
    if (!start || isNaN(start.getTime())) continue;
    if (start.getTime() <= now.getTime()) continue;
    if (start.getTime() - now.getTime() > SCAN_WINDOW_MS) continue;
    const title = ev.title || '日程';
    for (const r of ev.reminders || []) {
      if (!r || r.enabled === false || typeof r.value !== 'number' || !(r.value >= 0)) continue;
      const fireAt = new Date(start.getTime() - r.value * 60000);
      if (fireAt.getTime() <= now.getTime()) continue;
      const w = wallParts(fireAt);
      out.push({
        id: `${EVT_PREFIX}${ev.id}_${r.value}`,
        type: 'temporary',
        cron: [w.minute, w.hour, w.day, w.month, '*'].join(' '),
        name: `日程提醒-${String(title).slice(0, 20)}-${r.value}min`,
        action: 'reminder',
        message: `日程提醒：${title} 将于 ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')} 开始`,
        channel,
        repeat: false,
        expireAt: fireAt.getTime() + 86400000,
      });
    }
  }
  return out;
}

/**
 * diff 同步：期望集 vs schedules.json 现存 evt_ 任务——缺的补、遗留的清。
 * 返回 {added, removed}；有变化时热重载运行实例。
 */
function syncEventReminders({ storagePath, now } = {}) {
  const storage = new LocalScheduleStorage(storagePath ? { storagePath } : {});
  let events = [];
  try { events = storage.getAll() || []; } catch (e) { console.warn('[evt-bridge] 读取日程失败(本轮跳过):', e && e.message ? e.message : e); }
  const desired = computeDesiredReminders(events, now);
  const desiredIds = new Set(desired.map(r => r.id));

  const s = loadSchedules();
  const list = s.cron || [];
  const existingEvt = list.filter(t => typeof t.id === 'string' && t.id.startsWith(EVT_PREFIX));

  let added = 0;
  let removed = 0;
  let dirty = false;
  for (const r of desired) {
    if (existingEvt.some(t => t.id === r.id && t.cron === r.cron)) continue;
    const idx = list.findIndex(t => t.id === r.id);
    if (idx !== -1) list[idx] = r; else list.push(r);
    added += 1;
    dirty = true;
  }
  for (const t of existingEvt) {
    if (desiredIds.has(t.id)) continue;
    const idx = list.findIndex(x => x.id === t.id);
    if (idx !== -1) list.splice(idx, 1);
    removed += 1;
    dirty = true;
  }
  if (dirty) {
    s.cron = list;
    saveSchedules(s);
    reloadGlobalScheduler();
  }
  return { added, removed };
}

let _timer = null;
/** 启动分钟级扫描（单例守卫）；立即先跑一轮 */
function startEventReminderBridge(intervalMs = 60000) {
  if (_timer) return false;
  try { syncEventReminders(); } catch (e) { console.warn('[evt-bridge] 首扫失败(不阻塞启动):', e && e.message ? e.message : e); }
  _timer = setInterval(() => {
    try { syncEventReminders(); } catch (e) { console.warn('[evt-bridge] 扫描失败:', e && e.message ? e.message : e); }
  }, intervalMs);
  console.log('[evt-bridge] 事件提醒桥已启动（每分钟扫描日程 reminders）');
  return true;
}

function _resetForTest() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { computeDesiredReminders, syncEventReminders, startEventReminderBridge, _resetForTest };
