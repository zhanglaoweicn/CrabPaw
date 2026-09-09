const fs = require('fs');
const path = require('path');

const { EventEmitter } = require('events');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR, DATA_DIR } = require('../config');
const { matchesPlatform } = require('../skill-loader-enhanced');
const { preprocessSkillContent } = require('../skill-preprocessing');

const PLATFORM_MAP = {
  'macos': 'darwin',
  'linux': 'linux',
  'windows': 'win32'
};

const EXCLUDED_DIRS = new Set(['.git', '.github', '.hub', '.archive', 'node_modules', '__pycache__']);

const REGISTRY_CACHE_TTL = 30000;

class SkillRegistry extends EventEmitter {
  constructor(config = {}) {
    super();
    this._skillsDir = config.skillsDir || SKILLS_DIR;
    this._globalSkillsDir = config.globalSkillsDir || GLOBAL_SKILLS_DIR;
    this._externalDirs = config.externalDirs || [];
    this._registry = new Map();
    this._categories = new Map();
    this._cache = { mtime: 0, valid: false };
    this._disabledSkills = new Set();
    this._platformDisabled = new Map();
    this._currentPlatform = config.platform || null;
    this._lastLoadTime = 0;
  }

  setExternalDirs(dirs) {
    this._externalDirs = Array.isArray(dirs) ? dirs : [];
    this.invalidate();
  }

  setDisabledSkills(names, platform = null) {
    if (platform) {
      this._platformDisabled.set(platform, new Set(names.map(n => n.toLowerCase())));
    } else {
      this._disabledSkills = new Set(names.map(n => n.toLowerCase()));
    }
    this.invalidate();
  }

  setCurrentPlatform(platform) {
    this._currentPlatform = platform;
    this.invalidate();
  }

  invalidate() {
    this._cache.valid = false;
    this._registry.clear();
    this._categories.clear();
  }

  getRegistry(forceReload = false) {
    const now = Date.now();
    if (!forceReload && this._cache.valid && (now - this._lastLoadTime) < REGISTRY_CACHE_TTL) {
      return this._registry;
    }
    this._loadAll();
    return this._registry;
  }

  getCategories() {
    if (this._categories.size === 0) {
      this.getRegistry();
    }
    return this._categories;
  }

  getSkill(name) {
    const registry = this.getRegistry();
    return registry.get(name.toLowerCase()) || registry.get(name) || null;
  }

  findSkill(query) {
    const registry = this.getRegistry();
    const lower = query.toLowerCase();

    if (registry.has(lower)) return registry.get(lower);

    // eslint-disable-next-line no-unused-vars -- 数组解构的 key 未使用（遍历仅需 skill）
    for (const [key, skill] of registry) {
      if (skill.name.toLowerCase() === lower || skill.slug === lower) {
        return skill;
      }
    }

    // eslint-disable-next-line no-unused-vars -- 数组解构的 key 未使用（遍历仅需 skill）
    for (const [key, skill] of registry) {
      if (skill.name.toLowerCase().includes(lower) || 
          (skill.description || '').toLowerCase().includes(lower)) {
        return skill;
      }
    }

    return null;
  }

  listSkills(options = {}) {
    const registry = this.getRegistry();
    let skills = [...registry.values()];

    if (options.category) {
      skills = skills.filter(s => s.category === options.category);
    }
    if (options.platform !== undefined) {
      const checkPlatform = options.platform;
      skills = skills.filter(s => {
        if (!s.frontmatter.platforms) return true;
        return this._matchesPlatformFilter(s.frontmatter, checkPlatform);
      });
    }
    if (options.source) {
      skills = skills.filter(s => s.source === options.source);
    }
    if (options.enabledOnly) {
      skills = skills.filter(s => !this._isDisabled(s.name));
    }

    if (options.sortBy) {
      const sortKey = options.sortBy;
      skills.sort((a, b) => {
        const av = a[sortKey] || 0;
        const bv = b[sortKey] || 0;
        return options.sortDesc ? bv - av : av - bv;
      });
    }

    return skills;
  }

  getSkillContent(name, options = {}) {
    const skill = this.getSkill(name);
    if (!skill) return null;

    let content = skill.rawContent || '';

    if (options.preprocess !== false) {
      content = preprocessSkillContent(content, {
        skillDir: skill.dir,
        sessionId: options.sessionId,
        dataDir: DATA_DIR,
        platform: this._currentPlatform,
        shellEnabled: options.shellEnabled,
        shellTimeout: options.shellTimeout,
      });
    }

    return {
      ...skill,
      content,
      activationNote: this._buildActivationNote(skill),
    };
  }

