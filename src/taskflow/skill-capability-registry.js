/**
 * Skill Capability Registry — indexes all skills by capabilities
 *
 * Sources:
 *   1. SKILL.md frontmatter (metadata.crabpaw.capabilities) — via initialize()
 *   2. executor.js schema exports — via _scanExecutorSchemas()
 */
const fs = require('fs');
const path = require('path');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../core/config');
const { getLogger } = require('../core/logger');
const log = getLogger('taskflow-skill-capability-registry');

class SkillCapabilityRegistry {
  constructor() {
    this._capIndex = new Map();
    this._skillInfo = new Map();
    this._schemas = new Map();
    this._initialized = false;
  }

  /**
   * Initialize from SKILL.md registry + executor.js schemas.
   */
  initialize(skillRegistry) {
    this._capIndex.clear();
    this._skillInfo.clear();
    this._schemas.clear();

    // Source 1: SKILL.md frontmatter capabilities
    if (skillRegistry && typeof skillRegistry === 'object') {
      for (const [key, skill] of Object.entries(skillRegistry)) {
        const name = skill.name || key;
        const caps = skill.metadata?.crabpaw?.capabilities || skill.metadata?.capabilities || [];
        if (Array.isArray(caps) && caps.length > 0) {
          this._skillInfo.set(name, { name, capabilities: caps, category: skill.metadata?.crabpaw?.category || 'general', description: skill.description || '' });
          for (const cap of caps) {
            if (!this._capIndex.has(cap)) this._capIndex.set(cap, []);
            if (!this._capIndex.get(cap).includes(name)) this._capIndex.get(cap).push(name);
          }
        }
      }
    }

    // Source 2: executor.js schema exports
    this._scanExecutorSchemas(SKILLS_DIR);
    this._scanExecutorSchemas(GLOBAL_SKILLS_DIR);

    this._initialized = true;
    log.info(`[CapabilityRegistry] ${this._skillInfo.size} skills indexed, ${this._capIndex.size} capabilities`);
  }

  _scanExecutorSchemas(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

    for (const entry of entries) {
      const execPath = path.join(dir, entry.name, 'executor.js');
      if (!fs.existsSync(execPath)) continue;
      try {
        const mod = require(execPath);
        if (mod.schema) {
          this.register(mod.schema);
        }
      } catch (e) { console.warn('[skill-capability-registry] failed to load executor:', e.message); }
    }
  }

  /**
   * Register a skill schema (from executor.js export).
   */
  register(schema) {
    const name = schema.name;
    if (!name) return;

    this._schemas.set(name, schema);
    this._skillInfo.set(name, {
      name,
      capabilities: schema.capabilities || [],
      category: 'executor',
      description: schema.description || ''
    });

    for (const cap of schema.capabilities || []) {
      if (!this._capIndex.has(cap)) this._capIndex.set(cap, []);
      if (!this._capIndex.get(cap).includes(name)) this._capIndex.get(cap).push(name);
    }
  }

  getSchema(skillName) {
    this._autoInit();
    return this._schemas.get(skillName) || null;
  }

  /**
   * Auto-initialize on first call if not already done.
   * Scans executor.js files and SKILL.md directories so the planner works
   * without an explicit initialize() call.
   */
  _autoInit() {
    if (this._initialized) return;

    // Try to load skill registry from the skills directory directly
    const skillRegistry = {};
    const dirs = [SKILLS_DIR, GLOBAL_SKILLS_DIR].filter(d => d && fs.existsSync(d));
    for (const dir of dirs) {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));
      for (const entry of entries) {
        const skillDir = path.join(dir, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        const metadataPath = path.join(skillDir, 'metadata.json');
        if (fs.existsSync(skillMdPath)) {
          try {
            const content = fs.readFileSync(skillMdPath, 'utf-8');
            // Parse YAML frontmatter for capabilities
            const frontMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (frontMatch) {
              const frontmatter = frontMatch[1];
              const capsMatch = frontmatter.match(/capabilities:\s*\[([^\]]*)\]/);
              if (capsMatch) {
                const caps = capsMatch[1].split(',').map(c => c.trim().replace(/['"]/g, '')).filter(Boolean);
                skillRegistry[entry.name] = {
                  name: entry.name,
                  metadata: { crabpaw: { capabilities: caps } },
                  description: ''
                };
              }
            }
          } catch (e) {
            console.warn('[skill-capability-registry] failed to parse SKILL.md:', entry.name, e.message);
          }
        }
        if (fs.existsSync(metadataPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            if (!skillRegistry[entry.name]) skillRegistry[entry.name] = { name: entry.name, metadata: {}, description: '' };
            if (meta.capabilities || meta.crabpaw?.capabilities) {
              skillRegistry[entry.name].metadata = { crabpaw: { capabilities: meta.capabilities || meta.crabpaw.capabilities } };
            }
          } catch (e) {
            console.warn('[skill-capability-registry] failed to parse metadata.json:', entry.name, e.message);
          }
        }
      }
    }

    this.initialize(Object.keys(skillRegistry).length > 0 ? skillRegistry : null);
  }

  findByCapability(capabilityId) {
    this._autoInit();
    return this._capIndex.get(capabilityId) || [];
  }

  getSkillInfo(skillName) {
    this._autoInit();
    return this._skillInfo.get(skillName) || null;
  }

  getSkillNames() {
    this._autoInit();
    return Array.from(this._skillInfo.keys());
  }

  resolveCapability(capabilityId, preferredCategory = '') {
    this._autoInit();
    const candidates = this.findByCapability(capabilityId);
    if (candidates.length === 0) return null;
    if (preferredCategory) {
      const catMatch = candidates.filter(name => {
        const info = this._skillInfo.get(name);
        return info && info.category === preferredCategory;
      });
      if (catMatch.length > 0) return catMatch[0];
    }
    return candidates[0];
  }

  getSummary() {
    this._autoInit();
    return {
      skillCount: this._skillInfo.size,
      capabilityCount: this._capIndex.size,
      capabilities: Array.from(this._capIndex.keys()),
    };
  }
}

let _instance = null;
function getCapabilityRegistry() {
  if (!_instance) _instance = new SkillCapabilityRegistry();
  return _instance;
}

module.exports = { SkillCapabilityRegistry, getCapabilityRegistry };
