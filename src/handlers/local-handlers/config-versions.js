// config-versions.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { readJsonBody, sendJson } = require('../http-utils');

// ── 配置版本管理（2026-08-01 实现——Status 页功能，此前前端调用 404）──

const { DATA_DIR } = require('../../core/config');
const CONFIG_VERSIONS_DIR = path.join(DATA_DIR, 'config-versions');
const APP_CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function _ensureConfigVersionsDir() {
  try { fs.mkdirSync(CONFIG_VERSIONS_DIR, { recursive: true }); } catch (e) { console.warn('[config-versions] mkdir failed:', e.message); }
}

function _listConfigVersions() {
  _ensureConfigVersionsDir();
  const versions = [];
  try {
    const entries = fs.readdirSync(CONFIG_VERSIONS_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.json'))
      .map(d => d.name);
    for (const name of entries) {
      try {
        const filePath = path.join(CONFIG_VERSIONS_DIR, name);
        const stat = fs.statSync(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        versions.push({
          id: name.replace(/\.json$/, ''),
          ts: stat.mtimeMs,
          size: stat.size,
          trigger: raw._meta?.trigger || 'unknown',
          label: raw._meta?.label || '',
        });
      } catch (e) { console.warn('[config-versions] skip invalid snapshot:', name, e.message); }
    }
  } catch (e) { console.warn('[config-versions] list failed:', e.message); }
  versions.sort((a, b) => b.ts - a.ts);
  return versions;
}

function _createConfigVersion(trigger, label) {
  _ensureConfigVersionsDir();
  if (!fs.existsSync(APP_CONFIG_PATH)) {
    return { success: false, error: 'config.json 不存在' };
  }
  const id = `config-${Date.now()}`;
  const filePath = path.join(CONFIG_VERSIONS_DIR, `${id}.json`);
  try {
    const current = JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf-8'));
    const snapshot = { ...current, _meta: { trigger: trigger || 'manual', label: label || '', createdAt: new Date().toISOString() } };
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    return { success: true, id };
  } catch (e) {
    console.warn('[config-versions] create failed:', e.message);
    return { success: false, error: e.message };
  }
}

function _restoreConfigVersion(id) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return { success: false, error: '缺少版本 id' };
  const filePath = path.join(CONFIG_VERSIONS_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `版本 ${safeId} 不存在` };
  }
  try {
    const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    delete snapshot._meta; // 恢复时剥离元数据
    fs.writeFileSync(APP_CONFIG_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
    // 通知配置重载（config.js 的 watcher 会自动触发）
    return { success: true, message: `已回滚到版本 ${safeId}`, backupId: safeId };
  } catch (e) {
    console.warn('[config-versions] restore failed:', e.message);
    return { success: false, error: e.message };
  }
}

async function handleConfigVersions(req, res, _ctx) {
  if (req.method === 'GET') {
    const versions = _listConfigVersions();
    return sendJson(res, 200, { success: true, versions });
  }

  if (req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      console.warn('[config-versions] body 解析失败:', e?.message || e);
      body = {};
    }
    const action = body.action || 'list';
    if (action === 'create') {
      const result = _createConfigVersion(body.trigger, body.label);
      return sendJson(res, result.success ? 200 : 400, result.success ? { success: true, id: result.id } : { success: false, error: result.error });
    }
    if (action === 'restore') {
      const result = _restoreConfigVersion(body.id);
      return sendJson(res, result.success ? 200 : 400, result);
    }
    return sendJson(res, 400, { success: false, error: `未知 action: ${action}` });
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

module.exports = {
  handleConfigVersions,
};
