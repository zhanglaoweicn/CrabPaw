const fs = require('fs');
const path = require('path');

const { EventEmitter } = require('events');
const { SKILLS_DIR, DATA_DIR } = require('../config');
const { getSkillRegistry } = require('./skill-registry-enhanced');

const BUNDLES_DIR = path.join(DATA_DIR, 'skill-bundles');
const BUNDLE_MANIFEST_FILE = 'bundle.json';
const BUNDLE_SKILLS_DIR = 'skills';

const INVALID_CHARS = /[^a-z0-9-]/g;
const MULTI_HYPHEN = /-{2,}/g;

function _slugify(name) {
  let slug = name.toLowerCase().replace(/[\s_]+/g, '-');
  slug = slug.replace(INVALID_CHARS, '');
  slug = slug.replace(MULTI_HYPHEN, '-').replace(/^-|-$/g, '');
  return slug;
}

function _maxMtime(files) {
  let max = 0;
  const base = BUNDLES_DIR;
  if (fs.existsSync(base)) {
    try { max = Math.max(max, fs.statSync(base).mtimeMs); } catch (e) { console.warn('[skill-bundle-v2] Failed to stat base dir:', e.message); }
  }
  for (const f of files) {
    try { max = Math.max(max, fs.statSync(f).mtimeMs); } catch (e) { console.warn('[skill-bundle-v2] Failed to stat file:', e.message); }
  }
  return max;
}

class SkillBundle extends EventEmitter {
  constructor(bundleDir) {
    super();
    this.dir = bundleDir;
    this.manifest = null;
    this._skills = new Map();
    this._yamlData = null;
  }

  get id() {
    return this.manifest?.id || this._yamlData?.slug || '';
  }

  get name() {
    return this.manifest?.name || this._yamlData?.name || '';
  }

  get slug() {
    return this._yamlData?.slug || _slugify(this.name);
  }

  get version() {
    return this.manifest?.version || '1.0.0';
  }

  get description() {
    return this.manifest?.description || this._yamlData?.description || '';
  }

  get instruction() {
    return this._yamlData?.instruction || this.manifest?.instruction || '';
  }

  get skillNames() {
    return this._yamlData?.skills || this.manifest?.skills || [];
  }

  get skillCount() {
    return this._skills.size;
  }

  async load() {
    this._skills.clear();
    this._yamlData = null;

    const yamlPath = path.join(this.dir, 'bundle.yaml');
    const yamlAltPath = path.join(this.dir, 'bundle.yml');

    if (fs.existsSync(yamlPath) || fs.existsSync(yamlAltPath)) {
      const yamlFile = fs.existsSync(yamlPath) ? yamlPath : yamlAltPath;
      this._yamlData = this._parseYamlBundle(fs.readFileSync(yamlFile, 'utf-8'));
      if (this._yamlData) {
        this._loadReferencedSkills();
        return this;
      }
    }

    const manifestPath = path.join(this.dir, BUNDLE_MANIFEST_FILE);
    if (fs.existsSync(manifestPath)) {
      this.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const skillsPath = path.join(this.dir, BUNDLE_SKILLS_DIR);
      if (fs.existsSync(skillsPath)) {
        const entries = fs.readdirSync(skillsPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillFile = path.join(skillsPath, entry.name, 'SKILL.md');
            if (fs.existsSync(skillFile)) {
              const content = fs.readFileSync(skillFile, 'utf-8');
              this._skills.set(entry.name, {
                name: entry.name,
                content,
                path: path.join(skillsPath, entry.name),
              });
            }
          }
        }
      }
      return this;
    }

