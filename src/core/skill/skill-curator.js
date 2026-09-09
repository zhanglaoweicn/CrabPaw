/**
 * Skill Curator — 技能库定期维护管理器
 *
 * 定期（默认7天）启动一个后台审查，管理技能库的健康状态：
 *   1. 生命周期状态转移（active → stale → archived）
 *   2. 重叠技能检测和合并建议
 *   3. 生成维护报告
 *
 * 严格约束：
 *   - 仅操作 agent-created 技能（provenance: background_review）
 *   - 永不自动删除 → 只归档（archive 可恢复）
 *   - Pinned 技能跳过所有自动操作
 *   - 使用 aux client，不触碰主 session prompt cache
 *   - bundled 技能可归档但不可删除
 *
 * 触发条件：
 *   - 距上次运行 > intervalHours（默认168小时 = 7天）
 *   - Agent 空闲 > minIdleHours（默认2小时）
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars -- LIFECYCLE_STATES 从 require 解构但未使用
const { LIFECYCLE_STATES, SkillLifecycleManager } = require('./skill-lifecycle-state');

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  intervalHours: 24 * 7,     // 7 天
  minIdleHours: 2,            // 最小空闲
  staleAfterDays: 30,
  archiveAfterDays: 90,
  maxIterations: 100,         // Curator 可执行较多轮迭代
};

// ============================================================
// Curator
// ============================================================

class SkillCurator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {SkillLifecycleManager} */
    this._lifecycle = config.lifecycle || new SkillLifecycleManager(config);

    /** @type {object|null} LLM 客户端（aux client） */
    this._llmClient = null;

    /** @type {string|null} 数据目录 */
    this._dataDir = config.dataDir || null;

    /** 状态 */
    this._lastRunAt = null;
    this._lastRunDurationMs = 0;
    this._lastSummary = '';
    this._paused = false;
    this._runCount = 0;
    this._isRunning = false;

    this._initialized = false;
  }

  /**
   * 初始化
   */
  initialize(dataDir, llmClient = null) {
    if (this._initialized) return;

    this._dataDir = dataDir || this._dataDir || path.join(__dirname, '..', '..', 'data', '.crabpaw');

    // 确保数据目录存在
    const curatorDir = path.join(this._dataDir, 'curator');
    if (!fs.existsSync(curatorDir)) {
      fs.mkdirSync(curatorDir, { recursive: true });
    }

    // 初始化 Lifecycle
    const lifecyclePath = path.join(curatorDir, 'lifecycle.json');
    this._lifecycle.initialize(lifecyclePath);

    // 设置 LLM 客户端
    if (llmClient) this._llmClient = llmClient;

    // 加载状态
    this._loadState();

    this._initialized = true;
    this.emit('initialized');
    console.log('[SkillCurator] 初始化完成');
  }

  /**
   * 设置 LLM 客户端
   */
  setLLMClient(client) {
    this._llmClient = client;
  }

  // ============================================================
  // 核心入口
  // ============================================================

  /**
   * 判断是否应该运行
   * @param {number|null} idleSeconds - agent 空闲秒数
   */
  shouldRun(idleSeconds = null) {
    if (this._paused) return false;
    if (this._isRunning) return false;

    // 时间间隔检查
    if (this._lastRunAt) {
      const hoursSinceLast = (Date.now() - this._lastRunAt) / (1000 * 60 * 60);
      if (hoursSinceLast < this.config.intervalHours) return false;
    }

    // 空闲检查
    if (idleSeconds !== null) {
      const minIdleSeconds = this.config.minIdleHours * 3600;
      if (idleSeconds < minIdleSeconds) return false;
    }

    return true;
  }

  /**
   * 执行一次 Curator 审查（完整流程）
   * @returns {Promise<object>} 审查结果
   */
  async run() {
    if (this._isRunning) return null;
    this._isRunning = true;

    const startTime = Date.now();
    let result = {
      runAt: new Date().toISOString(),
      transitions: [],
      consolidations: [],
      summary: '',
      error: null,
    };

    try {
      // Step 1: 生命周期评估（纯规则引擎，不需要 LLM）
      const lifecycleResult = this._lifecycle.evaluate();
      result.transitions = lifecycleResult.transitions;

      // Step 2: 如果有 LLM 客户端，进行重叠技能检测和合并
      if (this._llmClient && typeof this._llmClient.chat === 'function') {
        try {
          const consolidationResult = await this._detectOverlaps();
          result.consolidations = consolidationResult;
        } catch (llmErr) {
          console.warn('[SkillCurator] LLM 合并检测失败:', llmErr.message);
        }
      }

      // Step 3: 生成摘要
      result.summary = this._buildSummary(result);

      // Step 4: 更新状态
      this._lastRunAt = Date.now();
      this._lastRunDurationMs = Date.now() - startTime;
      this._lastSummary = result.summary;
      this._runCount++;
      this._saveState();

      this.emit('run:complete', result);
      console.log(`[SkillCurator] 审查完成: ${result.summary} (${this._lastRunDurationMs}ms)`);

    } catch (err) {
      result.error = err.message;
      this.emit('run:error', err);
      console.error('[SkillCurator] 审查失败:', err.message);
    } finally {
      this._isRunning = false;
    }

    return result;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 检测重叠技能并生成合并建议
   * 使用 LLM 判断哪些技能功能重叠、应该合并为 umbrella
   */
  async _detectOverlaps() {
    const activeSkills = this._lifecycle.getActiveSkills();
    if (activeSkills.length < 3) return []; // 太少不需要检测

    // 构建技能列表 prompt
    const skillsList = activeSkills.map(name => {
      const record = this._lifecycle.getRecord(name);
      return `- ${name} (usage: ${record?.usageCount || 0}, last: ${record?.lastUsedAt || 'N/A'})`;
    }).join('\n');

    const prompt = `Review the following agent-created skills and identify overlapping ones that could be consolidated into umbrella skills.

Active skills:
${skillsList}

For each overlap you find, respond with a JSON array:
[{"skills": ["skill-a", "skill-b"], "suggestedUmbrella": "umbrella-name", "reason": "both handle X"}]

If no overlaps, respond with: []`;

    try {
      const response = await this._llmClient.chat({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const text = response?.choices?.[0]?.message?.content || response?.content || '[]';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.warn('[SkillCurator] 重叠检测 parse 失败:', err.message);
    }

    return [];
  }

  /** 构建摘要 */
  _buildSummary(result) {
    const parts = [];

    if (result.transitions.length > 0) {
      parts.push(`${result.transitions.length} skills transitioned`);
    }

    if (result.consolidations.length > 0) {
      parts.push(`${result.consolidations.length} overlaps found`);
    }

    if (parts.length === 0) {
      return 'No changes needed';
    }

    return parts.join('; ');
  }

  // ============================================================
  // 控制
  // ============================================================

  pause() {
    this._paused = true;
    this._saveState();
  }

  resume() {
    this._paused = false;
    this._saveState();
  }

  get isPaused() {
    return this._paused;
  }

  get isRunning() {
    return this._isRunning;
  }

  // ============================================================
  // 状态查询
  // ============================================================

  getStats() {
    return {
      ...this._lifecycle.getStats(),
      lastRunAt: this._lastRunAt ? new Date(this._lastRunAt).toISOString() : null,
      lastRunDurationMs: this._lastRunDurationMs,
      lastSummary: this._lastSummary,
      paused: this._paused,
      runCount: this._runCount,
    };
  }

  // ============================================================
  // 持久化
  // ============================================================

  _statePath() {
    return path.join(this._dataDir, 'curator', 'state.json');
  }

  _loadState() {
    const file = this._statePath();
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        this._lastRunAt = data.lastRunAt || null;
        this._lastRunDurationMs = data.lastRunDurationMs || 0;
        this._lastSummary = data.lastSummary || '';
        this._paused = data.paused || false;
        this._runCount = data.runCount || 0;
      }
    } catch (err) {
      console.warn('[SkillCurator] 加载状态失败:', err.message);
    }
  }

  _saveState() {
    const file = this._statePath();
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        lastRunAt: this._lastRunAt,
        lastRunDurationMs: this._lastRunDurationMs,
        lastSummary: this._lastSummary,
        paused: this._paused,
        runCount: this._runCount,
        savedAt: new Date().toISOString(),
      };

      const tmpPath = file + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, file);
    } catch (err) {
      console.warn('[SkillCurator] 保存状态失败:', err.message);
    }
  }
}

// ============================================================
// 单例
// ============================================================

let _instance = null;

function getCurator(config = {}) {
  if (!_instance) {
    _instance = new SkillCurator(config);
  }
  return _instance;
}

module.exports = {
  SkillCurator,
  getCurator,
};
