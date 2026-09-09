const { sendJson } = require('./http-utils');
const { getUsageStats, getTodayUsage, getRecentUsage, resetUsage } = require('../core/usage-stats');

/**
 * 将后端 usage-stats 数据格式转换为前端 CostDashboard 期望的格式
 */
function transformForFrontend(data) {
  if (!data) return data;

  // 1. byDay: 对象 → 数组
  if (data.byDay && !Array.isArray(data.byDay)) {
    data.byDay = Object.entries(data.byDay)
      .map(([date, d]) => ({
        date,
        costCny: d.estimatedCost || 0,
        costUsd: (d.estimatedCost || 0) / 7.2,
        requests: d.requests || 0,
        promptTokens: d.promptTokens || 0,
        completionTokens: d.completionTokens || 0,
        totalTokens: d.totalTokens || 0,
        cacheSavings: d.cacheSavings || 0,
        cachedTokens: d.cachedTokens || 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  if (!data.byDay) data.byDay = [];

  // 2. byModel: 保留原始 key，映射字段名
  if (data.byModel && typeof data.byModel === 'object' && !Array.isArray(data.byModel)) {
    const byModelArr = {};
    for (const [modelKey, m] of Object.entries(data.byModel)) {
      byModelArr[modelKey] = {
        costCny: m.estimatedCost || 0,
        costUsd: (m.estimatedCost || 0) / 7.2,
        calls: m.requests || 0,
        promptTokens: m.promptTokens || 0,
        completionTokens: m.completionTokens || 0,
      };
    }
    data.byModel = byModelArr;
  }
  if (!data.byModel) data.byModel = {};

  // 3. byProvider: 直接透传原始数据（前端已有 ProviderData 类型）
  // 不需要转换，保持原始格式

  // 4. 汇总字段
  if (data.total) {
    data.totalCostCny = data.total.estimatedCost || 0;
    data.totalCostUsd = (data.total.estimatedCost || 0) / 7.2;
    data.totalInputTokens = data.total.promptTokens || 0;
    data.totalOutputTokens = data.total.completionTokens || 0;
    data.totalRequests = data.total.requests || 0;
    data.totalCacheSavings = data.total.cacheSavings || 0;

    // 今日成本
    const today = new Date().toISOString().split('T')[0];
    const todayData = Array.isArray(data.byDay)
      ? data.byDay.find(d => d.date === today)
      : null;
    data.todayCostCny = todayData ? todayData.costCny : 0;
    data.todayCostUsd = todayData ? todayData.costUsd : 0;

    // 本月成本
    const monthPrefix = today.slice(0, 7);
    let monthCostCny = 0;
    if (Array.isArray(data.byDay)) {
      for (const d of data.byDay) {
        if (d.date.startsWith(monthPrefix)) {
          monthCostCny += d.costCny;
        }
      }
    }
    data.monthCostCny = monthCostCny;
    data.monthCostUsd = monthCostCny / 7.2;

    // 日均成本
    const dayCount = Array.isArray(data.byDay) ? data.byDay.length : 0;
    data.avgDailyCostCny = dayCount > 0 ? data.totalCostCny / dayCount : 0;

    // 预估月成本（按日均推算）
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    data.estimatedMonthCostCny = data.avgDailyCostCny * daysInMonth;
  }

  return data;
}

async function handleUsageStats(req, res, ctx) {
  const url = new URL(req.url, `http://localhost:${ctx.PORT}`);
  const period = url.searchParams.get('period') || 'all';

  try {
    let data;
    const raw = getUsageStats(); // Always load full stats for byType

    if (period === 'today') {
      data = {
        total: raw.total,
        byDay: { [new Date().toISOString().split('T')[0]]: getTodayUsage() },
        byModel: raw.byModel,
        byProvider: raw.byProvider,
      };
    } else if (period === 'week') {
      data = {
        total: raw.total,
        byDay: raw.byDay,
        byModel: raw.byModel,
        byProvider: raw.byProvider,
        recent: getRecentUsage(7),
      };
    } else if (period === 'month') {
      data = {
        total: raw.total,
        byDay: raw.byDay,
        byModel: raw.byModel,
        byProvider: raw.byProvider,
        recent: getRecentUsage(30),
      };
    } else {
      data = raw;
    }

    data = transformForFrontend(data);
    // byType always from the full stats snapshot
    data.byType = raw.byType || {};
    sendJson(res, 200, { success: true, data });
  } catch (error) {
    console.error('获取用量统计失败:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

async function handleUsageReset(req, res, _ctx) {
  try {
    resetUsage();
    sendJson(res, 200, { success: true, message: '用量统计已重置' });
  } catch (error) {
    console.error('重置用量统计失败:', error);
    sendJson(res, 500, { success: false, error: error.message });
  }
}

module.exports = {
  handleUsageStats,
  handleUsageReset
};
