const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');


// eslint-disable-next-line no-unused-vars
const { SKILLS_DIR, GLOBAL_SKILLS_DIR, DATA_DIR } = require('../config');

const SKILL_MD_FILENAME = 'SKILL.md';
const SKILL_JSON_FILENAME = 'skill.json';
const MAX_INSTALL_SIZE = 1024 * 1024;
const INSTALL_TIMEOUT_MS = 30000;
const TRUST_MARKER_FILENAME = '.trust';
const MAX_REDIRECTS = 5;

/**
 * 校验 skillName 防止路径穿越
 */
function _validateSkillName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('skillName 不能为空');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`skillName 包含非法字符: ${name}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`skillName 格式非法: ${name}，仅允许字母数字连字符下划线`);
  }
  return name;
}

const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^localhost$/i,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

class SkillFrontmatter {
  constructor(data = {}) {
    this.name = data.name || '';
    this.version = data.version || '1.0.0';
    this.description = data.description || '';
    this.author = data.author || '';
    this.tags = data.tags || [];
    this.tools = data.tools || [];
    this.scope = data.scope || 'user';
    this.trustRequired = data.trustRequired || false;
    this.model = data.model || null;
    this.maxIterations = data.maxIterations || null;
    this.resources = data.resources || [];
    this.inject = data.inject || { onToolMatch: [], onTagMatch: [] };
    this.metadata = data.metadata || {};
    // 条件性激活
    this.platforms = data.platforms || null;
    this.requiresTools = data.requiresTools || [];
    this.fallbackForTools = data.fallbackForTools || [];
    // Iron Law 模式（参考 Superpowers）
    // ironLaw: 不可跳过的核心规则，大写声明，技能执行时必须遵守
    // redFlags: 代理可能用来跳过规则的合理化借口列表，用于预防性拦截
    // phase: 技能所属的对话阶段（exploration/planning/implementation/debugging/verification/completion）
    // mandatory: 是否为强制技能（不可被代理自行跳过）
    this.ironLaw = data.ironLaw || null;
    this.redFlags = data.redFlags || [];
    this.phase = data.phase || null;
    this.mandatory = data.mandatory || false;
  }

  toJSON() {
    return {
      name: this.name,
      version: this.version,
      description: this.description,
      author: this.author,
      tags: this.tags,
      tools: this.tools,
      scope: this.scope,
      trustRequired: this.trustRequired,
      model: this.model,
      maxIterations: this.maxIterations,
      resources: this.resources,
      inject: this.inject,
      metadata: this.metadata,
      platforms: this.platforms,
      requiresTools: this.requiresTools,
      fallbackForTools: this.fallbackForTools,
      ironLaw: this.ironLaw,
      redFlags: this.redFlags,
      phase: this.phase,
      mandatory: this.mandatory,
    };
  }
}

class SkillMdParser {
  static parse(content) {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      return { frontmatter: new SkillFrontmatter(), instructions: content };
    }

    const yamlStr = frontmatterMatch[1];
    const instructions = frontmatterMatch[2];

    const frontmatter = new SkillFrontmatter(SkillMdParser._parseYaml(yamlStr));
    return { frontmatter, instructions };
  }

  static serialize(frontmatter, instructions) {
    const yaml = SkillMdParser._serializeYaml(frontmatter.toJSON());
    return `---\n${yaml}\n---\n\n${instructions}`;
  }

  static _parseYaml(yaml) {
    const result = {};
    const lines = yaml.split('\n');
    let currentKey = null;
    let currentObjKey = null;
    let inArray = false;
    let inObject = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed.startsWith('- ') && inArray && currentKey) {
        const value = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
        if (inObject && currentObjKey) {
          if (!result[currentKey]) result[currentKey] = [];
          if (typeof result[currentKey][result[currentKey].length - 1] === 'object') {
            result[currentKey][result[currentKey].length - 1][currentObjKey] = this._parseValue(value);
          }
        } else {
          if (!Array.isArray(result[currentKey])) result[currentKey] = [];
          result[currentKey].push(this._parseValue(value));
        }
        continue;
      }

      const match = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
      if (match) {
        const key = match[1];
        const value = match[2].trim();

        if (value === '' || value === '|' || value === '>') {
          currentKey = key;
          inArray = false;
          inObject = false;
          if (value === '' && !result[key]) result[key] = null;
          continue;
        }

        currentKey = key;
        inArray = false;
        inObject = false;

        if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        } else {
          result[key] = this._parseValue(value);
        }
      }
    }

    return result;
  }

  static _parseValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null') return null;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    return value.replace(/^["']|["']$/g, '');
  }

  static _serializeYaml(obj) {
    const lines = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) {
        lines.push(`${key}: null`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${key}: []`);
        } else {
          lines.push(`${key}:`);
          for (const item of value) {
            if (typeof item === 'object' && item !== null) {
              lines.push(`  - ${JSON.stringify(item)}`);
            } else {
              lines.push(`  - ${item}`);
            }
          }
        }
      } else if (typeof value === 'object') {
        lines.push(`${key}:`);
        for (const [k, v] of Object.entries(value)) {
          if (Array.isArray(v)) {
            lines.push(`  ${k}:`);
            for (const item of v) {
              lines.push(`    - ${item}`);
            }
          } else {
            lines.push(`  ${k}: ${v}`);
          }
        }
      } else if (typeof value === 'string') {
        if (value.includes(':') || value.includes('#') || value.includes("'") || value.includes('"')) {
          lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
        } else {
          lines.push(`${key}: ${value}`);
        }
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    return lines.join('\n');
  }
}

