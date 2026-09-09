// profiles.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { readJsonBody, sendJson } = require('../http-utils');
const { getDataDir } = require('./_shared');

// ─── Profile 多配置文件管理（统一委托给 profile-manager.js） ───
const profileManager = require('../../core/profile-manager');
let _pmInitDone = false;
function ensurePM() {
  if (_pmInitDone) return;
  try { profileManager.init(getDataDir()); } catch (_) { console.warn('[request-handler] profile manager init failed:', _.message); }
  _pmInitDone = true;
}

async function handleProfiles(req, res, _ctx) {
  ensurePM();
  if (req.method === 'GET') {
    try {
      // 2026-08-26 审计 P0 修复: 响应统一走 data 包裹——此前顶层 profiles/
      // activeProfile 经 Electron api:proxy 只抽 data 字段(无 data 时整包塞入)
      // → 前端 result.data?.profiles 为 undefined, 桌面端永远读不到清单。
      return sendJson(res, 200, { success: true, data: { profiles: profileManager.listProfiles(), activeProfile: profileManager.getActiveProfile() } });
    } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
  }
  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.name) return sendJson(res, 400, { success: false, message: '缺少名称' });
      // 2026-08-31 修复(Profile 缺陷1): 创建即携带"当前有效配置"快照——空壳档无法
      // 兑现界面宣传语"多套独立配置/配置隔离"。敏感键由 profile-manager 剥离。
      let seedConfig = {};
      try {
        const cfg = require('../../core/config');
        const c = cfg.loadConfig();
        if (c) seedConfig = JSON.parse(JSON.stringify(c));
      } catch (e) { console.warn('[profiles] 创建 Profile 取当前配置失败:', e && e.message); }
      const r = profileManager.createProfile(body.name, { description: body.description || '', icon: body.icon || '🤖', config: seedConfig });
      // 2026-08-31 修复(存量 bug): createProfile 返回 r.profile 而非 r.id——原代码
      // 取 r.id 恒 undefined → 响应 JSON 无 id 字段(GUI 刷新兜底掩盖了它), 修正之。
      const m = profileManager.getProfileMeta(r.profile);
      return sendJson(res, 200, { success: true, profile: { id: r.profile, name: m?.name || body.name, description: m?.description || '', icon: m?.icon || '🤖', createdAt: m?.createdAt || Date.now(), isDefault: false } });
    } catch (e) { return sendJson(res, 400, { success: false, message: e.message }); }
  }
  sendJson(res, 405, { success: false, message: 'Method Not Allowed' });
}

async function handleProfileSwitch(req, res, ctx) {
  ensurePM();
  try {
    const body = await readJsonBody(req);
    if (!body.profileId) return sendJson(res, 400, { success: false, message: '缺少 profileId' });
    profileManager.useProfile(body.profileId);
    const meta = body.profileId === 'default' ? null : profileManager.getProfileMeta(body.profileId);
    try {
      const config = require('../../core/config');
      // 2026-08-31 修复(Profile 缺陷3): 切换后不再 saveConfig 把"主配置+快照合并态"
      // 固化写回主 config.json——改为失效 1s TTL 缓存再重载, 保持"快照=叠加层、
      // 主配置=默认档事实源"的语义; 合并态写入会让 profile 痕迹烙进主配置, 且
      // 与后续保存重定向(缺陷2 修复)互相污染。
      config.invalidateConfigCache();
      const reloadedConfig = config.loadConfig();
      if (ctx.appConfig && reloadedConfig) {
        Object.keys(ctx.appConfig).forEach(k => delete ctx.appConfig[k]);
        Object.assign(ctx.appConfig, reloadedConfig);
      }
      if (reloadedConfig?.search) {
        if (reloadedConfig.search.tavilyApiKey) process.env.TAVILY_API_KEY = reloadedConfig.search.tavilyApiKey;
        if (reloadedConfig.search.bingApiKey) process.env.BING_API_KEY = reloadedConfig.search.bingApiKey;
        if (reloadedConfig.search.baiduApiKey) process.env.BAIDU_API_KEY = reloadedConfig.search.baiduApiKey; // 2026-08-19 百度千帆 AI 搜索
      }
      if (body.profileId !== 'default') {
        const identitySrc = path.join(getDataDir(), 'profiles', body.profileId, 'workspace', 'IDENTITY.md');
        const wsDir = path.join(getDataDir(), 'workspace');
        if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });
        if (fs.existsSync(identitySrc)) fs.copyFileSync(identitySrc, path.join(wsDir, 'IDENTITY.md'));
      }
    } catch (_) { console.warn('[request-handler] failed to copy IDENTITY.md:', _.message); }
    return sendJson(res, 200, { success: true, message: `已切换到 ${meta?.name || body.profileId}`, activeProfile: body.profileId, profileName: meta?.name || body.profileId });
  } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleProfileDelete(req, res, _ctx) {
  ensurePM();
  try {
    const match = req.url.match(/^\/api\/profiles\/([^/]+)$/);
    const id = match ? match[1] : null;
    if (!id || id === 'default') return sendJson(res, 400, { success: false, message: '无效参数' });
    const meta = profileManager.getProfileMeta(id);
    const isActive = profileManager.getActiveProfile() === id;
    profileManager.deleteProfile(id);
    return sendJson(res, 200, { success: true, message: isActive ? `已删除 "${meta?.name || id}"，自动切换到默认配置` : `已删除 "${meta?.name || id}"`, switchedToDefault: isActive });
  } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleProfileUpdate(req, res, _ctx) {
  ensurePM();
  try {
    const match = req.url.match(/^\/api\/profiles\/([^/]+)$/);
    const id = match ? match[1] : null;
    if (!id) return sendJson(res, 400, { success: false, message: '缺少 profileId' });
    const body = await readJsonBody(req);
    const updates = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.icon !== undefined) updates.icon = body.icon;
    if (!Object.keys(updates).length) return sendJson(res, 400, { success: false, message: '没有需要更新的字段' });
    profileManager.updateProfileMeta(id, updates);
    return sendJson(res, 200, { success: true, profile: { id, ...profileManager.getProfileMeta(id) } });
  } catch (e) { return sendJson(res, 400, { success: false, message: e.message }); }
}