  buildInvocationMessage(name, options = {}) {
    const skillData = this.getSkillContent(name, options);
    if (!skillData) return null;

    const parts = [skillData.activationNote, '', skillData.content.trim()];

    if (skillData.dir) {
      parts.push('');
      parts.push(`[Skill directory: ${skillData.dir}]`);
      parts.push(
        'Resolve any relative paths in this skill (e.g. scripts/foo.js, ' +
        'templates/config.yaml) against that directory, then run them ' +
        'with the terminal tool using the absolute path.'
      );
    }

    if (options.userInstruction) {
      parts.push('');
      parts.push(`User instruction: ${options.userInstruction}`);
    }

    if (options.runtimeNote) {
      parts.push('');
      parts.push(options.runtimeNote);
    }

    return parts.join('\n');
  }

  _loadAll() {
    this._registry.clear();
    this._categories.clear();

    const loadDirs = [
      { dir: this._globalSkillsDir, source: 'global', priority: 0 },
      { dir: this._skillsDir, source: 'local', priority: 1 },
    ];

    for (const extDir of this._externalDirs) {
      const resolved = path.resolve(extDir);
      if (fs.existsSync(resolved)) {
        loadDirs.push({ dir: resolved, source: 'external', priority: 2 });
      }
    }

    for (const { dir, source, priority } of loadDirs) {
      this._loadFromDir(dir, source, priority);
    }

    this._cache.valid = true;
    this._lastLoadTime = Date.now();
    this.emit('registry_loaded', { count: this._registry.size });
  }

