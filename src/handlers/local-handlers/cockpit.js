'use strict';
// 管理舱专用聚合端点（2026-08-27 总览主屏配套）。
// 设计：单端点一次取全（避免前端 8 连击 + 各自错误态拼凑）；
// 20s 内存缓存；单源失败降级——sources.<name>={ok:false,detail} 且 data.<name>=null，
// 前端对应卡片显示降级空态（诚实，不伪装）。
const { sendJson } = require('../http-utils');

const TTL_MS = 20000;
let cacheData = null;
let cacheAt = 0;

function buildSourcesReport(sources) {
  const out = {};
  for (const [name, s] of Object.entries(sources)) out[name] = { ok: s.ok, ...(s.ok ? {} : { detail: s.detail }) };
  return out;
}

async function handleCockpitOverview(req, res, _ctx) {
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
      console.warn(`[cockpit-overview] 源 ${name} 取数失败:`, e?.message || e);
      return null;
    }
  };

  const plugins = await grab('plugins', async () => {
    const { buildAssemblyView } = require('../../core/plugin/assembly-view');
    const v = await buildAssemblyView();
    return {
      loaded: v.assembly.loaded,
      known: v.assembly.known,
      disabled: v.assembly.disabled,
      panels: v.panels.length,
      dataSources: v.sources.length,
    };
  });

  const usage = await grab('usage', async () => {
    const { getUsageStats, getTodayUsage } = require('../../core/usage-stats');
    const raw = getUsageStats();
    const today = new Date().toISOString().split('T')[0];
    const byDay = raw.byDay || {};
    const monthPrefix = today.slice(0, 7);
    const monthCostCny = Object.entries(byDay)
      .filter(([d]) => d.startsWith(monthPrefix))
      .reduce((sum, [, v]) => sum + (v.estimatedCost || 0), 0);
    const todayCostCny = byDay[today]?.estimatedCost ?? (getTodayUsage()?.estimatedCost || 0);
    return {
      todayCostCny,
      monthCostCny,
      totalRequests: raw.total?.requests || 0,
      totalCostCny: raw.total?.estimatedCost || 0,
    };
  });

  const skills = await grab('skills', async () => {
    const { getSkillsOverviewStats } = require('../../handlers/skill-handler');
    const { getSkillLifecycleManager } = require('../../core/skill-lifecycle');
    const base = await getSkillsOverviewStats();
    const lifecycleStats = getSkillLifecycleManager().getStats?.() || {};
    return { ...base, totalMerged: lifecycleStats.totalMerged || 0 };
  });

  const experts = await grab('experts', async () => {
    const experts = require('../../core/experts');
    const { getActiveExpert } = require('../../core/expert-context');
    const active = getActiveExpert('voice_shell_user');
    return { total: experts.getAllExperts().length, activeName: active?.name || null };
  });

  const mcp = await grab('mcp', async () => {
    const { getMCPManager } = require('../../core/mcp');
    const servers = getMCPManager().getServers();
    return {
      total: servers.length,
      connected: servers.filter(s => s.status === 'connected').length,
      error: servers.filter(s => s.status === 'error').length,
    };
  });

  const backend = await grab('backend', async () => ({
    pid: process.pid,
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
    memHeapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  }));

  cacheData = { plugins, usage, skills, experts, mcp, backend, sources: buildSourcesReport(sources) };
  cacheAt = now;
  return sendJson(res, 200, { success: true, data: cacheData });
}

module.exports = { handleCockpitOverview };
