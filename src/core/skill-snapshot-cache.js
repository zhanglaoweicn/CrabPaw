const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('./config');
const { createCacheStats } = require('./caching/cache-stats');

const SNAPSHOT_DIR = path.join(GLOBAL_SKILLS_DIR, '.crabpaw');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'skills-prompt-snapshot.json');

class SkillSnapshotCache {
  constructor(config = {}) {
    this.skillsDir = config.skillsDir || SKILLS_DIR;
    this.globalSkillsDir = config.globalSkillsDir || GLOBAL_SKILLS_DIR;
    this._cache = null;
    this._cacheValid = false;
    this._stats = createCacheStats('skillSnapshot');
  }

  _ensureDir() {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
  }

  _buildManifest() {
    const dirs = [this.skillsDir, this.globalSkillsDir];
    const manifest = {};

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        try {
          const stat = fs.statSync(skillFile);
          const content = fs.readFileSync(skillFile, 'utf-8');
          const hash = crypto.createHash('md5').update(content).digest('hex');
          manifest[path.join(entry.name, 'SKILL.md')] = {
            mtime: stat.mtimeMs,
            size: stat.size,
            hash,
          };
        } catch { console.warn('[skill-snapshot-cache] silent catch, error swallowed'); }
      }
    }

    return manifest;
  }

  _isManifestMatch(currentManifest, cachedManifest) {
    if (!cachedManifest) return false;

    const currentKeys = Object.keys(currentManifest);
    const cachedKeys = Object.keys(cachedManifest);
    if (currentKeys.length !== cachedKeys.length) return false;

    for (const key of currentKeys) {
      const cur = currentManifest[key];
      const cached = cachedManifest[key];
      if (!cached) return false;
      if (cur.mtime !== cached.mtime || cur.size !== cached.size || cur.hash !== cached.hash) {
        return false;
      }
    }

    return true;
  }

  load() {
    if (this._cacheValid && this._cache) {
      this._stats.hit();
      return this._cache;
    }

    this._ensureDir();

    const currentManifest = this._buildManifest();

    if (fs.existsSync(SNAPSHOT_FILE)) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
        if (this._isManifestMatch(currentManifest, snapshot.manifest)) {
          this._cache = snapshot.prompt;
          this._cacheValid = true;
          this._stats.hit();
          return this._cache;
        } else {
          this._stats.miss();
          this._stats.evict();
        }
      } catch {
        this._stats.miss();
      }
    } else {
      this._stats.miss();
    }

    return null;
  }

  save(prompt) {
    this._ensureDir();

    const manifest = this._buildManifest();
    const snapshot = {
      manifest,
      prompt,
      createdAt: new Date().toISOString(),
    };

    try {
      const tmp = SNAPSHOT_FILE + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
      fs.renameSync(tmp, SNAPSHOT_FILE);
      this._cache = prompt;
      this._cacheValid = true;
    } catch (e) {
      console.warn('[SkillSnapshotCache] 保存快照失败:', e.message);
    }
  }

  invalidate() {
    this._cache = null;
    this._cacheValid = false;
    try {
      if (fs.existsSync(SNAPSHOT_FILE)) {
        fs.unlinkSync(SNAPSHOT_FILE);
      }
    } catch { console.warn('[skill-snapshot-cache] silent catch, error swallowed'); }
  }

  getStats() {
    const hasSnapshot = fs.existsSync(SNAPSHOT_FILE);
    let snapshotSize = 0;
    if (hasSnapshot) {
      try {
        snapshotSize = fs.statSync(SNAPSHOT_FILE).size;
      } catch { console.warn('[skill-snapshot-cache] silent catch, error swallowed'); }
    }
    return this._stats.getStats({
      hasSnapshot,
      snapshotSize,
      cacheValid: this._cacheValid,
    });
  }

  resetStats() {
    this._stats.resetStats();
  }
}

let _instance = null;

function getSkillSnapshotCache(config) {
  if (!_instance) {
    _instance = new SkillSnapshotCache(config);
  }
  return _instance;
}

module.exports = { SkillSnapshotCache, getSkillSnapshotCache };
