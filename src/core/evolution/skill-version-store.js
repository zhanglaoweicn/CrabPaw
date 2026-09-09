const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
/**
 * SkillVersionStore — 技能版本快照存储（P0-5 补全）
 *
 * 回滚闭环此前恒失败的原因之一：rollback-manager 的三策略依赖
 * `_versionStore`/`_skillEvolver`，但 SkillVersionStore 类全仓不存在，
 * setVersionStore/setSkillEvolver 零调用。本文件提供最小实现：
 *
 *   - saveVersion(skillName, content, reason, meta)  → 保存版本快照
 *   - getVersions(skillName)                         → 版本列表（新→旧）
 *   - getCurrentVersion(skillName)                   → 当前版本
 *   - getLineage(skillName)                          → 血缘（新→旧，lineage[1] 为父版本）
 *   - rollback(skillName, versionId)                 → 恢复快照到 SKILL.md
 *   - getSnapshot(versionId)                         → 按版本 id 取快照内容
 *
 * 存储：JSON 快照文件（<dataDir>/.crabpaw/evolution/versions/<skillName>.json），
 * 每技能保留最近 20 个版本。hash 与 skill-evolver 的 _getContentHash 一致
 * （sha256 前 16 位十六进制），保证 _rollbackEvolution 按 parentVersion 查得到。
 */

const { DATA_DIR, SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../config');

const DEFAULT_VERSIONS_DIR = path.join(DATA_DIR, 'evolution', 'versions');
const MAX_VERSIONS_PER_SKILL = 20;

class SkillVersionStore {
  constructor(config = {}) {
    this.versionsDir = config.versionsDir || DEFAULT_VERSIONS_DIR;
    // 可注入技能目录（测试隔离）；默认用全局约定
    this.skillsDirs = config.skillsDirs || [SKILLS_DIR, GLOBAL_SKILLS_DIR];
  }

  _file(skillName) {
    return path.join(this.versionsDir, `${skillName}.json`);
  }

  _load(skillName) {
    try {
      if (fs.existsSync(this._file(skillName))) {
        const raw = fs.readFileSync(this._file(skillName), 'utf-8');
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
      }
    } catch (e) {
      console.warn('[SkillVersionStore] 版本快照加载失败:', e.message);
    }
    return [];
  }

  _save(skillName, versions) {
    try {
      if (!fs.existsSync(this.versionsDir)) {
        fs.mkdirSync(this.versionsDir, { recursive: true });
      }
      const tmp = this._file(skillName) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(versions, null, 2), 'utf-8');
      fs.renameSync(tmp, this._file(skillName));
    } catch (e) {
      console.error('[SkillVersionStore] 版本快照保存失败:', e.message);
    }
  }

  _hash(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  _findSkillDir(skillName) {
    for (const base of this.skillsDirs) {
      const dir = path.join(base, skillName);
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
    }
    return null;
  }

  /**
   * 保存一个版本快照（进化前调用）
   * @param {string} skillName
   * @param {string} content - SKILL.md 原文
   * @param {string} reason - 保存原因（如 pre-fix-backup）
   * @param {object} [meta]
   * @returns {Promise<object>} 版本记录
   */
  async saveVersion(skillName, content, reason, meta = {}) {
    const versions = this._load(skillName);
    const hash = this._hash(String(content || ''));
    const version = {
      skill_id: `ver_${Date.now()}_${hash.slice(0, 8)}`,
      skillName,
      hash,
      reason: reason || '',
      content: String(content || ''),
      createdAt: Date.now(),
      meta: meta || {},
    };
    versions.unshift(version);
    this._save(skillName, versions.slice(0, MAX_VERSIONS_PER_SKILL));
    return version;
  }

  /** @returns {Array} 版本列表（新→旧，含 content） */
  getVersions(skillName) {
    return this._load(skillName);
  }

  /** @returns {object|null} 当前版本 */
  getCurrentVersion(skillName) {
    return this._load(skillName)[0] || null;
  }

  /** @returns {Array} 血缘（新→旧）：lineage[0] 当前，lineage[1] 父版本 */
  getLineage(skillName) {
    return this._load(skillName);
  }

  /**
   * 按版本 id 取快照内容（跨技能文件扫描）
   * @param {string} versionId - skill_id
   * @returns {string|null}
   */
  getSnapshot(versionId) {
    try {
      if (!fs.existsSync(this.versionsDir)) return null;
      const files = fs.readdirSync(this.versionsDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const list = this._load(path.basename(f, '.json'));
        const hit = list.find(v => v.skill_id === versionId);
        if (hit) return hit.content ?? null;
      }
    } catch (e) {
      console.warn('[SkillVersionStore] 快照读取失败:', e.message);
    }
    return null;
  }

  /**
   * 回滚：把指定版本的快照内容写回 SKILL.md
   * @param {string} skillName
   * @param {string} versionId - skill_id
   * @returns {Promise<boolean>}
   */
  async rollback(skillName, versionId) {
    const versions = this._load(skillName);
    const target = versions.find(v => v.skill_id === versionId);
    if (!target || target.content == null) {
      console.warn(`[SkillVersionStore] 回滚失败：找不到版本 ${versionId} (${skillName})`);
      return false;
    }
    const skillDir = this._findSkillDir(skillName);
    if (!skillDir) {
      console.warn(`[SkillVersionStore] 回滚失败：找不到技能目录 ${skillName}`);
      return false;
    }
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    try {
      fs.writeFileSync(skillMdPath, target.content, 'utf-8');
      console.log(`[SkillVersionStore] ${skillName} 已回滚到版本 ${versionId}（原因: ${target.reason || 'unknown'}）`);
      return true;
    } catch (e) {
      console.error('[SkillVersionStore] 回滚写入失败:', e.message);
      return false;
    }
  }
}

// 单例
let _instance = null;

function getSkillVersionStore(config = {}) {
  if (!_instance) {
    _instance = new SkillVersionStore(config);
  }
  return _instance;
}

module.exports = { SkillVersionStore, getSkillVersionStore, DEFAULT_VERSIONS_DIR };
