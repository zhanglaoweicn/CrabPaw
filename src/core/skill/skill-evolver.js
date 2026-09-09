const { canAutoEvolve } = require('./skill-provenance');
/**
 * Skill Evolver  ܽ
 *
 * ο OpenSpace SkillEvolver ƣΪ CrabPaw ṩ
 * - FIX: ޸/ʱļܣԭ޸ģ汾ʷ
 * - DERIVED: мǿ棨ƺ޸ģ
 * - CAPTURED: ִвģʽȫ¼ܣ
 *
 * ̣
 *   EvolutionSuggestion  processSuggestion  _evolveFix/_evolveDerived/_evolveCaptured
 *    Ӧ patch  ֤  д汾ʷ  ע
 *
 * ѭƣ
 *   - ͬһܶʱڲظ
 *   - ۲ڣ24h۲ڲٽ
 *   - 
 */

/**
 * @deprecated This module has been superseded by src/core/evolution/skill-evolution.js.
 *
 * Migrate to SkillEvolutionEngine.
 *   SkillEvolver.processSuggestion -> SkillEvolutionEngine.evolveXXX()
 *   SkillEvolver.getHistory        -> SkillEvolutionEngine.data.evolutionHistory
 *   SkillEvolver.getStats          -> SkillEvolutionEngine.data.stats
 *
 * New code: const { getSkillEvolutionEngine } = require("../evolution/skill-evolution");
 *
 * This file will be removed in 30 days.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR, DATA_DIR } = require('../config');
const { EvolutionType } = require('./execution-analyzer');
// eslint-disable-next-line no-unused-vars -- getQualityTracker 未使用
const { getQualityTracker } = require('./skill-quality-tracker');
// eslint-disable-next-line no-unused-vars -- atomicWriteJSON/atomicWriteFile 未使用
const { atomicWriteJSON, atomicWriteFile } = require('../atomic-write');
// eslint-disable-next-line no-unused-vars -- getSkillLineage 未使用
const { getSkillLineage } = require('./skill-lineage');

/**
 * У skillName ֹ·Խ
 */
function _validateSkillName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('skillName Ϊ');
  }
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error(`skillName Ƿַ: ${name}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`skillName ʽǷ: ${name}ĸַ»`);
  }
  return name;
}

const EVOLUTION_DIR = path.join(DATA_DIR, 'evolution');
const EVOLUTION_HISTORY_FILE = path.join(EVOLUTION_DIR, 'evolution-history.json');
const OBSERVATION_FILE = path.join(EVOLUTION_DIR, 'observations.json');
const LOCK_DIR = path.join(EVOLUTION_DIR, '.locks');

const MAX_EVOLUTIONS_PER_SKILL = 5;     // ÿ
const OBSERVATION_DURATION_MS = 24 * 60 * 60 * 1000; // 24h ۲
const MAX_EVOLUTION_HISTORY = 200;
const MAX_CONCURRENT_EVOLUTIONS = 3;
const LOCK_TIMEOUT_MS = 30000; // ʱʱ

/**
 * ļʵ
 */
function acquireLock(skillName) {
  _validateSkillName(skillName);
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }

  const lockFile = path.join(LOCK_DIR, `${skillName}.lock`);
  const lockData = {
    pid: process.pid,
    timestamp: Date.now(),
  };

  // Ƿڹ
  if (fs.existsSync(lockFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      if (Date.now() - existing.timestamp > LOCK_TIMEOUT_MS) {
        // ѹڣԻȡ
        fs.writeFileSync(lockFile, JSON.stringify(lockData), 'utf-8');
        return true;
      }
      // ȻЧ
      return false;
    } catch {
      // 𻵵ļ
      fs.writeFileSync(lockFile, JSON.stringify(lockData), 'utf-8');
      return true;
    }
  }

  // 
  fs.writeFileSync(lockFile, JSON.stringify(lockData), 'utf-8');
  return true;
}

function releaseLock(skillName) {
  _validateSkillName(skillName);
  const lockFile = path.join(LOCK_DIR, `${skillName}.lock`);
  try {
    if (fs.existsSync(lockFile)) {
      const existing = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      // ֻͷԼе
      if (existing.pid === process.pid) {
        fs.unlinkSync(lockFile);
      }
    }
  } catch (e) {
    console.warn('[skill-evolver] Failed to release lock:', e.message);
  }
}

/**
 * ȫɨ裺鼼ܴǷģʽ
 */
function scanSkillSecurity(skillDir) {
  const warnings = [];
  const errors = [];

  //  executor.js
  const executorPath = path.join(skillDir, 'executor.js');
  if (fs.existsSync(executorPath)) {
    const content = fs.readFileSync(executorPath, 'utf-8');

    // Σģʽ
    const dangerousPatterns = [
      { pattern: /eval\s*\(/, msg: 'ʹ eval() ܵ´ע' },
      { pattern: /Function\s*\(/, msg: 'ʹ Function() 캯Σ' },
      { pattern: /child_process.*exec\s*\(/, msg: 'ʹ exec() ܵע' },
      { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, msg: ' child_process' },
      { pattern: /process\.exit/, msg: ' process.exit ܵ˳' },
      { pattern: /fs\.unlinkSync|fs\.rmSync/, msg: 'ɾļ' },
      { pattern: /\.\.\/|\.\.\\/, msg: '·' },
    ];

    for (const { pattern, msg } of dangerousPatterns) {
      if (pattern.test(content)) {
        warnings.push(`executor.js: ${msg}`);
      }
    }
  }

  //  scripts Ŀ¼
  const scriptsDir = path.join(skillDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    const scripts = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js') || f.endsWith('.py'));
    for (const script of scripts) {
      const scriptPath = path.join(scriptsDir, script);
      const content = fs.readFileSync(scriptPath, 'utf-8');

      // Python Σģʽ
      if (script.endsWith('.py')) {
        if (/os\.system|subprocess\.call|eval\s*\(|exec\s*\(/.test(content)) {
          warnings.push(`${script}: ܴڴִз`);
        }
      }
    }
  }

  return { safe: errors.length === 0, errors, warnings };
}

class EvolutionRecord {
  constructor({ skillName, type, parentVersion, newVersion, reason, changes, success }) {
    this.id = `evo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.skillName = skillName;
    this.type = type;
    this.parentVersion = parentVersion;
    this.newVersion = newVersion;
    this.reason = reason;
    this.changes = changes;
    this.success = success;
    this.timestamp = new Date().toISOString();
  }
}

