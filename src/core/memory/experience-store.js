/**
 * ExperienceStore — 结构化经验卡片记忆
 * 受 SightFlow ExperienceCard 启发：过程性记忆的最小单元
 *
 * 卡片来源三种：agent_summary（LLM 从轨迹归纳）、human_takeover（人工纠正）、manual（手动录入）
 * 运行时把启用的卡片注入 Provider prompt；每次注入后回复发送成功即记一次 used/success。
 *
 * 存储：单一 JSON 文件 (<dataDir>/experience-cards.json)
 *
 * @module memory/experience-store
 */

const { randomUUID } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');

/** @typedef {'agent_summary'|'human_takeover'|'manual'} ExperienceCardSource */

/**
 * @typedef {Object} ExperienceCard
 * @property {string} cardId
 * @property {string} scenario   - 触发条件：什么情况下适用
 * @property {string} guidance   - 该怎么做
 * @property {string} rationale  - 为什么 —— 老员工的判断依据
 * @property {ExperienceCardSource} source
 * @property {{sessionId?: string, stepIds?: string[]}} evidence - 可回溯来源
 * @property {boolean} enabled
 * @property {{used: number, success: number}} stats - 使用频次
 * @property {number} createdAt
 */

/**
 * @typedef {Object} NewExperienceCard
 * @property {string} scenario
 * @property {string} guidance
 * @property {string} [rationale]
 * @property {ExperienceCardSource} source
 * @property {{sessionId?: string, stepIds?: string[]}} [evidence]
 */

