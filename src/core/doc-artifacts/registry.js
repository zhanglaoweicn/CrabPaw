/**
 * registry.js — 文档产物注册表（SP-4/SA-1, 2026-08-28）。
 * 统一时刻=filegen:done: registerArtifact 落盘 doc-artifacts.json。
 * 落盘统一目录 getDocumentArtifactsDir()=data/workspace/documents（主轨——工作区=用户
 * 可见文件, 白名单链零改动）。cap 500, path 去重更新（touch 升序置顶）, 原子写
 * 走仓库惯例 src/core/atomic-write.js（临时文件+rename）。
 *
 * 基准对齐（2026-08-28 现态核对）:
 * - getDocumentArtifactsDir: __dirname 相对 data/workspace/documents——与
 *   document-tools.js/file-tools.js/document-analyze-tools.js 现态拼接同基准
 *   （非 DATA_DIR; electron BACKEND_CWD 语义保持 __dirname 相对不变）。
 * - ARTIFACTS_FILE: 沿用 config.js 的 DATA_DIR（CRABPAW_DATA_DIR 注入或
 *   data/.crabpaw 默认）——与仓库其他持久化文件同目录惯例, 单测可用 env 隔离。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const { atomicWriteJSON } = require('../atomic-write');

const ARTIFACTS_FILE = path.join(DATA_DIR, 'doc-artifacts.json');
const MAX_ARTIFACTS = 500;
// Artifact 深化轮: 历史版本归档目录（同名同格式再生成且路径变化时, 旧文件搬入）
const VERSIONS_DIR = path.join(getDocumentArtifactsDir(), '.versions');

/** 旧条目归一化——补 version/status/versions 缺省（升级兼容） */
function _normalize(entry) {
  if (entry.version == null) entry.version = 1;
  if (!entry.status) entry.status = 'completed';
  if (!Array.isArray(entry.versions)) entry.versions = [];
  return entry;
}

function getDocumentArtifactsDir() {
  return path.resolve(__dirname, '..', '..', '..', 'data', 'workspace', 'documents');
}

let _cache = null;   // [{id,path,name,size,format,url,taskId,createdAt,updatedAt,_seq}]
let _seq = 0;        // 单调递增序号——updatedAt 同毫秒时保持最新在前的稳定排序

function _load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(ARTIFACTS_FILE, 'utf-8'));
    if (!Array.isArray(_cache)) _cache = [];
  } catch (e) {
    _cache = [];
    // 文件不存在(首次)/损坏——从空表启动, 注册失败不阻塞主流程
    console.warn('[doc-artifacts] 读取注册表失败(从空表启动):', e && e.message);
  }
  return _cache;
}

function _persist() {
  try {
    atomicWriteJSON(ARTIFACTS_FILE, _cache);
  } catch (e) {
    console.warn('[doc-artifacts] 持久化失败(不阻塞):', e && e.message);
  }
}

async function registerArtifact({ path: p, name, size, format, url, taskId, runId, status, title }) {
  if (!p || typeof p !== 'string') return { ok: false, error: 'path 必填' };
  const list = _load();
  const now = Date.now();
  let id;
  const displayName = title || name || path.basename(p);
  // Artifact 深化轮: 同名同格式 = 同一交付物的再生成 → 版本 +1；
  // 同路径同大小 = 重复登记 → 仅 touch（防刷新/重放导致版本虚增）
  const exist = list.find((a) => (a.name === displayName && a.format === (format || '')) || a.path === p);
  if (exist) {
    _normalize(exist);
    const contentChanged = exist.path !== p || Number(exist.size) !== Number(size);
    if (contentChanged) {
      // 旧版本入档：元数据快照 + 物理文件归档（路径变化时, 尽力而为）
      exist.versions.push({
        version: exist.version,
        path: exist.path,
        size: exist.size,
        createdAt: exist.updatedAt,
        runId: exist.runId || '',
      });
      if (exist.path !== p && fs.existsSync(exist.path)) {
        try {
          const vDir = path.join(VERSIONS_DIR, exist.id);
          fs.mkdirSync(vDir, { recursive: true });
          const archived = path.join(vDir, `v${exist.version}${path.extname(exist.path) || ''}`);
          fs.renameSync(exist.path, archived);
          exist.versions[exist.versions.length - 1].path = archived;
        } catch (e) {
          console.warn('[doc-artifacts] 旧版本归档失败(保留元数据):', e.message);
        }
      }
      exist.version = (exist.version || 1) + 1;
    }
    exist.path = p;
    exist.size = size ?? exist.size;
    exist.format = format ?? exist.format;
    exist.url = url ?? exist.url;
    if (taskId) exist.taskId = taskId;
    if (runId) exist.runId = runId;
    exist.status = status || 'completed';
    exist.updatedAt = now;
    exist._seq = ++_seq;
    id = exist.id;
  } else {
    id = `art_${now}_${Math.random().toString(36).slice(2, 8)}`;
    list.push(_normalize({
      id, path: p,
      name: displayName,
      size: size ?? 0,
      format: format || '',
      url: url || '',
      taskId: taskId || '',
      runId: runId || '',
      version: 1,
      status: status || 'completed',
      versions: [],
      createdAt: now,
      updatedAt: now,
      _seq: ++_seq,
    }));
  }
  // 最新在前: updatedAt 降序, 同毫秒用 _seq 稳定判序（501 连发 cap 用例依赖）
  const sorted = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b._seq || 0) - (a._seq || 0));
  _cache = sorted.slice(0, MAX_ARTIFACTS);
  _persist();
  // artifact:updated 广播（前端 FileGenPanel/会话卡片实时刷新）
  try {
    const { broadcastEvent } = require('../sse-broadcast');
    const entry = _cache.find((a) => a.id === id);
    if (entry) broadcastEvent('artifact:updated', { ...entry, ts: now });
  } catch (e) {
    console.warn('[doc-artifacts] artifact:updated 广播失败(不阻塞):', e.message);
  }
  return { ok: true, id, version: _cache.find((a) => a.id === id)?.version };
}

function listArtifacts(limit = 20) {
  return _load().slice(0, limit);
}

/** 测试隔离（cache 置空重读盘; 单调序号不重置不影响语义） */
function resetForTest() {
  _cache = null;
}

module.exports = {
  registerArtifact,
  listArtifacts,
  getDocumentArtifactsDir,
  resetForTest,
  MAX_ARTIFACTS,
  ARTIFACTS_FILE,
};
