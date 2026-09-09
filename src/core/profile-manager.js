/**
 * Profile Manager — 目录级多配置文件管理
 *
 * Storage: Each profile is a directory <id>/ containing:
 *   - profile.json  (metadata)
 *   - config.json   (config snapshot)
 *   - workspace/IDENTITY.md
 *
 * Location:  ~/.crabpaw/profiles/  (default, overridable via init(dataDir))
 * ID format: slugify(name) + '_' + shortId(6)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CRABPAW_HOME } = require('./path-utils');

// 2026-09-08 便携化: 默认随 CRABPAW_HOME 走(桌面端=数据目录, 随盘); init(dataDir) 仍可覆盖
const DEFAULT_PROFILES_DIR = path.join(CRABPAW_HOME, 'profiles');
const ACTIVE_MARKER = '.active_profile';

let PROFILES_DIR = DEFAULT_PROFILES_DIR;

// ──────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Convert a name to a filesystem-safe slug (lowercase alphanumeric + underscores).
 * Falls back to 'profile' if the result is empty (e.g. non-ASCII input).
 */
function slugify(name) {
  let slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (!slug) slug = 'profile';
  return slug;
}

/**
 * Generate a random base36 string of the given length.
 */
function shortId(len) {
  len = len || 6;
  return crypto.randomBytes(4).readUInt32BE(0).toString(36).slice(0, len).padStart(len, '0');
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function setActiveProfileMarker(id) {
  writeJson(path.join(PROFILES_DIR, ACTIVE_MARKER), { id });
}

function readActiveProfileMarker() {
  const data = readJson(path.join(PROFILES_DIR, ACTIVE_MARKER));
  return data ? data.id : null;
}

// ──────────────────────────────────────────────
//  Old-format migration
// ──────────────────────────────────────────────

/**
 * Detect single-file *.json profiles in PROFILES_DIR and migrate them to
 * directory format. Old files are renamed with a .migrated suffix.
 */
function migrateOldFormat() {
  const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    if (entry.name === ACTIVE_MARKER) continue;
    if (entry.name.endsWith('.migrated')) continue;

    // Ignore dotfiles (e.g. .active_profile in old text format)
    if (entry.name.startsWith('.')) continue;

    const filePath = path.join(PROFILES_DIR, entry.name);
    const profileName = entry.name.replace(/\.json$/i, '');

    try {
      const raw = readJson(filePath);
      if (!raw) continue;

      const { _meta, ...config } = raw;
      const id = slugify(profileName) + '_' + shortId(6);
      const dirPath = path.join(PROFILES_DIR, id);

      // Skip if a directory with this id already exists
      if (fs.existsSync(dirPath)) continue;

      fs.mkdirSync(dirPath, { recursive: true });

      const meta = Object.assign({}, _meta || {}, {
        id,
        name: profileName,
        migratedFrom: entry.name,
        migratedAt: new Date().toISOString(),
      });
      if (!meta.label) meta.label = profileName;
      if (meta.isDefault === undefined) meta.isDefault = false;

      writeJson(path.join(dirPath, 'profile.json'), meta);
      writeJson(path.join(dirPath, 'config.json'), config);

      const workspaceDir = path.join(dirPath, 'workspace');
      fs.mkdirSync(workspaceDir, { recursive: true });
      const identityPath = path.join(workspaceDir, 'IDENTITY.md');
      if (!fs.existsSync(identityPath)) {
        fs.writeFileSync(identityPath, `# ${meta.label}\n\n${meta.description || ''}\n`, 'utf-8');
      }

      // Mark old file as migrated
      fs.renameSync(filePath, filePath + '.migrated');
    } catch (e) {
      console.error(`[profile-manager] Failed to migrate ${entry.name}: ${e.message}`);
    }
  }
}

// ──────────────────────────────────────────────
//  Default profile bootstrap
// ──────────────────────────────────────────────