class ExperienceStore {
  /**
   * @param {string} filePath - 卡片文件路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {ExperienceCard[]|null} */
    this._cards = null;
    /**
     * 回放经验池（P0 修复）——此前 ExperienceStore 无 addExperience/_experiences，
     * 回放引擎 typeof 守卫静默跳过：经验永不落盘、周期回放恒 no_data。
     * 按 id 索引的 Map，落盘到独立文件 <filePath>.experiences.json
     * （与卡片 JSON 数组分离，避免破坏 listCards 的数组格式契约）。
     * @type {Map<string, object>|null}
     */
    this._experiences = null;
    this._experiencesFilePath = filePath.replace(/\.json$/, "") + ".experiences.json";
  }

  /** @returns {ExperienceCard[]} */
  _load() {
    if (this._cards) return this._cards;
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        this._cards = JSON.parse(raw);
        if (!Array.isArray(this._cards)) this._cards = [];
      } else {
        this._cards = [];
      }
    } catch {
      this._cards = [];
    }
    return this._cards;
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath + '.tmp', JSON.stringify(this._cards || [], null, 2), 'utf-8');
      const { renameSync } = require('node:fs');
      renameSync(this.filePath + '.tmp', this.filePath);
    } catch (e) {
      console.warn('[ExperienceStore] 保存失败:', e.message);
    }
  }

  /** @returns {Map<string, object>} 延迟加载回放经验池 */
  _loadExperiences() {
    if (this._experiences) return this._experiences;
    try {
      if (existsSync(this._experiencesFilePath)) {
        const raw = readFileSync(this._experiencesFilePath, "utf-8");
        const arr = JSON.parse(raw);
        this._experiences = new Map(Array.isArray(arr) ? arr.map(e => [e.id, e]) : []);
      } else {
        this._experiences = new Map();
      }
    } catch (e) {
      console.warn("[ExperienceStore] 经验文件加载失败，使用空池:", e.message);
      this._experiences = new Map();
    }
    return this._experiences;
  }

  _saveExperiences() {
    try {
      const dir = path.dirname(this._experiencesFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const arr = this._experiences ? [...this._experiences.values()] : [];
      writeFileSync(this._experiencesFilePath + ".tmp", JSON.stringify(arr, null, 2), "utf-8");
      const { renameSync } = require("node:fs");
      renameSync(this._experiencesFilePath + ".tmp", this._experiencesFilePath);
    } catch (e) {
      console.warn("[ExperienceStore] 经验保存失败:", e.message);
    }
  }

  /**
   * 记录一条回放经验（P0：此前该方法不存在，回放引擎 typeof 守卫静默跳过）
   * 与 addCards 同风格：入池 + 持久化。
   * @param {object} exp - { id, type, outcome, task, approach, result, errorMessage, tags, toolsUsed, createdAt, source, context }
   * @returns {object} 归一化后的经验条目
   */
  addExperience(exp) {
    const map = this._loadExperiences();
    const id = exp.id || `exp_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const entry = {
      id,
      type: exp.type || "outcome",
      outcome: exp.outcome || (exp.success === false ? "failure" : "success"),
      task: exp.task || exp.summary || "",
      approach: exp.approach || "",
      result: exp.result || exp.summary || "",
      errorMessage: exp.errorMessage || "",
      tags: exp.tags || [],
      toolsUsed: exp.toolsUsed || exp.tools || [],
      source: exp.source || "unknown",
      context: exp.context || {},
      createdAt: exp.createdAt || exp.timestamp || Date.now(),
    };
    map.set(id, entry);
    this._saveExperiences();
    return entry;
  }

  /** @returns {object[]} 全部经验（按时间倒序） */
  listExperiences() {
    return [...this._loadExperiences().values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** @returns {ExperienceCard[]} 按时间倒序 */
  listCards() {
    return [...this._load()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** @returns {ExperienceCard[]} 已启用的卡片 */
  getActiveCards() {
    return this._load().filter(card => card.enabled);
  }

  /**
   * 获取注入 Prompt 的卡片摘要列表
   * @returns {import('../work-trace/trace-types').MemoryCardBrief[]}
   */
  getActiveCardBriefs() {
    return this.getActiveCards().map(card => ({
      cardId: card.cardId,
      scenario: card.scenario,
      guidance: card.guidance,
      rationale: card.rationale || undefined,
    }));
  }

  /**
   * 批量添加卡片
   * @param {NewExperienceCard[]} inputs
   * @returns {ExperienceCard[]}
   */
  addCards(inputs) {
    const cards = this._load();
    const now = Date.now();
    const created = [];
    for (const input of inputs) {
      const card = {
        cardId: randomUUID(),
        scenario: input.scenario,
        guidance: input.guidance,
        rationale: input.rationale || '',
        source: input.source,
        evidence: input.evidence || {},
        enabled: true,
        stats: { used: 0, success: 0 },
        createdAt: now,
      };
      cards.push(card);
      created.push(card);
    }
    this._save();
    return created;
  }

  /**
   * 更新卡片
   * @param {string} cardId
   * @param {Partial<ExperienceCard>} updates
   */
  updateCard(cardId, updates) {
    const cards = this._load();
    const idx = cards.findIndex(c => c.cardId === cardId);
    if (idx === -1) return null;
    Object.assign(cards[idx], updates);
    this._save();
    return cards[idx];
  }

  /**
   * 删除卡片
   * @param {string} cardId
   */
  removeCard(cardId) {
    const cards = this._load();
    const idx = cards.findIndex(c => c.cardId === cardId);
    if (idx === -1) return false;
    cards.splice(idx, 1);
    this._save();
    return true;
  }

  /**
   * 记录使用反馈
   * @param {string} cardId
   * @param {boolean} success
   */
  recordUsage(cardId, success) {
    const cards = this._load();
    const card = cards.find(c => c.cardId === cardId);
    if (!card) return;
    card.stats.used++;
    if (success) card.stats.success++;
    this._save();
  }

  /** @returns {{total: number, enabled: number, totalUsed: number}} */
  stats() {
    const cards = this._load();
    return {
      total: cards.length,
      enabled: cards.filter(c => c.enabled).length,
      totalUsed: cards.reduce((s, c) => s + c.stats.used, 0),
    };
  }

  /** 重新加载 */
  reload() { this._cards = null; return this._load(); }
}

/**
 * Experience kinds for the feedback/reflection system.
 */
const EXPERIENCE_KINDS = {
  FAILURE: 'failure',
  PATTERN: 'pattern',
  OUTCOME: 'outcome',
  PROCEDURE: 'procedure',
};

/**
 * Outcome classes for the feedback/reflection system.
 */
const OUTCOME_CLASSES = {
  FAILURE: 'failure',
  PARTIAL: 'partial',
  SUCCESS: 'success',
};

/**
 * AgentExperience — a simple data class for feedback/reflection experiences.
 * Used by feedback-loop.js to persist reflection results into the experience store.
 */
class AgentExperience {
  constructor(data = {}) {
    this.id = data.id || `exp_${Date.now()}_${(Math.random().toString(36).slice(2, 8))}`;
    this.kind = data.kind || EXPERIENCE_KINDS.OUTCOME;
    this.outcome = data.outcome || OUTCOME_CLASSES.PARTIAL;
    this.task = data.task || '';
    this.approach = data.approach || '';
    this.result = data.result || '';
    this.errorMessage = data.errorMessage || '';
    this.tags = data.tags || [];
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = Date.now();
  }
}

module.exports = { ExperienceStore, AgentExperience, EXPERIENCE_KINDS, OUTCOME_CLASSES };