class SkillDiscoverer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._userSkillsDir = config.userSkillsDir || GLOBAL_SKILLS_DIR;
    this._projectSkillsDir = config.projectSkillsDir || SKILLS_DIR;
    this._trustDir = config.trustDir || path.join(this._projectSkillsDir, '..', '.crabpaw', 'trust');
    this._cache = new Map();
    this._cacheValid = false;
    this._lastScan = 0;
    this._scanInterval = 30000;
  }

  discoverAll() {
    const now = Date.now();
    if (this._cacheValid && (now - this._lastScan) < this._scanInterval) {
      return [...this._cache.values()];
    }

    const skills = new Map();

    this._scanDirectory(this._userSkillsDir, 'user', skills);

    this._scanDirectory(this._projectSkillsDir, 'project', skills);

    this._cache = skills;
    this._cacheValid = true;
    this._lastScan = now;

    return [...skills.values()];
  }

  _scanDirectory(dir, scope, skillsMap) {
    if (!fs.existsSync(dir)) return;

    const trustMarkers = this._loadTrustMarkers(dir);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

        const skillPath = path.join(dir, entry.name);
        let skill = null;

        if (entry.isDirectory()) {
          skill = this._loadDirectorySkill(skillPath, scope, trustMarkers);
        } else if (entry.name.endsWith('.md')) {
          skill = this._loadMdSkill(skillPath, scope);
        }

        if (skill) {
          const existing = skillsMap.get(skill.name);
          if (existing && existing.scope === 'project') {
            continue;
          }
          skillsMap.set(skill.name, skill);
        }
      }
    } catch (e) { console.warn('[skill-md-system] Failed to scan directory:', e.message); }
  }

  _loadDirectorySkill(dirPath, scope, _trustMarkers) {
    const mdPath = path.join(dirPath, SKILL_MD_FILENAME);
    const jsonPath = path.join(dirPath, SKILL_JSON_FILENAME);

    if (fs.existsSync(mdPath)) {
      return this._loadMdSkill(mdPath, scope, dirPath);
    }

    if (fs.existsSync(jsonPath)) {
      return this._loadJsonSkill(jsonPath, scope, dirPath);
    }

    return null;
  }

  _loadMdSkill(mdPath, scope, dirPath = null, trustMarkers = null) {
    try {
      const content = fs.readFileSync(mdPath, 'utf-8');
      const { frontmatter, instructions } = SkillMdParser.parse(content);

      const skillName = frontmatter.name || path.basename(dirPath || mdPath, '.md');

      return {
        name: skillName,
        version: frontmatter.version,
        description: frontmatter.description,
        author: frontmatter.author,
        tags: frontmatter.tags,
        tools: frontmatter.tools,
        scope,
        trustRequired: frontmatter.trustRequired,
        trustMarker: trustMarkers?.has(skillName) || false,
        model: frontmatter.model,
        maxIterations: frontmatter.maxIterations,
        resources: frontmatter.resources,
        inject: frontmatter.inject,
        instructions,
        path: dirPath || path.dirname(mdPath),
        format: 'skill-md',
        metadata: frontmatter.metadata,
      };
    } catch {
      return null;
    }
  }

  _loadJsonSkill(jsonPath, scope, dirPath = null) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf-8');
      const data = JSON.parse(content);

      return {
        name: data.name || path.basename(dirPath || jsonPath, '.json'),
        version: data.version || '1.0.0',
        description: data.description || '',
        author: data.author || '',
        tags: data.tags || [],
        tools: data.tools || [],
        scope,
        trustRequired: data.trustRequired || false,
        trustMarker: false,
        model: data.model || null,
        maxIterations: data.maxIterations || null,
        resources: data.resources || [],
        inject: data.inject || { onToolMatch: [], onTagMatch: [] },
        instructions: data.instructions || data.content || '',
        path: dirPath || path.dirname(jsonPath),
        format: 'skill-json',
        metadata: data.metadata || {},
      };
    } catch {
      return null;
    }
  }

  _loadTrustMarkers(dir) {
    const trustPath = path.join(dir, TRUST_MARKER_FILENAME);
    if (!fs.existsSync(trustPath)) return new Set();

    try {
      const content = fs.readFileSync(trustPath, 'utf-8');
      const names = content.split('\n').map(s => s.trim()).filter(Boolean);
      return new Set(names);
    } catch {
      return new Set();
    }
  }

  invalidateCache() {
    this._cacheValid = false;
  }
}