function ensureDefaultProfile() {
  const profiles = listProfiles();
  if (profiles.some(p => p.isDefault)) return;

  const id = 'default_' + shortId(6);
  const dirPath = path.join(PROFILES_DIR, id);
  fs.mkdirSync(dirPath, { recursive: true });

  writeJson(path.join(dirPath, 'profile.json'), {
    id,
    name: 'default',
    label: '默认',
    description: '使用主配置文件 (config.json)',
    isDefault: true,
    createdAt: new Date().toISOString(),
  });
  writeJson(path.join(dirPath, 'config.json'), {});

  const workspaceDir = path.join(dirPath, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const identityPath = path.join(workspaceDir, 'IDENTITY.md');
  if (!fs.existsSync(identityPath)) {
    fs.writeFileSync(identityPath, '# 默认\n\n使用主配置文件 (config.json)\n', 'utf-8');
  }

  setActiveProfileMarker(id);
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Initialize the profile manager.
 *
 * @param {string} [dataDir]  Custom data directory. Profiles will be stored in <dataDir>/profiles.
 *                            If omitted, defaults to ~/.crabpaw/profiles.
 */
function init(dataDir) {
  if (dataDir) {
    PROFILES_DIR = path.join(dataDir, 'profiles');
  }
  ensureDir(PROFILES_DIR);
  migrateOldFormat();
  ensureDefaultProfile();
}

/**
 * Resolve an input string (name or ID) to a profile directory ID.
 *
 * @param {string} input  Profile name or directory ID.
 * @returns {string|null}  The resolved directory ID, or null if not found.
 */
function resolveProfileId(input) {
  if (!input) return null;

  // Direct hit: input matches an existing directory name
  const direct = path.join(PROFILES_DIR, input);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    return input;
  }

  // Search by profile name in profile.json
  const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(PROFILES_DIR, entry.name, 'profile.json');
    const meta = readJson(metaPath);
    if (meta && (meta.name === input || meta.id === input)) {
      return entry.name;
    }
  }

  return null;
}

/**
 * List all profiles.
 *
 * The default profile is always first. Remaining profiles are sorted by
 * lastUsedAt descending.
 *
 * @returns {Array<Object>}
 */
function listProfiles() {
  ensureDir(PROFILES_DIR);
  const activeId = getActiveProfile();
  const profiles = [];

  const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(PROFILES_DIR, entry.name, 'profile.json');
    const meta = readJson(metaPath);
    if (!meta) continue;

    profiles.push({
      id: meta.id || entry.name,
      name: meta.name || entry.name,
      label: meta.label || meta.name || entry.name,
      description: meta.description || '',
      icon: meta.icon || null,
      isDefault: !!meta.isDefault,
      isActive: (meta.id || entry.name) === activeId,
      createdAt: meta.createdAt || null,
      lastUsedAt: meta.lastUsedAt || null,
      clonedFrom: meta.clonedFrom || null,
      path: entry.name,
    });
  }

  // Sort: default first, then by lastUsedAt desc
  profiles.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return bTime - aTime;
  });

  return profiles;
}

/**
 * Get the currently active profile ID.
 *
 * @returns {string}  Active profile ID, or the default profile ID if none is set.
 */
function getActiveProfile() {
  const marker = readActiveProfileMarker();
  if (marker) {
    // Verify it still exists as a directory
    if (fs.existsSync(path.join(PROFILES_DIR, marker))) {
      return marker;
    }
  }

  // Fall back to the default profile（2026-08-26 审计 P0 修复: 不能调 listProfiles()——
  // 它会回头调 getActiveProfile() → 互递归到栈溢出（.active_profile marker 缺失时
  // 实测 "Maximum call stack size exceeded" 500）。直接扫默认标记，不再递归。
  try {
    const entries = fs.readdirSync(PROFILES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = readJson(path.join(PROFILES_DIR, entry.name, 'profile.json'));
      if (meta && meta.isDefault) return meta.id || entry.name;
    }
  } catch (e) { console.warn('[profile-manager] 扫描默认 profile 失败:', e && e.message); }
  return 'default';
}

/**
 * Switch to a profile by name or ID.
 *
 * @param {string} input  Profile name or ID.
 * @returns {{ success: boolean, profile: string }}
 */
function useProfile(input) {
  const id = resolveProfileId(input);
  if (!id) throw new Error(`Profile "${input}" not found`);

  setActiveProfileMarker(id);

  // Stamp lastUsedAt
  const meta = getProfileMeta(id);
  if (meta) {
    updateProfileMeta(id, { lastUsedAt: new Date().toISOString() });
  }

  return { success: true, profile: id };
}

/**
 * Create a new profile.
 *
 * @param {string} name
 * @param {Object}  [options]
 * @param {string}  [options.description]
 * @param {string}  [options.icon]
 * @param {string}  [options.clone]  Source profile name or ID to clone config from.
 * @returns {{ success: boolean, profile: string, name: string, path: string }}
 */
