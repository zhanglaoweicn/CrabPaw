/**
 * Skill Tier Loader - Controls which skills get loaded based on mode
 *
 * Modes:
 *   electron-packaged: electronBundle + user-enabled optional bundles
 *   electron-dev:      all bundles
 *   headless:          all bundles (CLI usage)
 *
 * User preferences stored in data/.crabpaw/skill-bundles.json
 */

const fs = require("fs");
const path = require("path");

const MANIFEST_PATH = path.join(__dirname, "../../../skills/manifest.json");
const PREFERENCES_PATH = path.join(
  __dirname,
  "../../data/.crabpaw/skill-bundles.json"
);

let _manifest = null;
let _preferences = null;

function loadManifest() {
  if (_manifest) return _manifest;
  try {
    let raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    _manifest = JSON.parse(raw);
    return _manifest;
  } catch (e) {
    console.error("[SkillTierLoader] Failed to load manifest:", e.message);
    return null;
  }
}

function loadPreferences() {
  if (_preferences) return _preferences;
  try {
    if (fs.existsSync(PREFERENCES_PATH)) {
      _preferences = JSON.parse(fs.readFileSync(PREFERENCES_PATH, "utf-8"));
    } else {
      _preferences = { enabledBundles: [] };
    }
    return _preferences;
  } catch (e) {
    console.error("[SkillTierLoader] Failed to load preferences:", e.message);
    _preferences = { enabledBundles: [] };
    return _preferences;
  }
}

function savePreferences() {
  try {
    const dir = path.dirname(PREFERENCES_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      PREFERENCES_PATH,
      JSON.stringify(_preferences, null, 2),
      "utf-8"
    );
  } catch (e) {
    console.error("[SkillTierLoader] Failed to save preferences:", e.message);
  }
}

function getMode() {
  return process.env.CRABPAW_MODE || "electron-dev";
}

/**
 * 2026-08-15 P1-8 修复: 技能清单漂移。
 * 此前 getBundledSkills 直接读 manifest.json 静态 51 名,与 SKILL.md 自动发现
 * 的 ~290 个技能严重漂移(经 tier 清单看到的技能列表大量缺漏)。
 * 现改为运行时复用 skill-system 的发现结果(getRegistry → loadSkillsFromDir 产物);
 * 发现失败时返回 null,调用方降级 manifest 静态清单并 warn。
 */
function getDiscoveredSkillNames() {
  try {
    const { getRegistry } = require("../skill-system");
    const registry = getRegistry();
    if (registry && typeof registry === "object" && Object.keys(registry).length > 0) {
      return Object.keys(registry);
    }
    console.warn("[SkillTierLoader] skill-system 发现结果为空,降级 manifest 静态清单");
  } catch (e) {
    console.warn("[SkillTierLoader] skill-system 发现不可用,降级 manifest 静态清单:", e.message);
  }
  return null;
}

/**
 * Get the list of bundle names active in the current mode
 */
function getActiveBundles() {
  const manifest = loadManifest();
  if (!manifest) return [];

  const mode = getMode();
  const prefs = loadPreferences();

  if (mode === "electron-packaged") {
    const active = [...(manifest.electronBundle || [])];
    const optional = manifest.electronOptional || [];
    for (const bundle of optional) {
      if (prefs.enabledBundles.includes(bundle)) {
        active.push(bundle);
      }
    }
    return active;
  }

  // electron-dev and headless: load all bundles
  return Object.keys(manifest.bundles || {});
}

/**
 * Get all skills from active bundles for the current mode
 */