// ============================================================
// 该类已过时，保留仅为向后兼容?
// 新代码请使用 src/core/evolution/skill-evolution.js
// ============================================================

// ============================================================
// DEPRECATED: retained for backward compatibility only.
// New code should use src/core/evolution/skill-evolution.js
// ============================================================

class SkillEvolver {
  constructor(config = {}) {
    this.config = {
      maxEvolutionsPerSkill: config.maxEvolutionsPerSkill || MAX_EVOLUTIONS_PER_SKILL,
      observationDurationMs: config.observationDurationMs || OBSERVATION_DURATION_MS,
      autoApply: config.autoApply === true,  // ?? Ĭ falseʽ
      dryRun: config.dryRun || false,
      requireValidation: config.requireValidation !== false, // ĬҪ֤ͨӦ
      ...config,
    };

    this._history = [];
    this._observations = new Map(); // skillName  observationEndTime
    this._activeEvolutions = 0;
    this._evolutionCount = new Map(); // skillName  count
    this._llmClient = null;
    this._versionStore = null;
    this._coordinator = null;  // Э
    this._validator = null;    // ֤
    this._initialized = false;
  }

  initialize({ llmClient, versionStore, coordinator, validator, rollbackManager } = {}) {
    this._llmClient = llmClient || null;
    this._versionStore = versionStore || null;
    this._coordinator = coordinator || null;
    this._validator = validator || null;
    this._rollbackManager = rollbackManager || null;

    if (!fs.existsSync(EVOLUTION_DIR)) {
      fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
    }

    this._loadHistory();
    this._loadObservations();
    this._rebuildEvolutionCount();
    this._initialized = true;

    console.log('[SkillEvolver] ʼ, ʷ ' + this._history.length + ' ');
  }

  setLLMClient(client) {
    this._llmClient = client;
  }

  setVersionStore(store) {
    this._versionStore = store;
  }