function createProfile(name, options) {
  options = options || {};
  if (!name || typeof name !== 'string') throw new Error('Profile name is required');
  if (name === 'default') throw new Error('Cannot create a profile named "default"');

  ensureDir(PROFILES_DIR);

  const id = slugify(name) + '_' + shortId(6);
  const dirPath = path.join(PROFILES_DIR, id);
  if (fs.existsSync(dirPath)) {
    throw new Error(`Profile "${name}" already exists (id collision, try again)`);
  }

  fs.mkdirSync(dirPath, { recursive: true });

  const meta = {
    id,
    name,
    label: options.label || name,
    description: options.description || '',
    icon: options.icon || null,
    isDefault: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    clonedFrom: options.clone || null,
  };

  let config = {};
  if (options.clone) {
    const sourceId = resolveProfileId(options.clone);
    if (sourceId) {
      config = loadProfileConfig(sourceId) || {};
      meta.clonedFrom = sourceId;
    }
  } else if (options.config && typeof options.config === 'object') {
    // 2026-08-31 修复(Profile 缺陷1): 创建即携带"当前有效配置"快照(敏感键剥离),
    // 不再产出空壳——GUI/CLI 创建的自定义档立即有内容, 与宣传语"配置隔离"一致。
    config = options.config;
  }

  writeJson(path.join(dirPath, 'profile.json'), meta);
  if (Object.keys(config).length > 0) {
    writeProfileSnapshotConfig(id, config);
  } else {
    writeJson(path.join(dirPath, 'config.json'), config);
  }

  // Workspace IDENTITY.md
  const workspaceDir = path.join(dirPath, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'IDENTITY.md'),
    `# ${name}\n\n${options.description || ''}\n`,
    'utf-8'
  );

  return { success: true, profile: id, name, path: dirPath };
}

/**
 * Delete a profile by name or ID.
 *
 * Automatically switches to the default profile if the active profile is deleted.
 *
 * @param {string} input  Profile name or ID.
 * @returns {{ success: boolean, profile: string }}
 */
function deleteProfile(input) {
  const id = resolveProfileId(input);
  if (!id) throw new Error(`Profile "${input}" not found`);

  const meta = getProfileMeta(id);
  if (meta && meta.isDefault) throw new Error('Cannot delete the default profile');

  // If deleting the active profile, switch to default
  const activeId = getActiveProfile();
  if (id === activeId) {
    const profiles = listProfiles();
    const def = profiles.find(p => p.isDefault);
    if (def) setActiveProfileMarker(def.id);
  }

  const dirPath = path.join(PROFILES_DIR, id);
  fs.rmSync(dirPath, { recursive: true, force: true });

  return { success: true, profile: id };
}

/**
 * Show detailed profile information (metadata + config).
 *
 * @param {string} input  Profile name or ID.
 * @returns {Object|null}
 */
function showProfile(input) {
  if (!input) throw new Error('Profile identifier is required');
  const id = resolveProfileId(input);
  if (!id) throw new Error(`Profile "${input}" not found`);

  const meta = getProfileMeta(id);
  const config = loadProfileConfig(id);
  const activeId = getActiveProfile();

  return Object.assign({}, meta || {}, {
    config: config || {},
    isActive: id === activeId,
  });
}

/**
 * Get the active profile's config (with _meta stripped).
 *
 * Returns null for the default profile (which uses the main config file).
 *
 * @returns {Object|null}
 */
function getActiveProfileConfig() {
  const activeId = getActiveProfile();
  const meta = getProfileMeta(activeId);
  if (!meta || meta.isDefault) return null;

  return loadProfileConfig(activeId);
}

/**
 * Load a profile's config object.
 *
 * @param {string} input  Profile name or ID.
 * @returns {Object|null}
 */
function loadProfileConfig(input) {
  const id = resolveProfileId(input);
  if (!id) return null;

  const configPath = path.join(PROFILES_DIR, id, 'config.json');
  if (!fs.existsSync(configPath)) return {};

  return readJson(configPath) || {};
}

/**
 * 2026-08-31 修复(Profile 缺陷1/2): 快照写入统一走本函数——
 *    - 深合并入现有快照(不覆盖删除)
 *    - 写入前剥离敏感键(apiKey/appSecret/token 等)——快照绝不能落盘密钥明文,
 *      密钥单一事实源仍是 .api_keys.json(与 saveConfig 剥离主配置同规)
 *  缺陷2 的"旧快照遮蔽新设置"由 config.js 的保存重定向(自定义档活时写快照)解决。
 * @param {string} input    Profile name or ID.
 * @param {Object} updates  Config keys to merge.
 * @returns {{ success: boolean, profile: string }}
 */
