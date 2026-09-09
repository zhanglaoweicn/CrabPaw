/**
 * Skill Provenance — 技能来源溯源系统
 *
 * 区分四类技能创建来源，确保进化系统不会误改用户手动创建的技能。
 *
 *   - foreground: 用户直接要求创建 → 永不自动修改
 *   - background_review: Review Fork 创建 → Curator 可管理
 *   - bundled: 内置技能 → 可更新不可删除
 *   - hub_installed: 市场安装 → 只读
 *
 * 使用 ContextVar 模式跟踪当前写操作的来源（在 tool call 执行时设置）。
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// 来源定义
// ============================================================

// Skill origin sources (used by skills.js loader)
const PROVENANCE_SOURCES = {
  BUILTIN: "builtin",
  HUB: "hub",
};

const WRITE_ORIGINS = {
  FOREGROUND: 'foreground',             // 用户直接要求 → 永不自动修改
  BACKGROUND_REVIEW: 'background_review', // Review Fork 自主创建 → Curator 可管理
  BUNDLED: 'bundled',                    // 内置技能 → 可更新不可删除
  HUB_INSTALLED: 'hub_installed',       // 市场安装 → 只读
};

/** 哪些来源的技能可以被 Curator 自动管理 */
const CURATOR_MANAGEABLE = new Set([
  WRITE_ORIGINS.BACKGROUND_REVIEW,
  WRITE_ORIGINS.BUNDLED,
]);

/** 哪些来源的技能 *不能* 被自动修改 */
const AUTO_EVOLVE_BLOCKED = new Set([
  WRITE_ORIGINS.FOREGROUND,
  WRITE_ORIGINS.HUB_INSTALLED,
]);

// ============================================================
// ContextVar 式上下文追踪
// ============================================================

/**
 * 使用 Node.js AsyncLocalStorage 实现类似 Python ContextVar 的写来源追踪
 * 这样在异步 tool call 调用链中也能正确传递 provenance。
 */
let _AsyncLocalStorage = null;
try {
  _AsyncLocalStorage = require('async_hooks').AsyncLocalStorage;
} catch (_) {

  // Node < 12 无此 API，回退到全局变量

  console.warn('[skill-provenance.js] 空 catch 补日志:', _ && _.message);
}


const _asyncStore = _AsyncLocalStorage ? new _AsyncLocalStorage() : null;

/** 全局回退变量（当 AsyncLocalStorage 不可用时） */
let _globalWriteOrigin = WRITE_ORIGINS.FOREGROUND;

/**
 * 设置当前写来源（在 tool call 执行前调用）
 * @param {string} origin - WRITE_ORIGINS 之一
 * @returns {{ restore: Function }} 用于恢复的句柄
 */
function setCurrentWriteOrigin(origin) {
  if (_asyncStore) {
    // eslint-disable-next-line no-unused-vars -- getStore() 调用结果未使用
    const store = _asyncStore.getStore() || {};
    const prev = { origin: _globalWriteOrigin };
    _globalWriteOrigin = origin || WRITE_ORIGINS.FOREGROUND;
    return { restore: () => { _globalWriteOrigin = prev.origin; } };
  }

  const prev = _globalWriteOrigin;
  _globalWriteOrigin = origin || WRITE_ORIGINS.FOREGROUND;
  return { restore: () => { _globalWriteOrigin = prev; } };
}

/**
 * 获取当前写来源
 * @returns {string}
 */
function getCurrentWriteOrigin() {
  if (_asyncStore) {
    const store = _asyncStore.getStore();
    if (store && store.writeOrigin) return store.writeOrigin;
  }
  return _globalWriteOrigin;
}

/**
 * 判断当前是否为 background review 上下文
 */
function isBackgroundReview() {
  return getCurrentWriteOrigin() === WRITE_ORIGINS.BACKGROUND_REVIEW;
}

// ============================================================
// Provenance 数据存储
// ============================================================

/** @type {Map<string, string>} skillName → origin */
let _provenanceMap = new Map();
let _dataPath = null;
let _loaded = false;

/**
 * 初始化
 * @param {string} dataPath - provenance 数据文件路径
 */
function initialize(dataPath) {
  _dataPath = dataPath;
  _load();
}

/**
 * 标记技能的来源
 * @param {string} skillName
 * @param {string} origin - WRITE_ORIGINS 之一
 */
function markProvenance(skillName, origin) {
  if (!origin || !WRITE_ORIGINS[origin.toUpperCase()]) {
    origin = getCurrentWriteOrigin(); // 回退到当前上下文
  }
  _provenanceMap.set(skillName, origin);
  _save();
}

/**
 * 获取技能的来源
 * @param {string} skillName
 * @returns {string}
 */
function getProvenance(skillName) {
  return _provenanceMap.get(skillName) || WRITE_ORIGINS.FOREGROUND;
}

/**
 * 判断技能是否为 agent 自动创建的（可被 Curator 管理）
 */
function isAgentCreated(skillName) {
  const origin = getProvenance(skillName);
  return CURATOR_MANAGEABLE.has(origin);
}

/**
 * 判断技能是否为用户拥有的（不可自动修改）
 */
function isUserOwned(skillName) {
  const origin = getProvenance(skillName);
  return origin === WRITE_ORIGINS.FOREGROUND;
}

/**
 * 判断技能是否可以被自动进化
 */
function canAutoEvolve(skillName) {
  const origin = getProvenance(skillName);
  return !AUTO_EVOLVE_BLOCKED.has(origin);
}

// ============================================================
// 批量查询
// ============================================================

/**
 * 获取所有 agent-created 技能名称
 */
function getAgentCreatedSkills() {
  const skills = [];
  for (const [name, origin] of _provenanceMap) {
    if (CURATOR_MANAGEABLE.has(origin)) {
      skills.push(name);
    }
  }
  return skills;
}

/**
 * 获取所有用户拥有的技能名称
 */
function getUserOwnedSkills() {
  const skills = [];
  for (const [name, origin] of _provenanceMap) {
    if (origin === WRITE_ORIGINS.FOREGROUND) {
      skills.push(name);
    }
  }
  return skills;
}

// ============================================================
// 持久化
// ============================================================

function _load() {
  if (!_dataPath) return;
  if (_loaded) return;
  _loaded = true;

  try {
    if (fs.existsSync(_dataPath)) {
      const data = JSON.parse(fs.readFileSync(_dataPath, 'utf-8'));
      if (data && typeof data === 'object') {
        _provenanceMap = new Map(Object.entries(data));
      }
    }
  } catch (err) {
    console.warn('[SkillProvenance] 加载失败:', err.message);
  }
}

function _save() {
  if (!_dataPath) return;
  try {
    const dir = path.dirname(_dataPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const data = Object.fromEntries(_provenanceMap);
    const tmpPath = _dataPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, _dataPath);
  } catch (err) {
    console.warn('[SkillProvenance] 保存失败:', err.message);
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  PROVENANCE_SOURCES,
  WRITE_ORIGINS,
  setCurrentWriteOrigin,
  getCurrentWriteOrigin,
  isBackgroundReview,
  initialize,
  markProvenance,
  getProvenance,
  isAgentCreated,
  isUserOwned,
  canAutoEvolve,
  getAgentCreatedSkills,
  getUserOwnedSkills,
  // Aliases for skills.js compatibility
  getSkillOrigin: getProvenance,
  markSkillOrigin: markProvenance,
};