  /**
   * 飨ڣ
   */
  async processSuggestion(suggestion) {
    // Provenance gate: Զ޸ûӵеļ
    if (suggestion && suggestion.skillName && !canAutoEvolve(suggestion.skillName)) {
      console.log(`[SkillEvolver] ûӵеļ (provenance gate): ${suggestion.skillName}`);
      return { skipped: true, reason: 'user_owned_skill', skillName: suggestion.skillName };
    }
    if (!this._initialized) return null;

    // ѭ۲
    if (this._isInObservation(suggestion.targetSkillIds[0])) {
      console.log(`[SkillEvolver] ${suggestion.targetSkillIds[0]} ڹ۲ڣ`);
      return null;
    }

    // ѭ
    const skillName = suggestion.targetSkillIds[0];
    const count = this._evolutionCount.get(skillName) || 0;
    if (count >= this.config.maxEvolutionsPerSkill) {
      console.log(`[SkillEvolver] ${skillName} Ѵ ${count}`);
      return null;
    }

    // 
    if (this._activeEvolutions >= MAX_CONCURRENT_EVOLUTIONS) {
      console.log('[SkillEvolver] ');
      return null;
    }

    // ͨЭύãϵͳͻ
    if (this._coordinator) {
      try {
        // eslint-disable-next-line no-unused-vars -- coordinated 未使用，submit 调用仍需保留
        const coordinated = await this._coordinator.submit(suggestion, {
          targetSystem: 'skill',
          priority: suggestion.priority || 'medium',
        });
        // Э첽ֱִбؽ
        // ЭǼ¼ͱͻִ
      } catch (e) {
        console.warn('[SkillEvolver] Эύʧܣؽ:', e.message);
      }
    }

    // ǰߣ֤ã
    let baseline = null;
    if (this._validator) {
      try {
        baseline = await this._validator.captureBaseline(skillName);
      } catch (e) {
        // ߲ʧֹܲ
      }
    }

    this._activeEvolutions++;

    try {
      let result = null;
      switch (suggestion.type) {
        case EvolutionType.FIX:
          result = await this._evolveFix(suggestion);
          break;
        case EvolutionType.DERIVED:
          result = await this._evolveDerived(suggestion);
          break;
        case EvolutionType.CAPTURED:
          result = await this._evolveCaptured(suggestion);
          break;
        default:
          console.warn(`[SkillEvolver] δ֪: ${suggestion.type}`);
      }

      if (result) {
        // ½
        this._evolutionCount.set(skillName, (this._evolutionCount.get(skillName) || 0) + 1);

        // ù۲
        this._setObservation(skillName);

        // ¼ʷ
        this._recordEvolution(result);

        // ֤֤ã
        if (this._validator && baseline) {
          try {
            const validation = await this._validator.validate(skillName, result, baseline);
            if (!validation.valid && validation.action === 'rollback') {
              console.warn(`[SkillEvolver] ֤ʧܣԶع: ${validation.reason}`);
              await this._rollbackEvolution(skillName, result);
              result.success = false;
              result.rollbackReason = validation.reason;
            }
          } catch (e) {
            console.warn('[SkillEvolver] ֤쳣:', e.message);
          }
        }
      }

      return result;
    } finally {
      this._activeEvolutions--;
    }
  }

  /**
   * ӦݴĽ֤ͨã
   *  staged Ĳļд뼼Ŀ¼
   */
  async applyStagedEvolution(skillName, stagedPath) {
    if (!fs.existsSync(stagedPath)) {
      console.error(`[SkillEvolver] ݴļ: ${stagedPath}`);
      return false;
    }

    const skillDir = this._findSkillDir(skillName);
    if (!skillDir) {
      console.error(`[SkillEvolver] ҲĿ¼: ${skillName}`);
      return false;
    }

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const stagedContent = fs.readFileSync(stagedPath, 'utf-8');

    // ֤
    const validation = this._validateSkillMd(stagedContent);
    if (!validation.valid) {
      console.error(`[SkillEvolver] ݴ油֤ʧܣܾӦ:`, validation.errors);
      return false;
    }

    // 浱ǰ汾汾ʷ
    if (this._versionStore && fs.existsSync(skillMdPath)) {
      const originalContent = fs.readFileSync(skillMdPath, 'utf-8');
      await this._versionStore.saveVersion(skillName, originalContent, 'pre-apply-staged', {
        evolutionType: 'staged_apply',
      });
    }

    // Ӧ
    fs.writeFileSync(skillMdPath, stagedContent, 'utf-8');

    // ݴļ
    try { fs.unlinkSync(stagedPath); } catch (e) { console.warn('[skill-evolver] Failed to clean up staged file:', e.message); }

    // ù۲
    this._setObservation(skillName);

    console.log(`[SkillEvolver] ݴӦõ ${skillName}`);
    return true;
  }

