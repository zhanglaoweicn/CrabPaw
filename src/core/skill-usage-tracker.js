const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { globalWriteBufferManager } = require('./write-buffer');

const USAGE_FILE = path.join(DATA_DIR, 'skill-usage.json');
const PROVENANCE_FILE = path.join(DATA_DIR, 'skill-provenance.json');

const STATE_ACTIVE = 'active';
const STATE_STALE = 'stale';
const STATE_ARCHIVED = 'archived';

const STALE_AFTER_DAYS = 30;
const ARCHIVE_AFTER_DAYS = 60;

let _writeOrigin = 'foreground';

function setWriteOrigin(origin) {
  _writeOrigin = origin;
}

function getWriteOrigin() {
  return _writeOrigin;
}

function withWriteOrigin(origin, fn) {
  const prev = _writeOrigin;
  _writeOrigin = origin;
  try {
    return fn();
  } finally {
    _writeOrigin = prev;
  }
}

async function withWriteOriginAsync(origin, fn) {
  const prev = _writeOrigin;
  _writeOrigin = origin;
  try {
    return await fn();
  } finally {
    _writeOrigin = prev;
  }
}

class SkillUsageTracker {
  constructor() {
    this._usage = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(USAGE_FILE)) {
        return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('加载技能使用数据失败:', e.message);
    }
    return { skills: {} };
  }

  _save() {
    globalWriteBufferManager.getBuffer(USAGE_FILE).write(this._usage);
  }

  recordCall(skillName, success = true) {
    if (!this._usage.skills[skillName]) {
      this._usage.skills[skillName] = {
        callCount: 0,
        successCount: 0,
        failureCount: 0,
        lastUsedAt: null,
        lastSuccessAt: null,
        createdAt: new Date().toISOString(),
        state: STATE_ACTIVE,
        pinned: false,
        provenance: _writeOrigin,
      };
    }

    const skill = this._usage.skills[skillName];
    skill.callCount++;
    skill.lastUsedAt = new Date().toISOString();

    if (success) {
      skill.successCount++;
      skill.lastSuccessAt = new Date().toISOString();
    } else {
      skill.failureCount++;
    }

    this._save();
    return skill;
  }

  getSkillUsage(skillName) {
    return this._usage.skills[skillName] || null;
  }

  getAllUsage() {
    return { ...this._usage.skills };
  }

  getStaleSkills() {
    const now = Date.now();
    return Object.entries(this._usage.skills)
      .filter(([_, s]) => {
        if (s.pinned) return false;
        if (s.state === STATE_ARCHIVED) return false;
        const lastUsed = s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : 0;
        const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24);
        return daysSinceUse > STALE_AFTER_DAYS;
      })
      .map(([name, s]) => ({ name, ...s }));
  }

  getArchivableSkills() {
    const now = Date.now();
    return Object.entries(this._usage.skills)
      .filter(([_, s]) => {
        if (s.pinned) return false;
        if (s.state === STATE_ARCHIVED) return false;
        const lastUsed = s.lastUsedAt ? new Date(s.lastUsedAt).getTime() : 0;
        const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24);
        return daysSinceUse > ARCHIVE_AFTER_DAYS;
      })
      .map(([name, s]) => ({ name, ...s }));
  }

  markStale(skillName) {
    if (this._usage.skills[skillName]) {
      this._usage.skills[skillName].state = STATE_STALE;
      this._save();
    }
  }

  markArchived(skillName) {
    if (this._usage.skills[skillName]) {
      this._usage.skills[skillName].state = STATE_ARCHIVED;
      this._save();
    }
  }

  pin(skillName) {
    if (this._usage.skills[skillName]) {
      this._usage.skills[skillName].pinned = true;
      this._save();
    }
  }

  unpin(skillName) {
    if (this._usage.skills[skillName]) {
      this._usage.skills[skillName].pinned = false;
      this._save();
    }
  }

  updateLifecycleStates() {
    const staleSkills = this.getStaleSkills();
    for (const s of staleSkills) {
      if (this._usage.skills[s.name].state === STATE_ACTIVE) {
        this._usage.skills[s.name].state = STATE_STALE;
      }
    }

    const archivable = this.getArchivableSkills();
    for (const s of archivable) {
      this._usage.skills[s.name].state = STATE_ARCHIVED;
    }

    this._save();

    return {
      markedStale: staleSkills.filter(s => s.state === STATE_ACTIVE).length,
      markedArchived: archivable.length,
    };
  }

  getStats() {
    const skills = Object.values(this._usage.skills);
    return {
      total: skills.length,
      active: skills.filter(s => s.state === STATE_ACTIVE).length,
      stale: skills.filter(s => s.state === STATE_STALE).length,
      archived: skills.filter(s => s.state === STATE_ARCHIVED).length,
      pinned: skills.filter(s => s.pinned).length,
      totalCalls: skills.reduce((sum, s) => sum + s.callCount, 0),
    };
  }
}

class SkillProvenanceTracker {
  constructor() {
    this._provenance = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(PROVENANCE_FILE)) {
        return JSON.parse(fs.readFileSync(PROVENANCE_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('加载技能来源数据失败:', e.message);
    }
    return { skills: {} };
  }

  _save() {
    globalWriteBufferManager.getBuffer(PROVENANCE_FILE).write(this._provenance);
  }

  recordCreation(skillName, origin = null) {
    const writeOrigin = origin || _writeOrigin;
    this._provenance.skills[skillName] = {
      origin: writeOrigin,
      createdAt: new Date().toISOString(),
      isAgentCreated: writeOrigin === 'background_review',
    };
    this._save();
  }

  getProvenance(skillName) {
    return this._provenance.skills[skillName] || null;
  }

  isAgentCreated(skillName) {
    const p = this._provenance.skills[skillName];
    return p ? p.isAgentCreated : false;
  }

  canAutoCurate(skillName) {
    return this.isAgentCreated(skillName);
  }

  getAll() {
    return { ...this._provenance.skills };
  }
}

const usageTracker = new SkillUsageTracker();
const provenanceTracker = new SkillProvenanceTracker();

module.exports = {
  SkillUsageTracker,
  SkillProvenanceTracker,
  usageTracker,
  provenanceTracker,
  setWriteOrigin,
  getWriteOrigin,
  withWriteOrigin,
  withWriteOriginAsync,
  STATE_ACTIVE,
  STATE_STALE,
  STATE_ARCHIVED,
};