  _loadFromDir(dir, source, priority) {
    if (!fs.existsSync(dir)) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;

      const skillPath = path.join(dir, entry.name);
      const skillMdPath = path.join(skillPath, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) continue;

      const skill = this._parseSkill(skillPath, entry.name, source, priority);
      if (!skill) continue;

      if (!matchesPlatform(skill.frontmatter)) continue;
      if (this._isDisabled(skill.name)) continue;

      const existingKey = skill.slug.toLowerCase();
      const existing = this._registry.get(existingKey);
      if (existing && existing.priority >= priority) {
        continue;
      }

      this._registry.set(existingKey, skill);

      const category = skill.frontmatter.category || skill.frontmatter.metadata?.crabpaw?.category || 'uncategorized';
      if (!this._categories.has(category)) {
        this._categories.set(category, []);
      }
      this._categories.get(category).push(skill.slug);
    }
  }

  _parseSkill(skillPath, name, source, priority) {
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    let rawContent;
    try {
      rawContent = fs.readFileSync(skillMdPath, 'utf-8');
    } catch {
      return null;
    }

    const { frontmatter, body } = this._parseFrontmatter(rawContent);

    const slug = this._slugify(name);

    let stat;
    try {
      stat = fs.statSync(skillMdPath);
    } catch {
      stat = { mtime: new Date() };
    }

    const hasSupportFiles = this._detectSupportFiles(skillPath);

    return {
      name,
      slug,
      dir: skillPath,
      source,
      priority,
      frontmatter,
      description: frontmatter.description || this._extractDescription(body),
      body,
      rawContent,
      mtime: stat.mtime.getTime(),
      category: frontmatter.category || frontmatter.metadata?.crabpaw?.category || 'uncategorized',
      platforms: frontmatter.platforms || frontmatter.metadata?.crabpaw?.platforms || null,
      configVars: this._extractConfigVars(frontmatter),
      hasSupportFiles,
      provenance: frontmatter.provenance || source,
      state: frontmatter.state || 'active',
    };
  }

  _parseFrontmatter(content) {
    const frontmatter = {};
    let body = content;

    if (!content.startsWith('---')) {
      return { frontmatter, body };
    }

    const endMatch = content.slice(3).indexOf('\n---');
    if (endMatch === -1) {
      return { frontmatter, body };
    }

    const yamlContent = content.slice(3, endMatch + 3);
    body = content.slice(endMatch + 7);

    const lines = yamlContent.split('\n');
    let currentKey = null;
    let currentValue = [];
    let baseIndent = null;
    let inList = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) continue;

      const listMatch = trimmed.match(/^-\s+(.*)$/);
      if (inList && listMatch) {
        currentValue.push(listMatch[1].replace(/^["']|["']$/g, ''));
        continue;
      }

      const colonMatch = line.match(/^(\s*)([\w.-]+)\s*:\s*(.*)$/);
      if (colonMatch) {
        if (currentKey) {
          frontmatter[currentKey] = this._finalizeValue(currentValue, inList);
        }
        currentKey = colonMatch[2];
        const val = colonMatch[3].trim();
        inList = false;

        if (val === '' || val === '|' || val === '>') {
          currentValue = [];
          baseIndent = null;
        } else if (val.startsWith('[') && val.endsWith(']')) {
          currentValue = this._parseInlineArray(val);
          inList = false;
        } else {
          currentValue = [val.replace(/^["']|["']$/g, '')];
        }
      } else if (currentKey && (line.startsWith('  ') || line.startsWith('\t'))) {
        if (trimmed.startsWith('- ')) {
          inList = true;
          currentValue.push(trimmed.slice(2).replace(/^["']|["']$/g, ''));
        } else {
          if (baseIndent === null) {
            baseIndent = line.search(/\S/);
          }
          const indent = line.search(/\S/);
          const spaces = Math.max(0, indent - (baseIndent || 0));
          currentValue.push(' '.repeat(spaces) + trimmed);
        }
      }
    }

    if (currentKey) {
      frontmatter[currentKey] = this._finalizeValue(currentValue, inList);
    }

    if (frontmatter.metadata && typeof frontmatter.metadata === 'string') {
      frontmatter.metadata = this._parseNestedYaml(frontmatter.metadata);
    }

    return { frontmatter, body };
  }

  _finalizeValue(valueArr, wasList) {
    if (valueArr.length === 0) return '';
    if (valueArr.length === 1 && !wasList) return valueArr[0];
    return valueArr;
  }

  _parseInlineArray(str) {
    if (!str || !str.trim().startsWith('[')) return [];
    try {
      const parsed = JSON.parse(str);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return str.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }

  _parseNestedYaml(text) {
    const result = {};
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      const match = line.trim().match(/^([^:]+?):\s*(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = this._parseInlineArray(value);
        } else {
          result[key] = value.replace(/^["']|["']$/g, '');
        }
      }
    }
    return result;
  }

  _extractDescription(body) {
    if (!body) return '';
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('<!--')) {
        return trimmed.substring(0, 200);
      }
    }
    return '';
  }

  _slugify(name) {
    let slug = name.toLowerCase().replace(/[\s_]+/g, '-');
    slug = slug.replace(/[^a-z0-9-]/g, '');
    slug = slug.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
    return slug;
  }

  _isDisabled(name) {
    const lower = name.toLowerCase();
    if (this._disabledSkills.has(lower)) return true;
    if (this._currentPlatform) {
      const platformDisabled = this._platformDisabled.get(this._currentPlatform);
      if (platformDisabled && platformDisabled.has(lower)) return true;
    }
    return false;
  }

  _matchesPlatformFilter(frontmatter, platform) {
    const platforms = frontmatter.platforms || frontmatter.metadata?.crabpaw?.platforms;
    if (!platforms) return true;
    const platformList = Array.isArray(platforms) ? platforms : [platforms];
    for (const p of platformList) {
      const normalized = String(p).toLowerCase().trim();
      const mapped = PLATFORM_MAP[normalized] || normalized;
      if (platform.startsWith(mapped)) return true;
    }
    return false;
  }

  _extractConfigVars(frontmatter) {
    const config = frontmatter.metadata?.crabpaw?.config || frontmatter.config;
    if (!config) return [];
    if (Array.isArray(config)) return config;
    if (typeof config === 'object') return Object.keys(config);
    return [];
  }

  _detectSupportFiles(skillPath) {
    const supportDirs = ['references', 'templates', 'scripts'];
    const result = {};
    for (const dir of supportDirs) {
      const fullPath = path.join(skillPath, dir);
      if (fs.existsSync(fullPath)) {
        try {
          const files = fs.readdirSync(fullPath);
          result[dir] = files.length > 0;
        } catch {
          result[dir] = false;
        }
      } else {
        result[dir] = false;
      }
    }
    return result;
  }

  _buildActivationNote(skill) {
    const parts = [`[Skill activated: ${skill.name}]`];
    if (skill.description) {
      parts.push(skill.description);
    }
    if (skill.source === 'external') {
      parts.push('(external skill)');
    }
    return parts.join(' ');
  }

  getStats() {
    const registry = this.getRegistry();
    const stats = {
      total: registry.size,
      bySource: {},
      byCategory: {},
      withSupportFiles: 0,
      disabled: 0,
    };

    for (const skill of registry.values()) {
      stats.bySource[skill.source] = (stats.bySource[skill.source] || 0) + 1;
      stats.byCategory[skill.category] = (stats.byCategory[skill.category] || 0) + 1;
      if (skill.hasSupportFiles && Object.values(skill.hasSupportFiles).some(Boolean)) {
        stats.withSupportFiles++;
      }
      if (this._isDisabled(skill.name)) {
        stats.disabled++;
      }
    }

    return stats;
  }
}

let _instance = null;

function getSkillRegistry(config) {
  if (!_instance) {
    _instance = new SkillRegistry(config);
  }
  return _instance;
}

module.exports = { SkillRegistry, getSkillRegistry };
