/**
 * ack-store.js — 主动提醒的用户确认存储（2026-09-06 风险告警轮）
 *
 * 治"同一告警全天每 30 分钟重复播报"：proactive 去重窗口恰好等于巡检间隔，
 * 同内容告警每轮扫描都能通过去重；卡片"知道了"只清本地显示，无持久确认态。
 * 本模块按 trigger+内容哈希落盘当日确认——同内容当天不再播；次日或内容变化
 * （笔数/金额/客户名单变了 → 文本变 → 哈希变）自动恢复提醒。
 *
 * 存储文件: DATA_DIR/proactive-ack.json  { [key]: { day, ackedAt } }
 * 读写失败一律降级为"未确认"（告警照常发——宁可多提醒，不可漏提醒）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('../config');

const ACK_FILE = path.join(getDataDir(), 'proactive-ack.json');
let cache = null;

/** trigger+文本 → 稳定短哈希（文本含笔数/金额/客户，数据变化即换键） */
function ackKey(trigger, text) {
  return crypto.createHash('sha1').update(`${trigger}|${String(text)}`).digest('hex').slice(0, 16);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function _load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(ACK_FILE, 'utf-8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function _save() {
  try {
    fs.writeFileSync(ACK_FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('[proactive-ack] 确认状态写盘失败(降级为未确认):', e.message);
  }
}

/** 该告警今天是否已被用户确认 */
function isAckedToday(trigger, text) {
  const rec = _load()[ackKey(trigger, text)];
  return !!(rec && rec.day === todayStr());
}

/** 记录用户确认（通知卡按钮/后续语音应答回传） */
function ack(trigger, text) {
  const store = _load();
  // 防膨胀：超过 500 条先清掉非当天的过期项
  const keys = Object.keys(store);
  if (keys.length > 500) {
    const today = todayStr();
    for (const k of keys) {
      if (!store[k] || store[k].day !== today) delete store[k];
    }
  }
  store[ackKey(trigger, text)] = { day: todayStr(), ackedAt: Date.now() };
  _save();
  return true;
}

/** 测试钩子：清空内存缓存与文件 */
function _reset() {
  cache = {};
  try { fs.writeFileSync(ACK_FILE, '{}'); } catch { /* ignore */ }
}

module.exports = { isAckedToday, ack, ackKey, _reset };
