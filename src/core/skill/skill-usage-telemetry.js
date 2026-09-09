/**
 * Skill Usage Telemetry - 技能使用遥测 Sidecar
 *
 * 独立于 SKILL.md 的使用统计存储，避免操作遥测污染用户内容。
 * 追踪 use/view/patch 三类事件的时间戳和计数，
 * 为 Curator 的生命周期状态转换提供数据基础。
 *
 * - Sidecar 文件 (.usage-telemetry.json) 与 SKILL.md 分离
 * - 原子写入（tmp + rename）
 * - 所有计数器操作 best-effort，失败不阻断工具调用
 */

const fs = require('fs');
const path = require('path');
const { getCrabPawSubDir } = require('../path-utils');

const TELEMETRY_FILE = '.usage-telemetry.json';

// 写入防抖：避免启动时大量 bumpView 调用导致 Windows 文件锁竞争 (EPERM)
let _pendingData = null;
let _writeTimer = null;
const WRITE_DEBOUNCE_MS = 500;

const LIFECYCLE_STATES = {
  ACTIVE: 'active',
  STALE: 'stale',
  ARCHIVED: 'archived',
};

function _telemetryPath() {
  return path.join(getCrabPawSubDir('skills'), TELEMETRY_FILE);
}

function _emptyRecord() {
  return {
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: new Date().toISOString(),
    state: LIFECYCLE_STATES.ACTIVE,
    pinned: false,
    archived_at: null,
  };
}

function loadTelemetry() {
  // 如果有 pending 数据（防抖未写入），直接返回内存中的数据
  if (_pendingData !== null) {
    return _pendingData;
  }
  const tPath = _telemetryPath();
  if (!fs.existsSync(tPath)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(tPath, 'utf-8'));
    return typeof data === 'object' && data !== null ? data : {};
  } catch {
    return {};
  }
}

function saveTelemetry(data) {
  // 防抖写入：暂存数据，延迟 500ms 后批量写入
  // 避免 Windows 上启动时大量同步写入导致 EPERM 文件锁竞争
  _pendingData = data;
  if (_writeTimer) return;
  _writeTimer = setTimeout(() => {
    _writeTimer = null;
    const dataToWrite = _pendingData;
    _pendingData = null;
    if (dataToWrite === null) return;
    _flushWrite(dataToWrite);
  }, WRITE_DEBOUNCE_MS);
}

function _flushWrite(data) {
  const tPath = _telemetryPath();
  const dir = path.dirname(tPath);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      /* noop */
      console.warn('[skill-usage-telemetry.js] 空 catch 补日志:', e && e.message);
    }

  }
  const tmpPath = tPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, tPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (e2) {
      /* 静默清理，避免日志爆炸 */
      console.warn('[skill-usage-telemetry.js] 空 catch 补日志:', e2 && e2.message);
    }

    // EPERM 时静默重试一次（Windows 文件锁释放后通常成功）
    if (e.code === 'EPERM') {
      try {
        fs.writeFileSync(tPath, JSON.stringify(data, null, 2), 'utf-8');
      } catch (e2) {
        /* 静默失败，telemetry 是 best-effort */
        console.warn('[skill-usage-telemetry.js] 空 catch 补日志:', e2 && e2.message);
      }

    }
  }
}

function getRecord(skillName) {
  const data = loadTelemetry();
  const rec = data[skillName];
  if (!rec || typeof rec !== 'object') {
    return _emptyRecord();
  }
  const base = _emptyRecord();
  for (const [k, v] of Object.entries(base)) {
    if (rec[k] === undefined) rec[k] = v;
  }
  return rec;
}

function bumpUse(skillName) {
  const data = loadTelemetry();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].use_count = (data[skillName].use_count || 0) + 1;
  data[skillName].last_used_at = new Date().toISOString();
  if (data[skillName].state === LIFECYCLE_STATES.STALE) {
    data[skillName].state = LIFECYCLE_STATES.ACTIVE;
  }
  saveTelemetry(data);
  return data[skillName];
}

function bumpView(skillName) {
  const data = loadTelemetry();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].view_count = (data[skillName].view_count || 0) + 1;
  data[skillName].last_viewed_at = new Date().toISOString();
  saveTelemetry(data);
  return data[skillName];
}

function bumpPatch(skillName) {
  const data = loadTelemetry();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].patch_count = (data[skillName].patch_count || 0) + 1;
  data[skillName].last_patched_at = new Date().toISOString();
  saveTelemetry(data);
  return data[skillName];
}

function latestActivityAt(record) {
  const timestamps = [record.last_used_at, record.last_viewed_at, record.last_patched_at]
    .filter(Boolean)
    .map(ts => new Date(ts).getTime())
    .filter(t => !isNaN(t));
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function activityCount(record) {
  return (record.use_count || 0) + (record.view_count || 0) + (record.patch_count || 0);
}

function setState(skillName, state) {
  const data = loadTelemetry();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].state = state;
  if (state === LIFECYCLE_STATES.ARCHIVED) {
    data[skillName].archived_at = new Date().toISOString();
  }
  saveTelemetry(data);
  return true;
}

function setPinned(skillName, pinned) {
  const data = loadTelemetry();
  if (!data[skillName]) data[skillName] = _emptyRecord();
  data[skillName].pinned = !!pinned;
  saveTelemetry(data);
  return true;
}

function archiveSkill(skillName) {
  return setState(skillName, LIFECYCLE_STATES.ARCHIVED);
}

function agentCreatedReport() {
  const { listAgentCreatedNames } = require('./skill-provenance');
  const data = loadTelemetry();
  const agentNames = listAgentCreatedNames();

  return agentNames.map(name => {
    const rec = data[name] || _emptyRecord();
    return {
      name,
      use_count: rec.use_count || 0,
      view_count: rec.view_count || 0,
      patch_count: rec.patch_count || 0,
      last_activity_at: latestActivityAt(rec),
      created_at: rec.created_at,
      state: rec.state || LIFECYCLE_STATES.ACTIVE,
      pinned: !!rec.pinned,
    };
  });
}

function getStats() {
  const data = loadTelemetry();
  const entries = Object.entries(data);
  const stats = {
    totalSkills: entries.length,
    totalUses: 0,
    totalViews: 0,
    totalPatches: 0,
    byState: {},
    topUsed: [],
  };

  // eslint-disable-next-line no-unused-vars
  for (const [name, rec] of entries) {
    stats.totalUses += rec.use_count || 0;
    stats.totalViews += rec.view_count || 0;
    stats.totalPatches += rec.patch_count || 0;
    stats.byState[rec.state || LIFECYCLE_STATES.ACTIVE] =
      (stats.byState[rec.state || LIFECYCLE_STATES.ACTIVE] || 0) + 1;
  }

  stats.topUsed = entries
    .map(([name, rec]) => ({ name, use_count: rec.use_count || 0 }))
    .sort((a, b) => b.use_count - a.use_count)
    .slice(0, 10);

  return stats;
}

module.exports = {
  LIFECYCLE_STATES,
  loadTelemetry,
  saveTelemetry,
  getRecord,
  bumpUse,
  bumpView,
  bumpPatch,
  latestActivityAt,
  activityCount,
  setState,
  setPinned,
  archiveSkill,
  agentCreatedReport,
  getStats,
};