  /**
   * FIX ޸/ʱļ
   * ԭ޸ SKILL.mdɰ汾汾ʷ
   */
  async _evolveFix(suggestion) {
    const skillName = suggestion.targetSkillIds[0];

    // ȡļ
    if (!acquireLock(skillName)) {
      console.warn(`[SkillEvolver] FIX: ${skillName} ѱ`);
      return null;
    }

    try {
      const skillDir = this._findSkillDir(skillName);

      if (!skillDir) {
        console.warn(`[SkillEvolver] FIX: ҲĿ¼ ${skillName}`);
        return null;
      }

      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) {
        console.warn(`[SkillEvolver] FIX: Ҳ SKILL.md ${skillName}`);
        return null;
      }

      const originalContent = fs.readFileSync(skillMdPath, 'utf-8');

      // 浱ǰ汾汾ʷ
      if (this._versionStore) {
        await this._versionStore.saveVersion(skillName, originalContent, 'pre-fix-backup', {
          evolutionType: 'fix',
          reason: suggestion.reason,
        });
      }

      // ޸
      const patchedContent = await this._generatePatch(originalContent, suggestion, 'fix');

      if (!patchedContent || patchedContent === originalContent) {
        console.log(`[SkillEvolver] FIX: ${skillName} ޸Ļɲʧ`);
        return null;
      }

      // Ӧò
      if (!this.config.dryRun) {
        // дǰ֤
        const validation = this._validateSkillMd(patchedContent);
        if (!validation.valid) {
          console.error(`[SkillEvolver] FIX: ${skillName} ֤ʧ:`, validation.errors);
          return null;
        }

        // ?? ȫſأ requireValidation=true  autoApply=false
        // ݴ棬ֱдļȴֶ֤ͨ apply
        if (this.config.requireValidation && !this.config.autoApply) {
          const stagingPath = path.join(EVOLUTION_DIR, '.staged', `${skillName}-${Date.now()}.md`);
          if (!fs.existsSync(path.dirname(stagingPath))) {
            fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
          }
          fs.writeFileSync(stagingPath, patchedContent, 'utf-8');
          console.log(`[SkillEvolver] FIX: ${skillName} ݴ棨ȴ֤ͨӦã: ${stagingPath}`);

          return new EvolutionRecord({
            skillName,
            type: EvolutionType.FIX,
            parentVersion: this._getContentHash(originalContent),
            newVersion: this._getContentHash(patchedContent),
            reason: suggestion.reason,
            changes: suggestion.suggestedChanges,
            success: true,
            staged: true,
            stagedPath: stagingPath,
          });
        }

        fs.writeFileSync(skillMdPath, patchedContent, 'utf-8');

        // дٴ֤ȷдɹ
        const writtenContent = fs.readFileSync(skillMdPath, 'utf-8');
        const postValidation = this._validateSkillMd(writtenContent);

        if (!postValidation.valid) {
          console.error(`[SkillEvolver] FIX: ${skillName} д֤ʧܣع:`, postValidation.errors);
          // عԭʼ
          fs.writeFileSync(skillMdPath, originalContent, 'utf-8');
          return null;
        }

        console.log(`[SkillEvolver] FIX: ${skillName} Ӧ޸`);
      } else {
        console.log(`[SkillEvolver] FIX (dry-run): ${skillName} Ӧ޸`);
      }

      return new EvolutionRecord({
        skillName,
        type: EvolutionType.FIX,
        parentVersion: this._getContentHash(originalContent),
        newVersion: this._getContentHash(patchedContent),
        reason: suggestion.reason,
        changes: suggestion.suggestedChanges,
        success: true,
      });
    } finally {
      releaseLock(skillName);
    }
  }

  /**
   * DERIVED мǿ
   * Ŀ¼޸ģԭֲܱ
   */
  async _evolveDerived(suggestion) {
    const parentName = suggestion.targetSkillIds[0];
    const parentDir = this._findSkillDir(parentName);

    if (!parentDir) {
      console.warn(`[SkillEvolver] DERIVED: Ҳ ${parentName}`);
      return null;
    }

    // 
    const derivedName = `${parentName}-enhanced`;
    const derivedDir = this._findSkillDir(derivedName) || path.join(path.dirname(parentDir), derivedName);

    // ƸĿ¼
    if (!fs.existsSync(derivedDir)) {
      fs.mkdirSync(derivedDir, { recursive: true });
    }

    const parentSkillMd = path.join(parentDir, 'SKILL.md');
    if (fs.existsSync(parentSkillMd)) {
      const originalContent = fs.readFileSync(parentSkillMd, 'utf-8');

      // ǿ
      const enhancedContent = await this._generatePatch(originalContent, suggestion, 'derived');

      if (enhancedContent && enhancedContent !== originalContent) {
        const finalContent = enhancedContent.replace(
          /^name:\s*.+$/m,
          `name: ${derivedName}`
        ).replace(
          /^# .+/m,
          `# ${derivedName}`
        );

        if (!this.config.dryRun) {
          fs.writeFileSync(path.join(derivedDir, 'SKILL.md'), finalContent, 'utf-8');
          console.log(`[SkillEvolver] DERIVED: ǿ ${derivedName}`);
        }
      }
    }

    // Ƹļ
    const filesToCopy = fs.readdirSync(parentDir).filter(f =>
      f !== 'SKILL.md' && f !== '.versions.json' && f !== '.observation.json'
    );
    for (const file of filesToCopy) {
      const src = path.join(parentDir, file);
      const dst = path.join(derivedDir, file);
      if (fs.statSync(src).isFile() && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    }

    // ȫɨ裺Ƿɴ
    const securityScan = scanSkillSecurity(derivedDir);
    if (securityScan.warnings.length > 0) {
      console.warn(`[SkillEvolver] DERIVED: ${derivedName} ȫɨ辯:`, securityScan.warnings);
    }
    if (!securityScan.safe) {
      console.error(`[SkillEvolver] DERIVED: ${derivedName} ȫɨʧ:`, securityScan.errors);
      // Ŀ¼
      fs.rmSync(derivedDir, { recursive: true, force: true });
      return null;
    }

    return new EvolutionRecord({
      skillName: derivedName,
      type: EvolutionType.DERIVED,
      parentVersion: parentName,
      newVersion: this._getContentHash(derivedName),
      reason: suggestion.reason,
      changes: suggestion.suggestedChanges,
      success: true,
    });
  }

  /**
   * CAPTURED ִвģʽ
   * ȫµļ
   */
  async _evolveCaptured(suggestion) {
    const skillName = suggestion.targetSkillIds[0] ||
      `captured-${Date.now().toString(36)}`;

    const skillDir = this._findSkillDir(skillName) || path.join(SKILLS_DIR, skillName);

    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    // ¼
    const skillContent = await this._generateNewSkill(skillName, suggestion);

    if (skillContent && !this.config.dryRun) {
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
      console.log(`[SkillEvolver] CAPTURED: ¼ ${skillName}`);
    }

    return new EvolutionRecord({
      skillName,
      type: EvolutionType.CAPTURED,
      parentVersion: null,
      newVersion: this._getContentHash(skillContent || ''),
      reason: suggestion.reason,
      changes: suggestion.suggestedChanges,
      success: true,
    });
  }

  /**
   * ʹ LLM ޸/ǿDelta Operations ģʽ
   * 
   * ο Hindsight  Delta Operations ƣ
   * - LLM ֻбreplace_section/append_section/insert_after/delete_section
   * - δе section 䣬LLM ޷
   * - ʧ  زԣݲ
   */
  async _generatePatch(originalContent, suggestion, evolutionType) {
    if (!this._llmClient) {
      return this._ruleBasedPatch(originalContent, suggestion, evolutionType);
    }

    try {
      // 1. ԭʼݽΪ section 
      const doc = this._parseStructuredDoc(originalContent);

      // 2.  LLM б
      const prompt = [
        `## ܽ (${evolutionType})  Delta Operations ģʽ`,
        ``,
        `¼ܽ ${evolutionType === 'fix' ? '޸' : 'ǿ'}`,
        ``,
        `### ԭ:`,
        suggestion.reason,
        ``,
        `### ޸:`,
        suggestion.suggestedChanges,
        ``,
        `### ǰܽṹ:`,
        doc.sections.map((s, i) => `[${i}] ${s.level} ${s.title} (${s.lineCount})`).join('\n'),
        ``,
        `### ǰ:`,
        '```markdown',
        originalContent,
        '```',
        ``,
        `### ʽҪ:`,
        `һ JSON бÿʽ£`,
        `{"op": "replace_section", "index": <section>, "content": "<>"}`,
        `{"op": "append_section", "index": <section>, "content": "<׷ӵsectionĩβ>"}`,
        `{"op": "insert_after", "index": <section>, "title": "<section>", "content": "<section>"}`,
        `{"op": "delete_section", "index": <section>}`,
        ``,
        `### :`,
        `1. ֻҪ޸ĵĲδἰ section ԭ`,
        `2. index Ӧ"ǰܽṹ"еı`,
        `3. content вҪظ section УϵͳԶӣ`,
        `4.  JSON 飬Ҫ markdown `,
        `5. Ҫκ޸ģ []`,
        `6. С޸ķΧֻıĵĲ`,
      ].join('\n');

      const response = await this._callLLM(prompt);
      if (!response) return this._ruleBasedPatch(originalContent, suggestion, evolutionType);

      // 3.  LLM Ĳб
      const operations = this._parseDeltaOperations(response);
      if (!operations || operations.length === 0) {
        console.log('[SkillEvolver] Delta Operations: Чԭݲ');
        return null;
      }

      // 4. Ӧòṹĵ
      const patchedContent = this._applyDeltaOperations(doc, operations);
      if (!patchedContent || patchedContent === originalContent) {
        console.log('[SkillEvolver] Delta Operations: Ӧúޱ仯');
        return null;
      }

      return patchedContent;
    } catch (e) {
      console.error('[SkillEvolver] Delta Operations ʧܣ򲹶:', e.message);
      return this._ruleBasedPatch(originalContent, suggestion, evolutionType);
    }
  }

  /**
   *  Markdown ĵΪṹ section 
   */
  _parseStructuredDoc(content) {
    const lines = content.split('\n');
    const frontmatterEnd = this._findFrontmatterEnd(lines);
    const frontmatter = frontmatterEnd > 0 ? lines.slice(0, frontmatterEnd + 1).join('\n') : '';
    const bodyStart = frontmatterEnd > 0 ? frontmatterEnd + 1 : 0;

    const sections = [];
    let currentSection = null;

    for (let i = bodyStart; i < lines.length; i++) {
      const headingMatch = lines[i].match(/^(#{1,4})\s+(.+)/);
      if (headingMatch) {
        if (currentSection) {
          currentSection.lines = lines.slice(currentSection.startLine, i);
          currentSection.lineCount = currentSection.lines.length;
        }
        currentSection = {
          index: sections.length,
          level: headingMatch[1],
          title: headingMatch[2],
          headingLine: lines[i],
          startLine: i,
          lines: [],
          lineCount: 0,
        };
        sections.push(currentSection);
      }
    }

    // ĩβ section
    if (currentSection) {
      currentSection.lines = lines.slice(currentSection.startLine);
      currentSection.lineCount = currentSection.lines.length;
    }

    return { frontmatter, sections, rawLines: lines, bodyStart };
  }

  _findFrontmatterEnd(lines) {
    if (lines[0] !== '---') return -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') return i;
    }
    return -1;
  }

  /**
   *  LLM  Delta Operations JSON
   */
  _parseDeltaOperations(response) {
    try {
      // ȡ JSON 
      let jsonStr = response.trim();

      // ȥ markdown 
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      // ȡһ [...] 
      const bracketStart = jsonStr.indexOf('[');
      const bracketEnd = jsonStr.lastIndexOf(']');
      if (bracketStart >= 0 && bracketEnd > bracketStart) {
        jsonStr = jsonStr.slice(bracketStart, bracketEnd + 1);
      }

      const ops = JSON.parse(jsonStr);
      if (!Array.isArray(ops)) return null;

      // ֤ʽ
      const validOps = ops.filter(op => {
        if (!op.op || typeof op.index !== 'number') return false;
        return ['replace_section', 'append_section', 'insert_after', 'delete_section'].includes(op.op);
      });

      return validOps.length > 0 ? validOps : null;
    } catch (e) {
      console.warn('[SkillEvolver] Delta Operations JSON ʧ:', e.message);
      return null;
    }
  }

  /**
   *  Delta Operations Ӧõṹĵ
   * δе section 
   */
  _applyDeltaOperations(doc, operations) {
    try {
      const { frontmatter, sections, rawLines, bodyStart } = doc;

      //  index 򣬴ӺǰӦãƫƣ
      const sortedOps = [...operations].sort((a, b) => b.index - a.index);

      // µ section б
      const newSections = sections.map(s => ({
        ...s,
        lines: [...s.lines],
      }));

      for (const op of sortedOps) {
        if (op.index < 0 || op.index > sections.length) {
          console.warn(`[SkillEvolver] Delta: index ${op.index} Խ磬`);
          continue;
        }

        switch (op.op) {
          case 'replace_section': {
            if (op.index >= newSections.length) continue;
            const section = newSections[op.index];
            const newContent = (op.content || '').trim();
            section.lines = [section.headingLine, '', ...newContent.split('\n')];
            section.lineCount = section.lines.length;
            break;
          }

          case 'append_section': {
            if (op.index >= newSections.length) continue;
            const section = newSections[op.index];
            const appendContent = (op.content || '').trim();
            section.lines = [...section.lines, '', ...appendContent.split('\n')];
            section.lineCount = section.lines.length;
            break;
          }

          case 'insert_after': {
            const title = op.title || '½';
            const level = op.index < sections.length ? sections[op.index].level : '##';
            const newContent = (op.content || '').trim();
            const newSection = {
              index: -1, // ±
              level,
              title,
              headingLine: `${level} ${title}`,
              lines: [`${level} ${title}`, '', ...newContent.split('\n')],
              lineCount: 0,
            };
            newSection.lineCount = newSection.lines.length;
            newSections.splice(op.index + 1, 0, newSection);
            break;
          }

          case 'delete_section': {
            if (op.index >= newSections.length) continue;
            // ɾΨһ section
            if (newSections.length <= 1) {
              console.warn('[SkillEvolver] Delta: ɾΨһ section');
              continue;
            }
            newSections.splice(op.index, 1);
            break;
          }
        }
      }

      // 
      const parts = [];
      if (frontmatter) {
        parts.push(frontmatter);
      }

      // frontmatter  body ֮п
      const bodyLines = [];
      for (const section of newSections) {
        bodyLines.push(...section.lines);
      }

      // ԭʼ frontmatter пУ
      if (rawLines[bodyStart] === '' && frontmatter) {
        parts.push('');
      }

      parts.push(bodyLines.join('\n'));

      return parts.join('\n');
    } catch (e) {
      console.error('[SkillEvolver] Delta Operations Ӧʧ:', e.message);
      return null; // زԣݲ
    }
  }

  /**
   * ĲɣLLM ʱĽ
   */
  _ruleBasedPatch(originalContent, suggestion, evolutionType) {
    let content = originalContent;

    if (evolutionType === 'fix') {
      // ޸/ǿ
      if (!content.includes('') && !content.includes('Error Handling')) {
        const errorSection = [
          '',
          '## ',
          '',
          '- ҪʧܣǷȷ',
          '- ʧʱûӺ',
          '- ؽΪգʾûѯ',
        ].join('\n');

        // һ ## ֮ǰ
        const lastSection = content.lastIndexOf('\n## ');
        if (lastSection > 0) {
          content = content.slice(0, lastSection) + errorSection + content.slice(lastSection);
        } else {
          content += errorSection;
        }
      }

      // ע
      if (!content.includes('ע') && !content.includes('Important Notes')) {
        content += [
          '',
          '## ע',
          '',
          `- ˼ִֹ⣬Զ޸뷴`,
        ].join('\n');
      }
    }

    if (evolutionType === 'derived') {
      // ǿݻӸ߼÷
      content += [
        '',
        '## ߼÷',
        '',
        '- ָ֧ӵʽ',
        '- ɽʹ',
        `- ǿ汾ԭŻ (${new Date().toLocaleDateString('zh-CN')})`,
      ].join('\n');
    }

    return content !== originalContent ? content : null;
  }

  /**
   * ʹ LLM ¼
   */
  async _generateNewSkill(skillName, suggestion) {
    const defaultContent = [
      '---',
      `name: ${skillName}`,
      `description: ${suggestion.reason || 'Զļ'}`,
      'version: 1.0.0',
      'author: crabpaw-evolver',
      '---',
      '',
      `# ${skillName}`,
      '',
      `## `,
      '',
      suggestion.reason || '˼ִܴģʽԶɡ',
      '',
      `## `,
      '',
      suggestion.suggestedChanges || '1. ִҪ',
      '',
      `## ֤`,
      '',
      '- Ƿ',
      '- ȷϽԤ',
      '',
      `## ע`,
      '',
      '- ˼ϵͳԶɣҪһŻ',
    ].join('\n');

    if (!this._llmClient) return defaultContent;

    try {
      const prompt = [
        `## ¼`,
        ``,
        `: ${skillName}`,
        `ԭ: ${suggestion.reason}`,
        `: ${suggestion.suggestedChanges}`,
        ``,
        `һ SKILL.md ļݣ YAML frontmatter  Markdown ġ`,
        `ʽҪ:`,
        `1.  --- ͷ YAML frontmattername, description, version`,
        `2.  # ͷı`,
        `3. Ĳ˵`,
        `4. ע`,
      ].join('\n');

      const response = await this._callLLM(prompt);
      if (!response) return defaultContent;

      const mdMatch = response.match(/```markdown\s*\n([\s\S]*?)\n```/);
      if (mdMatch) return mdMatch[1];

      if (response.includes('---') && response.includes('##')) {
        return response.trim();
      }

      return defaultContent;
    } catch {
      return defaultContent;
    }
  }

  async _callLLM(prompt) {
    if (!this._llmClient) return null;

    try {
      if (typeof this._llmClient.chat === 'function') {
        const result = await this._llmClient.chat({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4000,
        });
        // _createChatAdapter.chat() صѾ string (content)
        // string ֱӷأobject ȡ content
        if (typeof result === 'string') return result || null;
        return result?.content || result?.choices?.[0]?.message?.content || null;
      }

      if (typeof this._llmClient.complete === 'function') {
        return await this._llmClient.complete(prompt);
      }

      return null;
    } catch (e) {
      console.error('[SkillEvolver] LLM ʧ:', e.message);
      return null;
    }
  }

  _findSkillDir(skillName) {
    const dirs = [SKILLS_DIR, GLOBAL_SKILLS_DIR];
    for (const base of dirs) {
      const candidate = path.join(base, skillName);
      if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'SKILL.md'))) {
        return candidate;
      }
    }
    return null;
  }

  _getContentHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * ֤ SKILL.md ݸʽǷЧ
   * @returns { valid: boolean, errors: string[] }
   */
  _validateSkillMd(content) {
    const errors = [];

    // ǷΪ
    if (!content || content.trim().length === 0) {
      errors.push('Ϊ');
      return { valid: false, errors };
    }

    //  YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      errors.push('ȱ YAML frontmatter (---)');
      return { valid: false, errors };
    }

    const frontmatter = frontmatterMatch[1];

    // Ҫֶ
    const requiredFields = ['name', 'description'];
    for (const field of requiredFields) {
      const fieldRegex = new RegExp(`^${field}:\\s*.+$`, 'm');
      if (!fieldRegex.test(frontmatter)) {
        errors.push(`frontmatter ȱٱҪֶ: ${field}`);
      }
    }

    //  Markdown ṹ
    const bodyContent = content.slice(frontmatterMatch[0].length).trim();
    if (bodyContent.length === 0) {
      errors.push('Markdown Ϊ');
    }

    // ǷδպϵĴ
    const codeBlockCount = (content.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      errors.push('δȷպ');
    }

    return { valid: errors.length === 0, errors };
  }

  _isInObservation(skillName) {
    const endTime = this._observations.get(skillName);
    if (!endTime) return false;
    if (Date.now() > endTime) {
      this._observations.delete(skillName);
      this._saveObservations();
      return false;
    }
    return true;
  }

  _setObservation(skillName) {
    this._observations.set(skillName, Date.now() + this.config.observationDurationMs);
    this._saveObservations();
  }

  _recordEvolution(record) {
    this._history.push(record);
    if (this._history.length > MAX_EVOLUTION_HISTORY) {
      this._history = this._history.slice(-MAX_EVOLUTION_HISTORY);
    }
    this._saveHistory();
  }

  /**
   * عӰ汾ʷָ
   */
  async _rollbackEvolution(skillName, evolutionRecord) {
    if (!this._versionStore) {
      console.warn(`[SkillEvolver] ޷ع ${skillName}: ް汾洢`);
      return false;
    }

    try {
      const versions = this._versionStore.getVersions(skillName);
      // ҵǰİ汾
      const preVersion = versions.find(v => v.hash === evolutionRecord.parentVersion);
      if (preVersion && preVersion.content) {
        const skillDir = this._findSkillDir(skillName);
        if (skillDir) {
          const skillMdPath = path.join(skillDir, 'SKILL.md');
          fs.writeFileSync(skillMdPath, preVersion.content, 'utf-8');
          console.log(`[SkillEvolver] ѻع ${skillName} ǰ汾`);
          return true;
        }
      }
      console.warn(`[SkillEvolver] ޷ع ${skillName}: Ҳǰ汾`);
      return false;
    } catch (e) {
      console.error(`[SkillEvolver] عʧ ${skillName}:`, e.message);
      return false;
    }
  }

  _rebuildEvolutionCount() {
    this._evolutionCount.clear();
    for (const record of this._history) {
      this._evolutionCount.set(
        record.skillName,
        (this._evolutionCount.get(record.skillName) || 0) + 1
      );
    }
  }

  _loadHistory() {
    try {
      if (fs.existsSync(EVOLUTION_HISTORY_FILE)) {
        this._history = JSON.parse(fs.readFileSync(EVOLUTION_HISTORY_FILE, 'utf-8'));
      }
    } catch {
      this._history = [];
    }
  }

  _saveHistory() {
    try {
      if (!fs.existsSync(EVOLUTION_DIR)) {
        fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
      }
      fs.writeFileSync(EVOLUTION_HISTORY_FILE, JSON.stringify(this._history, null, 2), 'utf-8');
    } catch (e) {
      console.error('[SkillEvolver] ʷʧ:', e.message);
    }
  }

  _loadObservations() {
    try {
      if (fs.existsSync(OBSERVATION_FILE)) {
        const data = JSON.parse(fs.readFileSync(OBSERVATION_FILE, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this._observations.set(k, v);
        }
      }
    } catch (e) {
      console.warn('[skill-evolver] Failed to load observations:', e.message);
    }
  }

  _saveObservations() {
    try {
      if (!fs.existsSync(EVOLUTION_DIR)) {
        fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
      }
      const obj = {};
      for (const [k, v] of this._observations) {
        obj[k] = v;
      }
      fs.writeFileSync(OBSERVATION_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (e) {
      console.error('[SkillEvolver] ۲ʧ:', e.message);
    }
  }

  /**
   * ȡʷ
   */
  getHistory(skillName, limit = 20) {
    if (skillName) {
      return this._history.filter(h => h.skillName === skillName).slice(-limit);
    }
    return this._history.slice(-limit);
  }

  /**
   * 2026-08-15 T7(累积K): 是否已初始化（server.js 启动序列注入 coordinator/validator 后为 true）。
   * 桥接方（evolution/index.js _bridgeSkillEvolution）据此决定走门禁单例还是直写 fallback。
   */
  isInitialized() {
    return !!this._initialized;
  }

  /**
   * ȡͳ
   */
  getStats() {
    const byType = { fix: 0, derived: 0, captured: 0 };
    const bySkill = {};

    for (const record of this._history) {
      byType[record.type] = (byType[record.type] || 0) + 1;
      bySkill[record.skillName] = (bySkill[record.skillName] || 0) + 1;
    }

    return {
      totalEvolutions: this._history.length,
      byType,
      bySkill,
      activeObservations: this._observations.size,
      activeEvolutions: this._activeEvolutions,
    };
  }

  shutdown() {
    this._saveHistory();
    this._saveObservations();
  }
}

// 
let _instance = null;

function getSkillEvolver() {
  if (!_instance) {
    _instance = new SkillEvolver();
  }
  return _instance;
}

module.exports = {
  // Backward-compatible exports, delegated to new evolution engine
  SkillEvolver,
  getSkillEvolver,
  EvolutionRecord,
};

// Re-export from new evolution engine
try {
  const evolutionExports = require('../evolution/skill-evolution');
  module.exports.getNewSkillEvolutionEngine = evolutionExports.getSkillEvolutionEngine;
  module.exports.SkillEvolutionEngine = evolutionExports.SkillEvolutionEngine;
} catch (e) {
  console.warn('[skill-evolver] Failed to re-export new evolution engine (circular dependency):', e.message);
}