function writeProfileSnapshotConfig(input, updates) {
  const id = resolveProfileId(input);
  if (!id) throw new Error(`Profile "${input}" not found`);

  const meta = getProfileMeta(id);
  if (meta && meta.isDefault) {
    throw new Error('The default profile uses the main config file; use config set instead');
  }

  const config = loadProfileConfig(id) || {};
  const merged = deepMerge(config, stripSensitive(updates));
  writeJson(path.join(PROFILES_DIR, id, 'config.json'), merged);

  return { success: true, profile: id };
}

/**
 * 深拷贝并剥离敏感字段(供快照落盘使用)——与 saveConfig 对主配置的
 * stripProviderKeys 同规格: apiKey/appSecret/secret/token/password 及 *Key 取值。
 */
function stripSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null) {
      const stripped = stripSensitive(value);
      // 剥空容器(如 wecom:{secret} 剥后剩 {}): 无信息量, 不落盘
      if (!Array.isArray(value) && Object.keys(stripped).length === 0) continue;
      result[key] = stripped;
    } else if (!/(key|secret|token|password)$/i.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Update a profile's config via deep-merge.
 *
 * @param {string} input    Profile name or ID.
 * @param {Object} updates  Config keys to merge.
 * @returns {{ success: boolean, profile: string }}
 */
function updateProfileConfig(input, updates) {
  return writeProfileSnapshotConfig(input, updates);
}

/**
 * Load a profile's metadata (profile.json).
 *
 * @param {string} input  Profile name or ID.
 * @returns {Object|null}
 */
function getProfileMeta(input) {
  const id = resolveProfileId(input);
  if (!id) return null;

  return readJson(path.join(PROFILES_DIR, id, 'profile.json'));
}

/**
 * Update a profile's metadata (profile.json) via shallow merge.
 *
 * @param {string} input   Profile name or ID.
 * @param {Object} updates  Metadata keys to set.
 * @returns {{ success: boolean, profile: string }}
 */
function updateProfileMeta(input, updates) {
  const id = resolveProfileId(input);
  if (!id) throw new Error(`Profile "${input}" not found`);

  const meta = getProfileMeta(id) || {};
  const merged = Object.assign({}, meta, updates);
  writeJson(path.join(PROFILES_DIR, id, 'profile.json'), merged);

  return { success: true, profile: id };
}

/**
 * Clone a profile's config into a new profile.
 *
 * @param {string} sourceInput  Source profile name or ID.
 * @param {string} newName      Name for the new profile.
 * @param {Object} [options]    Additional options passed to createProfile.
 * @returns {{ success: boolean, profile: string, name: string, path: string }}
 */
function cloneProfile(sourceInput, newName, options) {
  const sourceId = resolveProfileId(sourceInput);
  if (!sourceId) throw new Error(`Source profile "${sourceInput}" not found`);

  return createProfile(newName, Object.assign({}, options, { clone: sourceId }));
}

/**
 * Export a profile as a JSON string.
 *
 * @param {string} input  Profile name or ID.
 * @returns {string}  JSON string with { _meta, config } structure.
 */
function exportProfileAsJson(input) {
  const id = resolveProfileId(input);
  if (!id) throw new Error(`Profile "${input}" not found`);

  const meta = getProfileMeta(id) || {};
  const config = loadProfileConfig(id) || {};

  return JSON.stringify({ _meta: meta, config }, null, 2);
}

/**
 * Import a profile from a JSON string.
 *
 * Accepts both the new format ({ _meta, config }) and the old flat format
 * (data with _meta embedded in the root object).
 *
 * @param {string} name        Name for the imported profile.
 * @param {string} jsonString  JSON string.
 * @param {Object} [options]
 * @param {boolean} [options.force]  Overwrite existing profile.
 * @returns {{ success: boolean, profile: string, name: string }}
 */
function importProfileFromJson(name, jsonString, options) {
  options = options || {};

  let data;
  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid JSON format');
  }

  ensureDir(PROFILES_DIR);

  const id = slugify(name) + '_' + shortId(6);
  const dirPath = path.join(PROFILES_DIR, id);

  if (fs.existsSync(dirPath)) {
    if (!options.force) {
      throw new Error(`Profile "${name}" already exists; use --force to overwrite`);
    }
    fs.rmSync(dirPath, { recursive: true, force: true });
  }

  fs.mkdirSync(dirPath, { recursive: true });

  // Extract metadata — support both { _meta, config } and flat { _meta, ...rest }
  let meta = data._meta ? { ...data._meta } : {};
  let config = data.config ? { ...data.config } : {};

  // If the JSON is flat (old format), the remaining keys after _meta are config
  if (!data.config && data._meta) {
    const { _meta, ...rest } = data;
    config = rest;
  } else if (!data._meta && !data.config) {
    // Treat the whole object as config; create minimal meta
    config = data;
  }

  meta.id = id;
  meta.name = name;
  meta.importedAt = new Date().toISOString();
  if (!meta.createdAt) meta.createdAt = new Date().toISOString();
  if (meta.isDefault === undefined) meta.isDefault = false;

  writeJson(path.join(dirPath, 'profile.json'), meta);
  writeJson(path.join(dirPath, 'config.json'), config);

  const workspaceDir = path.join(dirPath, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const identityPath = path.join(workspaceDir, 'IDENTITY.md');
  if (!fs.existsSync(identityPath)) {
    fs.writeFileSync(
      identityPath,
      `# ${name}\n\n${meta.description || ''}\n`,
      'utf-8'
    );
  }

  return { success: true, profile: id, name };
}

/**
 * Return the API profiles directory for a given workspace root.
 * If no root is provided, uses the default PROFILES_DIR.
 * @param {string} [root]  Workspace root directory.
 * @returns {string}
 */
function getApiProfilesDir(root) {
  if (root) return path.join(root, 'profiles');
  return PROFILES_DIR;
}

/**
 * Check if two profile directories would conflict (same profile names).
 * Returns null if no conflict, or a conflict description object.
 * @param {string} otherDir  Another profiles directory to compare with.
 * @returns {Object|null}
 */
function checkProfileConflict(otherDir) {
  if (!otherDir || !fs.existsSync(otherDir)) return null;
  const localProfiles = listProfiles().map(p => p.name);
  let remoteProfiles;
  try {
    const entries = fs.readdirSync(otherDir, { withFileTypes: true });
    remoteProfiles = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const meta = readJson(path.join(otherDir, e.name, 'profile.json'));
        return meta ? meta.name : e.name;
      });
  } catch { return null; }
  const conflicting = localProfiles.filter(n => remoteProfiles.includes(n));
  if (conflicting.length === 0) return null;
  return { conflicting, profiles: localProfiles };
}

