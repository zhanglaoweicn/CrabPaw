/**
 * scheduler-bridge — 注入式调度器桥（2026-09-02, 日程轮 R1）。
 *
 * 为什么存在：server.js 在 startServer 中途创建运行实例 cron，此时反向 require
 * server.js 会拿到未定型的 module.exports（循环 require 陷阱）——所以用注入：
 * server 启动时 setGlobalScheduler(cron)，任何模块经此桥安全访问运行实例。
 *
 * 双实例收敛（spec §1.1）：core/index 的 getScheduler 单例仅作兜底，
 * 桥存在时一律委托运行实例。
 */
let _cron = null;

function setGlobalScheduler(cron) {
  _cron = cron || null;
}

function getGlobalScheduler() {
  return _cron;
}

/** 重读 schedules.json 并热加载进运行实例（SetReminder/事件提醒桥写盘后调用） */
function reloadGlobalScheduler() {
  if (!_cron) return false;
  try {
    const { loadSchedules } = require('./config');
    _cron.load(loadSchedules());
    return true;
  } catch (e) {
    console.warn('[scheduler-bridge] 热重载失败:', e && e.message ? e.message : e);
    return false;
  }
}

module.exports = { setGlobalScheduler, getGlobalScheduler, reloadGlobalScheduler };
