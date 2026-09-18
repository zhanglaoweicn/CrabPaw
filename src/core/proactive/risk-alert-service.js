/**
 * RiskAlertService — 经营风险主动告警
 *
 * 工作时段（9:00-20:00）每 30 分钟巡检业务库：
 *   - 应收逾期（>30 天）→ confront 级播报（去重由 proactive.notify 保证）
 *   - 合同临期（7 天内）→ inform 级播报
 */

const { scanBusinessRisks } = require('./morning-briefing-service');
const { notify } = require('./index');

const WORK_START = 9;
const WORK_END = 20;
const OVERDUE_DAYS = 30;

function formatRiskAlert({ receivableOverdue, totalReceivable, topOverdueCustomers, contractsExpiring }) {
  const parts = [];
  if (receivableOverdue > 0) {
    parts.push(`注意：有 ${receivableOverdue} 笔应收款已逾期${totalReceivable != null ? `，合计约 ${totalReceivable.toLocaleString('zh-CN')} 元` : ''}`);
    if (topOverdueCustomers && topOverdueCustomers.length) {
      parts.push(`欠款最多的是 ${topOverdueCustomers.map((c) => `${c.customer}（${Number(c.amount).toLocaleString('zh-CN')}元）`).join('、')}`);
    }
  }
  if (contractsExpiring > 0) parts.push(`另有 ${contractsExpiring} 份合同 7 天内到期，请留意续约`);
  return parts.length ? parts.join('，') + '。' : '';
}

class RiskAlertService {
  constructor() {
    this._timer = null;
  }

  _inWorkHours() {
    const h = new Date().getHours();
    return h >= WORK_START && h < WORK_END;
  }

  /** 巡检一次；返回实际播出条数 */
  async checkAndAlert({ businessDbPath, today, overdueDays } = {}) {
    try {
      // 2026-09-18 LoopX P0 收编：判定（gate 当日确认/配额/去重）全部下沉 kernel，
      // 本服务只保留巡检调度（timer + 工作时段）。旧 _lastScan 去重与 ackStore
      // 前置检查删除——同文本去重、当日确认、confront 配额(cap 8)由 kernel 原语承担；
      // 数据变化 → 文本哈希变 → 去重/确认自然过期 → 自动恢复提醒（2026-09-06 语义保持）。
      if (!this._inWorkHours()) return 0;

      const dbPath = businessDbPath || (() => {
        try { return require('path').join(require('../business-data-registry').BUSINESS_DIR, 'business.db'); } catch { return null; }
      })();
      const todayStr = today || new Date().toISOString().slice(0, 10);
      const risks = scanBusinessRisks(dbPath, { today: todayStr, overdueDays: overdueDays || OVERDUE_DAYS });
      if (risks.receivableOverdue === 0 && risks.contractsExpiring === 0) return 0;

      const text = formatRiskAlert(risks);
      if (!text) return 0;
      const r = notify({
        trigger: 'risk_alert',
        text,
        intent: risks.receivableOverdue > 0 ? 'confront' : 'inform',
        native: true, // kernel 五连判定：gate（当日确认）+ cap 8（confront）+ 持久去重
        surface: {
          kind: 'briefing',
          title: '⚠️ 经营风险提醒',
          items: [
            ...(risks.receivableOverdue > 0 ? [{ title: '应收逾期', value: `${risks.receivableOverdue} 笔`, detail: risks.topOverdueCustomers ? risks.topOverdueCustomers.map((c) => `${c.customer} ${Number(c.amount).toLocaleString('zh-CN')}元`).join(' / ') : undefined }] : []),
            ...(risks.contractsExpiring > 0 ? [{ title: '合同临期', value: `${risks.contractsExpiring} 份` }] : []),
          ],
        },
      });
      return r.ok && !r.reason ? 1 : 0; // 仅真实播出计 1（queued/dedup/gate/quota 不计）
    } catch (e) {
      console.error('[risk-alert] 巡检失败:', e.message || e);
      return 0;
    }
  }

  start({ intervalMs = 30 * 60 * 1000 } = {}) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.checkAndAlert().catch((e) => console.error('[risk-alert] 定时巡检异常:', e.message || e)); }, intervalMs);
    if (this._timer.unref) this._timer.unref(); // 2026-08-18: 定时器不阻止进程退出（退出走 runCleanup → stop()）
    // 启动后 10 秒做一次首次巡检
    setTimeout(() => { this.checkAndAlert().catch((e) => console.warn('[risk-alert] 首次巡检失败:', e.message || e)); }, 10000);
    console.log('🚨 经营风险告警服务已启动');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

const globalRiskAlertService = new RiskAlertService();

module.exports = { RiskAlertService, globalRiskAlertService, formatRiskAlert };