class SkillInstaller extends EventEmitter {
  constructor(config = {}) {
    super();
    this._skillsDir = config.skillsDir || GLOBAL_SKILLS_DIR;
    this._timeout = config.timeout || INSTALL_TIMEOUT_MS;
    this._maxSize = config.maxSize || MAX_INSTALL_SIZE;
  }

  async installFromUrl(url, opts = {}) {
    const safetyCheck = this._validateUrl(url);
    if (!safetyCheck.safe) {
      throw new Error(`URL safety check failed: ${safetyCheck.reason}`);
    }

    const resolvedUrl = this._resolveGithubUrl(url);

    const content = await this._fetchContent(resolvedUrl, opts);

    if (content.length > this._maxSize) {
      throw new Error(`Content exceeds maximum size (${this._maxSize} bytes)`);
    }

    const skillName = opts.name || this._extractSkillName(url, content);
    _validateSkillName(skillName);

    const targetDir = path.join(this._skillsDir, skillName);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetPath = path.join(targetDir, SKILL_MD_FILENAME);
    fs.writeFileSync(targetPath, content, 'utf-8');

    this.emit('skill:installed', { name: skillName, url, path: targetPath });

    return {
      name: skillName,
      path: targetPath,
      size: content.length,
    };
  }

  _validateUrl(url) {
    try {
      const parsed = new URL(url);

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { safe: false, reason: `Unsupported protocol: ${parsed.protocol}` };
      }

      const hostname = parsed.hostname;

      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          return { safe: false, reason: `Private/internal IP address: ${hostname}` };
        }
      }

      return { safe: true };
    } catch (e) {
      return { safe: false, reason: `Invalid URL: ${e.message}` };
    }
  }

  _resolveGithubUrl(url) {
    const githubMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (githubMatch) {
      const [, owner, repo, path] = githubMatch;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`;
    }
    return url;
  }

  async _fetchContent(url, opts = {}) {
    const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
    if (maxRedirects <= 0) {
      throw new Error('Too many redirects');
    }
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: { 'User-Agent': 'CrabPaw-SkillInstaller/1.0' },
        timeout: this._timeout,
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this._fetchContent(res.headers.location, { ...opts, maxRedirects: maxRedirects - 1 }).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  _extractSkillName(url, content) {
    const { frontmatter } = SkillMdParser.parse(content);
    if (frontmatter.name) return frontmatter.name.toLowerCase().replace(/\s+/g, '-');

    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const filename = parts[parts.length - 1];
      return filename.replace(/\.(md|markdown)$/i, '').toLowerCase();
    } catch {
      return `skill_${Date.now()}`;
    }
  }

  createScaffold(name, opts = {}) {
    _validateSkillName(name);
    const targetDir = path.join(this._skillsDir, name);
    if (fs.existsSync(targetDir)) {
      throw new Error(`Skill "${name}" already exists`);
    }

    fs.mkdirSync(targetDir, { recursive: true });

    const frontmatter = new SkillFrontmatter({
      name,
      description: opts.description || `${name} skill`,
      author: opts.author || '',
      tags: opts.tags || [],
      tools: opts.tools || [],
      scope: opts.scope || 'user',
    });

    const instructions = opts.instructions || `# ${name}\n\nInstructions for the ${name} skill.\n`;
    const content = SkillMdParser.serialize(frontmatter, instructions);

    fs.writeFileSync(path.join(targetDir, SKILL_MD_FILENAME), content, 'utf-8');

    this.emit('skill:created', { name, path: targetDir });
    return { name, path: targetDir };
  }

  uninstall(name) {
    const skillDir = path.join(this._skillsDir, name);
    if (!fs.existsSync(skillDir)) {
      return false;
    }

    fs.rmSync(skillDir, { recursive: true, force: true });
    this.emit('skill:uninstalled', { name });
    return true;
  }
}