    throw new Error(`Bundle manifest not found: ${this.dir}`);
  }

  _parseYamlBundle(content) {
    const data = {};
    const lines = content.split('\n');
    let currentKey = null;
    let currentValue = [];
    let inList = false;
    let inMultiline = false;
    let multilineKey = null;

    for (const line of lines) {
      if (inMultiline) {
        if (line.trim() === '' || line.startsWith('  ') || line.startsWith('\t')) {
          currentValue.push(line);
          continue;
        } else {
          data[multilineKey] = currentValue.join('\n').trim();
          inMultiline = false;
          multilineKey = null;
          currentValue = [];
        }
      }

      const listMatch = line.match(/^(\s*)-\s+(.+)$/);
      if (inList && listMatch) {
        currentValue.push(listMatch[2].replace(/^["']|["']$/g, ''));
        continue;
      }

      const colonMatch = line.match(/^([\w.-]+)\s*:\s*(.*)$/);
      if (colonMatch) {
        if (currentKey && currentValue.length > 0) {
          data[currentKey] = inList ? currentValue : (currentValue.length === 1 ? currentValue[0] : currentValue);
        }
        currentKey = colonMatch[1];
        const val = colonMatch[2].trim();
        inList = false;

        if (val === '' || val === '|' || val === '>') {
          if (val === '|' || val === '>') {
            inMultiline = true;
            multilineKey = currentKey;
          }
          currentValue = [];
        } else if (val.startsWith('[') && val.endsWith(']')) {
          try {
            data[currentKey] = JSON.parse(val);
          } catch {
            data[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
          }
          currentKey = null;
          currentValue = [];
        } else {
          data[currentKey] = val.replace(/^["']|["']$/g, '');
          currentKey = null;
          currentValue = [];
        }
      } else if (currentKey && line.startsWith('  ')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) {
          inList = true;
          currentValue.push(trimmed.slice(2).replace(/^["']|["']$/g, ''));
        }
      }
    }

    if (currentKey && currentValue.length > 0) {
      data[currentKey] = inList ? currentValue : (currentValue.length === 1 ? currentValue[0] : currentValue);
    }
    if (multilineKey && currentValue.length > 0) {
      data[multilineKey] = currentValue.join('\n').trim();
    }

    if (!data.name && !data.skills) return null;
    if (!data.slug) data.slug = _slugify(data.name || path.basename(this.dir));

    return data;
  }

  _loadReferencedSkills() {
    const registry = getSkillRegistry();
    const skillRefs = this._yamlData.skills || [];

    for (const skillName of skillRefs) {
      const skill = registry.getSkill(skillName);
      if (skill) {
        this._skills.set(skill.name, {
          name: skill.name,
          content: skill.rawContent || skill.body || '',
          path: skill.dir,
        });
      }
    }
  }

  getSkill(skillName) {
    return this._skills.get(skillName) || null;
  }

  listSkills() {
    return [...this._skills.values()];
  }

  getActivationPrompt() {
    const parts = [];
    parts.push(`# Skill Bundle: ${this.name}`);
    if (this.description) {
      parts.push(this.description);
    }

    const skillList = this.listSkills();
    if (skillList.length > 0) {
      parts.push('\n## Included Skills:');
      for (const skill of skillList) {
        const firstLine = skill.content.split('\n').find(l => l.trim()) || skill.name;
        parts.push(`- ${skill.name}: ${firstLine.replace(/^#+\s*/, '').trim()}`);
      }
    }

    if (this.instruction) {
      parts.push('\n## Bundle Instructions:');
      parts.push(this.instruction);
    }

    const deps = this._yamlData?.dependencies || this.manifest?.dependencies || [];
    if (deps.length > 0) {
      parts.push('\n## Dependencies:');
      for (const dep of deps) {
        parts.push(`- ${dep}`);
      }
    }

    const commands = this._yamlData?.commands || this.manifest?.commands || {};
    const commandEntries = Object.entries(commands);
    if (commandEntries.length > 0) {
      parts.push('\n## Bundle Commands:');
      for (const [cmd, desc] of commandEntries) {
        parts.push(`- \`/${cmd}\`: ${desc}`);
      }
    }

    return parts.join('\n');
  }

  resolveCommand(commandName) {
    const commands = this._yamlData?.commands || this.manifest?.commands || {};
    if (commands[commandName]) {
      const skillSequence = this._yamlData?.commandSkills?.[commandName] || this.manifest?.commandSkills?.[commandName];
      return {
        bundle: this.slug,
        command: commandName,
        description: commands[commandName],
        skillSequence: skillSequence || this.skillNames,
      };
    }
    return null;
  }

  getDependencies() {
    return this._yamlData?.dependencies || this.manifest?.dependencies || [];
  }

  resolveDependencyOrder(allBundles) {
    const visited = new Set();
    const order = [];

    const visit = (bundleSlug) => {
      if (visited.has(bundleSlug)) return;
      visited.add(bundleSlug);

      const bundle = allBundles.get(`/${bundleSlug}`);
      if (bundle) {
        const deps = bundle.getDependencies();
        for (const dep of deps) {
          visit(dep);
        }
        order.push(bundle);
      }
    };

    visit(this.slug);
    return order;
  }

  matchesTrigger(userMessage) {
    const triggers = this.manifest?.activationTriggers || this._yamlData?.triggers || [];
    if (!triggers || triggers.length === 0) return false;
    const lower = userMessage.toLowerCase();
    return triggers.some(trigger => lower.includes(trigger.toLowerCase()));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      slug: this.slug,
      version: this.version,
      description: this.description,
      instruction: this.instruction ? true : false,
      skillCount: this.skillCount,
      skills: this.skillNames,
      createdAt: this.manifest?.createdAt,
      updatedAt: this.manifest?.updatedAt,
    };
  }
}

class SkillBundleManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._bundles = new Map();
    this._skillsDir = config.skillsDir || SKILLS_DIR;
    this._cacheMtime = 0;
  }

  async initialize() {
    if (!fs.existsSync(BUNDLES_DIR)) {
      fs.mkdirSync(BUNDLES_DIR, { recursive: true });
    }
    await this.loadAll();
  }

  async loadAll() {
    this._bundles.clear();
    if (!fs.existsSync(BUNDLES_DIR)) return;

    const entries = fs.readdirSync(BUNDLES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bundle = new SkillBundle(path.join(BUNDLES_DIR, entry.name));
      try {
        await bundle.load();
        const key = `/${bundle.slug}`;
        if (!this._bundles.has(key)) {
          this._bundles.set(key, bundle);
        }
      } catch (e) { console.warn('[skill-bundle-v2] Failed to load bundle:', e.message); }
    }

    this._cacheMtime = _maxMtime(this._iterBundleFiles());
  }

  getAllBundles() {
    return this._bundles;
  }

  getBundle(slugOrId) {
    if (this._bundles.has(slugOrId)) return this._bundles.get(slugOrId);
    if (this._bundles.has(`/${slugOrId}`)) return this._bundles.get(`/${slugOrId}`);
    for (const bundle of this._bundles.values()) {
      if (bundle.id === slugOrId || bundle.name === slugOrId) return bundle;
    }
    return null;
  }

  async reloadIfNeeded() {
    const currentMtime = _maxMtime(this._iterBundleFiles());
    if (currentMtime > this._cacheMtime) {
      await this.loadAll();
      return true;
    }
    return false;
  }

  async createBundle(name, options = {}) {
    const slug = _slugify(name);
    const bundleDir = path.join(BUNDLES_DIR, slug);

    if (fs.existsSync(bundleDir)) {
      throw new Error(`Bundle already exists: ${slug}`);
    }

    fs.mkdirSync(bundleDir, { recursive: true });

    if (options.yaml !== false) {
      const yamlLines = [
        `name: ${name}`,
        `description: ${options.description || ''}`,
        `skills:`,
      ];
      for (const skill of (options.skills || [])) {
        yamlLines.push(`  - ${skill}`);
      }
      if (options.instruction) {
        yamlLines.push(`instruction: |`);
        for (const line of options.instruction.split('\n')) {
          yamlLines.push(`  ${line}`);
        }
      }
      fs.writeFileSync(path.join(bundleDir, 'bundle.yaml'), yamlLines.join('\n'), 'utf-8');
    } else {
      fs.mkdirSync(path.join(bundleDir, BUNDLE_SKILLS_DIR), { recursive: true });
      const manifest = {
        id: slug,
        name,
        description: options.description || '',
        version: options.version || '1.0.0',
        skills: options.skills || [],
        instruction: options.instruction || '',
        activationTriggers: options.activationTriggers || [],
        tags: options.tags || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(bundleDir, BUNDLE_MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );
    }

    const bundle = new SkillBundle(bundleDir);
    await bundle.load();
    this._bundles.set(`/${slug}`, bundle);
    this.emit('bundle_created', { slug, name });
    return bundle;
  }

  async deleteBundle(slugOrId) {
    const bundle = this.getBundle(slugOrId);
    if (!bundle) throw new Error(`Bundle not found: ${slugOrId}`);

    if (fs.existsSync(bundle.dir)) {
      fs.rmSync(bundle.dir, { recursive: true, force: true });
    }
    this._bundles.delete(`/${bundle.slug}`);
    this.emit('bundle_deleted', { slug: bundle.slug });
  }

  listBundles() {
    return [...this._bundles.values()].map(b => b.toJSON());
  }

  findMatchingBundles(userMessage) {
    const matches = [];
    for (const bundle of this._bundles.values()) {
      if (bundle.matchesTrigger(userMessage)) {
        matches.push(bundle);
      }
    }
    return matches;
  }

  resolveBundleCommand(commandName) {
    for (const bundle of this._bundles.values()) {
      const resolved = bundle.resolveCommand(commandName);
      if (resolved) return resolved;
    }
    return null;
  }

  async activateBundle(slugOrId) {
    const bundle = this.getBundle(slugOrId);
    if (!bundle) return null;

    const orderedBundles = bundle.resolveDependencyOrder(this._bundles);
    const activationResult = {
      bundle: bundle.slug,
      dependencies: orderedBundles.filter(b => b.slug !== bundle.slug).map(b => b.slug),
      skills: [],
      prompt: '',
    };

    for (const depBundle of orderedBundles) {
      const skills = depBundle.listSkills();
      for (const skill of skills) {
        activationResult.skills.push({
          bundle: depBundle.slug,
          name: skill.name,
          content: skill.content,
        });
      }
    }

    activationResult.prompt = bundle.getActivationPrompt();
    this.emit('bundle_activated', { slug: bundle.slug, skillCount: activationResult.skills.length });
    return activationResult;
  }

  _iterBundleFiles() {
    if (!fs.existsSync(BUNDLES_DIR)) return [];
    const files = [];
    // eslint-disable-next-line no-unused-vars
    for (const ext of ['*.yaml', '*.yml', '*.json']) {
      for (const f of fs.readdirSync(BUNDLES_DIR)) {
        const fullPath = path.join(BUNDLES_DIR, f);
        if (fs.statSync(fullPath).isFile()) files.push(fullPath);
      }
    }
    return files;
  }
}

let _instance = null;

function getSkillBundleManager(config) {
  if (!_instance) {
    _instance = new SkillBundleManager(config);
  }
  return _instance;
}

module.exports = {
  SkillBundle,
  SkillBundleManager,
  getSkillBundleManager,
  _slugify,
};