function getBundledSkills(mode) {
  const effectiveMode = mode || getMode();

  // electron-packaged 保留 manifest 分级语义(electronBundle + 用户启用的可选包)
  if (effectiveMode !== "electron-packaged") {
    // dev/headless = 全部技能: 优先运行时发现结果(P1-8)
    const discovered = getDiscoveredSkillNames();
    if (discovered) return discovered;
  }

  // 降级路径: manifest 静态清单
  const manifest = loadManifest();
  if (!manifest) return [];

  const prefs = loadPreferences();

  let activeBundles;
  if (effectiveMode === "electron-packaged") {
    activeBundles = [...(manifest.electronBundle || [])];
    const optional = manifest.electronOptional || [];
    for (const bundle of optional) {
      if (prefs.enabledBundles.includes(bundle)) {
        activeBundles.push(bundle);
      }
    }
  } else {
    activeBundles = Object.keys(manifest.bundles || {});
  }

  const skills = new Set();
  for (const bundleName of activeBundles) {
    const bundle = manifest.bundles[bundleName];
    if (bundle && bundle.skills) {
      for (const skill of bundle.skills) {
        skills.add(skill);
      }
    }
  }

  return [...skills];
}

/**
 * Check if a specific skill is available in the current mode
 */
function isSkillAvailable(skillName) {
  // P1-8: 非打包模式用运行时发现结果优先,manifest 作兜底;
  // 打包模式保留 manifest 分级语义(electronBundle + 用户启用的可选包)
  if (getMode() !== "electron-packaged") {
    const discovered = getDiscoveredSkillNames();
    if (discovered) return discovered.includes(skillName);
  }
  const bundled = getBundledSkills();
  return bundled.includes(skillName);
}

/**
 * Get which bundles are currently enabled
 */
function getEnabledBundles() {
  return getActiveBundles();
}

/**
 * Enable a bundle (persists to preferences)
 */
function enableBundle(bundleName) {
  const manifest = loadManifest();
  if (!manifest) return false;

  const bundle = manifest.bundles[bundleName];
  if (!bundle) return false;
  if (bundle.required) return true; // Already always loaded

  const prefs = loadPreferences();
  if (!prefs.enabledBundles.includes(bundleName)) {
    prefs.enabledBundles.push(bundleName);
    savePreferences();
  }
  return true;
}

/**
 * Disable a bundle (persists to preferences)
 */
function disableBundle(bundleName) {
  const manifest = loadManifest();
  if (!manifest) return false;

  const bundle = manifest.bundles[bundleName];
  if (!bundle) return false;
  if (bundle.required) return false; // Required bundles cannot be disabled

  const prefs = loadPreferences();
  const idx = prefs.enabledBundles.indexOf(bundleName);
  if (idx >= 0) {
    prefs.enabledBundles.splice(idx, 1);
    savePreferences();
  }
  return true;
}

/**
 * Get status of all bundles
 */
function getBundleStatus() {
  const manifest = loadManifest();
  if (!manifest) return {};

  const activeBundles = getActiveBundles();

  const status = {};
  for (const [name, bundle] of Object.entries(manifest.bundles || {})) {
    status[name] = {
      enabled: activeBundles.includes(name),
      required: bundle.required || false,
      count: (bundle.skills || []).length,
      description: bundle.description || "",
    };
  }

  return status;
}

/**
 * Get bundle name for a skill
 */
function getSkillBundleInfo(skillName) {
  const manifest = loadManifest();
  if (!manifest) return { bundle: null, priority: 0 };

  for (const [bundleName, bundle] of Object.entries(manifest.bundles || {})) {
    if (bundle.skills && bundle.skills.includes(skillName)) {
      return { bundle: bundleName, priority: 0 };
    }
  }
  return { bundle: null, priority: 0 };
}

/**
 * Reset to defaults (clear user bundle preferences)
 */
function resetBundles() {
  _preferences = { enabledBundles: [] };
  savePreferences();
}

module.exports = {
  getBundledSkills,
  getDiscoveredSkillNames,
  isSkillAvailable,
  getEnabledBundles,
  enableBundle,
  disableBundle,
  getBundleStatus,
  getSkillBundleInfo,
  getMode,
  resetBundles,
};

console.log("🦀 Skill Tier Loader initialized");