class SkillInjector extends EventEmitter {
  constructor(config = {}) {
    super();
    this._maxInjectedSkills = config.maxInjectedSkills || 5;
    this._discoverer = config.discoverer || new SkillDiscoverer();
  }

  injectForContext(context) {
    const allSkills = this._discoverer.discoverAll();
    const matched = [];

    const activeTools = context.tools || [];
    const activeTags = context.tags || [];
    const currentPhase = context.phase || null;

    for (const skill of allSkills) {
      if (skill.trustRequired && !skill.trustMarker) continue;

      let matchScore = 0;

      if (skill.inject?.onToolMatch) {
        for (const toolPattern of skill.inject.onToolMatch) {
          if (activeTools.some(t => t.name === toolPattern || t === toolPattern)) {
            matchScore += 2;
          }
        }
      }

      if (skill.inject?.onTagMatch) {
        for (const tagPattern of skill.inject.onTagMatch) {
          if (activeTags.includes(tagPattern)) {
            matchScore += 1;
          }
        }
      }

      // 基于对话阶段的自动触发（参考 Superpowers 上下文感知触发）
      if (skill.phase && currentPhase && skill.phase === currentPhase) {
        matchScore += 3; // 阶段匹配权重最高
      }

      // 强制技能在匹配阶段自动激活，即使没有其他匹配
      if (skill.mandatory && skill.phase === currentPhase) {
        matchScore = Math.max(matchScore, 5); // 强制激活
      }

      if (matchScore > 0) {
        matched.push({ ...skill, matchScore });
      }
    }

    matched.sort((a, b) => b.matchScore - a.matchScore);

    const injected = matched.slice(0, this._maxInjectedSkills);

    this.emit('skills:injected', {
      count: injected.length,
      names: injected.map(s => s.name),
    });

    return injected;
  }

  buildInjectionPrompt(injectedSkills) {
    if (!injectedSkills.length) return '';

    const sections = injectedSkills.map(skill => {
      let section = `### Skill: ${skill.name} (v${skill.version})\n`;
      if (skill.description) section += `${skill.description}\n\n`;

      // Iron Law 注入（参考 Superpowers 的不可跳过规则模式）
      if (skill.ironLaw) {
        section += `**IRON LAW (不可跳过):** ${skill.ironLaw}\n\n`;
      }
      if (skill.redFlags && skill.redFlags.length > 0) {
        section += `**红旗警告 — 以下借口不能用来跳过此技能:**\n`;
        for (const flag of skill.redFlags) {
          section += `- ❌ "${flag}"\n`;
        }
        section += '\n';
      }
      if (skill.mandatory) {
        section += `**此技能为强制执行。你不能自行决定跳过它。**\n\n`;
      }

      section += skill.instructions;
      return section;
    });

    return `## Active Skills\n\n${sections.join('\n\n---\n\n')}`;
  }
}

module.exports = {
  SkillFrontmatter,
  SkillMdParser,
  SkillDiscoverer,
  SkillInstaller,
  SkillInjector,
  SKILL_MD_FILENAME,
  SKILL_JSON_FILENAME,
};
