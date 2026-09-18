/**
 * ack-store.js — 主动提醒的用户确认存储（2026-09-06 风险告警轮；2026-09-18 P0 委托化）
 *
 * 治"同一告警全天每 30 分钟重复播报"：proactive 去重窗口恰好等于巡检间隔，
 * 同内容告警每轮扫描都能通过去重；卡片"知道了"只清本地显示，无持久确认态。
 *
 * v2（LoopX P0）：确认语义升级为 kernel 的 gate 原语——本文件退化为兼容壳，
 * API（isAckedToday/ack/ackKey/_reset）逐项保留，调用方（panel-handler
 * POST /api/proactive/ack、风险告警服务）零改动。gate 真值统一落盘
 * proactive-kernel.json，并一次性迁移本模块旧 proactive-ack.json 的当日确认。
 *
 * 读写失败一律降级为"未确认"（告警照常发——宁可多提醒，不可漏提醒）。
 */
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../config');
const kernel = require('./kernel');

const ACK_FILE = path.join(getDataDir(), 'proactive-ack.json'); // 旧文件（迁移源/_reset 清理对象）
let kernelWired = false;

/** kernel 状态文件与 index.init({persist:true}) 收敛同一路径；statePath 粘性，先后无关 */
function _ensureKernel() {
  if (kernelWired) return;
  kernelWired = true;
  kernel.configure({ statePath: path.join(getDataDir(), kernel.STATE_FILENAME) });
}

/** trigger+文本 → 稳定短哈希（文本含笔数/金额/客户，数据变化即换键） */
function ackKey(trigger, text) {
  _ensureKernel();
  return kernel.ackKey(trigger, text);
}

/** 该告警今天是否已被用户确认 */
function isAckedToday(trigger, text) {
  _ensureKernel();
  return kernel.isAckedToday(trigger, text);
}

/** 记录用户确认（通知卡按钮/后续语音应答回传）——kernel gate 解除，立即落盘 */
function ack(trigger, text) {
  _ensureKernel();
  return kernel.markAcked(trigger, text);
}

/** 测试钩子：清空 kernel 内存态 + 删除 kernel 状态文件 + 清旧确认文件 */
function _reset() {
  _ensureKernel();
  kernel._reset();
  const kernelFile = path.join(getDataDir(), kernel.STATE_FILENAME);
  try {
    fs.unlinkSync(kernelFile);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[proactive-ack] kernel 状态文件清理失败:', e.message);
  }
  try {
    fs.writeFileSync(ACK_FILE, '{}');
  } catch (e) {
    console.warn('[proactive-ack] 旧确认文件清理失败:', e.message);
  }
}

module.exports = { isAckedToday, ack, ackKey, _reset };