/**
 * Compare the config of two profiles and return an array of changes.
 *
 * @param {string} id1  Profile name or ID.
 * @param {string} id2  Profile name or ID.
 * @returns {Array<{ key: string, from: *, to: *, type: string }>}
 */
function getProfileDiff(id1, id2) {
  const id1r = resolveProfileId(id1);
  const id2r = resolveProfileId(id2);
  if (!id1r || !id2r) throw new Error('One or both profiles not found');

  const config1 = loadProfileConfig(id1r) || {};
  const config2 = loadProfileConfig(id2r) || {};

  const changes = [];
  const allKeys = new Set([...Object.keys(config1), ...Object.keys(config2)]);

  for (const key of allKeys) {
    const v1 = config1[key];
    const v2 = config2[key];
    if (JSON.stringify(v1) !== JSON.stringify(v2)) {
      changes.push({
        key,
        from: v1 !== undefined ? v1 : undefined,
        to: v2 !== undefined ? v2 : undefined,
        type: v1 === undefined ? 'added' : (v2 === undefined ? 'removed' : 'modified'),
      });
    }
  }

  return changes;
}

// ──────────────────────────────────────────────
//  Backward-compatibility aliases
// ──────────────────────────────────────────────

const exportProfile = exportProfileAsJson;
const importProfile = importProfileFromJson;

// ──────────────────────────────────────────────
//  Exports
// ──────────────────────────────────────────────

module.exports = {
  init,
  listProfiles,
  getActiveProfile,
  useProfile,
  createProfile,
  deleteProfile,
  showProfile,
  getActiveProfileConfig,
  loadProfileConfig,
  updateProfileConfig,
  writeProfileSnapshotConfig,
  getProfileMeta,
  updateProfileMeta,
  cloneProfile,
  exportProfileAsJson,
  importProfileFromJson,
  getProfileDiff,
  resolveProfileId,
  getApiProfilesDir,
  checkProfileConflict,
  // Backward-compatibility aliases
  exportProfile,
  importProfile,
  PROFILES_DIR,
};
