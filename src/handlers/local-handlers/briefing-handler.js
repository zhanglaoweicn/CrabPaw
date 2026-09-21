'use strict';
// 晨报带聚合端点（2026-09-21 VoiceShell 零输入信息层配套）。
// 设计：单端点一次取全——经营快照(营收环比+风险计数) + 逾期应收/临期合同 TopN
// + 今日日程；单源失败独立降级(失败源为 null，前端对应块隐藏，不伪装)；
// 60s 内存缓存。数据源全部复用既有服务(morning-briefing-service / schedule)，
// 不新造数据语义。
const { sendJson } = require('../http-utils');

const TTL_MS = 60000;
let cacheData = null;
let cacheAt = 0;

function localDateISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildSourcesReport(sources) {
  const out = {};
  for (const [name, s] of Object.entries(sources)) out[name] = { ok: s.ok, ...(s.ok ? {} : { detail: s.detail }) };
  return out;
}

function defaultBusinessDbPath() {
  try {
    // 与 business-card-tools.js 同源：业务库真身 = data/business/business.db
    const path = require('path');
    const { DATA_DIR } = require('../../core/config');
    return path.join(DATA_DIR, 'business', 'business.db');
  } catch (e) {
    return null;
  }
}

async function handleBriefingToday(req, res, _ctx) {
  const now = Date.now();
  if (cacheData && now - cacheAt < TTL_MS) {
    return sendJson(res, 200, { success: true, data: cacheData, fromCache: true });
  }

  const sources = {};
  const grab = async (name, fn) => {
    try {
      const value = await fn();
      sources[name] = { ok: true };
      return value;
    } catch (e) {
      sources[name] = { ok: false, detail: String(e?.message || e).slice(0, 200) };
      console.warn(`[briefing-today] 源 ${name} 取数失败:`, e?.message || e);
      return null;
    }
  };

  const dbPath = defaultBusinessDbPath();

  const snapshot = await grab('snapshot', async () => {
    const { buildBriefingSnapshot } = require('../../core/proactive/morning-briefing-service');
    return buildBriefingSnapshot(dbPath);
  });

  const receivables = await grab('receivables', async () => {
    const { listOverdueReceivables } = require('../../core/proactive/morning-briefing-service');
    const items = listOverdueReceivables(dbPath, { limit: 5 }) || [];
    const total = items.reduce((s, r) => s + (r.amount || 0), 0);
    return { count: items.length, amount: total, items };
  });

  const contracts = await grab('contracts', async () => {
    const { listExpiringContracts } = require('../../core/proactive/morning-briefing-service');
    const items = listExpiringContracts(dbPath, { limit: 5 }) || [];
    return { count: items.length, items };
  });

  const schedule = await grab('schedule', async () => {
    const schedule = require('../../schedule');
    const service = schedule.createEventService();
    const today = localDateISO();
    const events = service.getByDateRange(
      schedule.toISO8601(today, '00:00'),
      schedule.toISO8601(today, '23:59'),
      { expandRecurring: true }
    ) || [];
    return {
      count: events.length,
      items: events.slice(0, 8).map((e) => {
        const json = typeof e.toJSON === 'function' ? e.toJSON() : e;
        return {
          title: json.title || '',
          startTime: json.startTime || null,
          location: json.location || null,
        };
      }),
    };
  });

  cacheData = {
    date: localDateISO(),
    snapshot,
    receivables,
    contracts,
    schedule,
    sources: buildSourcesReport(sources),
    generatedAt: now,
  };
  cacheAt = now;
  return sendJson(res, 200, { success: true, data: cacheData });
}

module.exports = { handleBriefingToday };