async function handleProfileClone(req, res, _ctx) {
  ensurePM();
  try {
    const match = req.url.match(/^\/api\/profiles\/([^/]+)\/clone$/);
    const id = match ? match[1] : null;
    if (!id) return sendJson(res, 400, { success: false, message: '缺少 profileId' });
    const body = await readJsonBody(req);
    const newName = body.name || (profileManager.getProfileMeta(id)?.name || id) + ' (克隆)';
    const r = profileManager.cloneProfile(id, newName, { icon: body.icon, description: body.description });
    return sendJson(res, 200, { success: true, profile: { id: r.id, ...profileManager.getProfileMeta(r.id) } });
  } catch (e) { return sendJson(res, 400, { success: false, message: e.message }); }
}

async function handleProfileExport(req, res, _ctx) {
  ensurePM();
  try {
    const match = req.url.match(/^\/api\/profiles\/([^/]+)\/export$/);
    const id = match ? match[1] : null;
    if (!id) return sendJson(res, 400, { success: false, message: '缺少 profileId' });
    const json = profileManager.exportProfileAsJson(id);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="profile-${id}.json"` });
    res.end(json);
  } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleProfileImport(req, res, _ctx) {
  ensurePM();
  try {
    const body = await readJsonBody(req);
    if (!body.name) return sendJson(res, 400, { success: false, message: '缺少名称' });
    if (!body.json) return sendJson(res, 400, { success: false, message: '缺少 JSON 数据' });
    const r = profileManager.importProfileFromJson(body.name, body.json, { force: body.force, description: body.description, icon: body.icon });
    return sendJson(res, 200, { success: true, profile: { id: r.profile, ...profileManager.getProfileMeta(r.profile) } });
  } catch (e) { return sendJson(res, 400, { success: false, message: e.message }); }
}

async function handleProfileDiff(req, res, _ctx) {
  ensurePM();
  try {
    const match = req.url.match(/^\/api\/profiles\/([^/]+)\/diff$/);
    const id = match ? match[1] : null;
    if (!id) return sendJson(res, 400, { success: false, message: '缺少 profileId' });
    const current = profileManager.getActiveProfile();
    const diff = profileManager.getProfileDiff(id, current);
    return sendJson(res, 200, { success: true, diff: diff.filter(d => d.type !== 'removed'), sourceProfile: id, targetProfile: current });
  } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
}

module.exports = {
  handleProfiles,
  handleProfileSwitch,
  handleProfileDelete,
  handleProfileUpdate,
  handleProfileClone,
  handleProfileExport,
  handleProfileImport,
  handleProfileDiff,
};
