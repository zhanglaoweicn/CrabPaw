/**
 * Instinct System — 直觉规则系统
 *
 * 参考 ECC session-start.js 的 instinct 注入机制：
 * - 从历史会话中提取高置信度行为规则
 * - 置信度阈值过滤（> 0.7）
 * - 数量限制（最多 6 条）
 * - 每条摘要 < 220 字符
 *
 * Instinct 与 Memory 的区别：
 * - Memory: 事实性知识（用户偏好、项目信息）
 * - Instinct: 行为性规则（"用户喜欢简洁回答"、"避免使用 eval"）
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const INSTINCTS_FILE = path.join(DATA_DIR, 'instincts.json');
const CONFIDENCE_THRESHOLD = 0.7;
const MAX_INJECTED_INSTINCTS = 6;
const MAX_INSTINCT_LENGTH = 220;

class InstinctSystem {
  constructor(config = {}) {
    this.confidenceThreshold = config.confidenceThreshold || CONFIDENCE_THRESHOLD;
    this.maxInjected = config.maxInjected || MAX_INJECTED_INSTINCTS;
    this.maxLength = config.maxLength || MAX_INSTINCT_LENGTH;
    this._instincts = [];
    this._loaded = false;
  }

  /**
   * 加载直觉规则
   */
  _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (fs.existsSync(INSTINCTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(INSTINCTS_FILE, 'utf8'));
        this._instincts = Array.isArray(data) ? data : [];
      }
    } catch {
      this._instincts = [];
    }
  }

  /**
   * 保存直觉规则
   */
  _save() {
    try {
      const dir = path.dirname(INSTINCTS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(INSTINCTS_FILE, JSON.stringify(this._instincts, null, 2), 'utf8');
    } catch (e) {
      /* 保存失败静默降级 */
      console.warn('[instinct-system.js] 空 catch 补日志:', e && e.message);
    }

  }

  /**
   * 从工具执行历史中学习直觉规则
   * 当某个模式重复出现时（如某工具总是失败、某参数组合总是成功），提取为规则
   * @param {string} pattern - 观察到的模式
   * @param {number} confidence - 置信度 0-1
   * @param {string} source - 来源（tool_usage/user_feedback/system_observation）
   */
  learn(pattern, confidence, source = 'system_observation') {
    this._load();

    // 检查是否已有相似规则
    const existing = this._instincts.find(i =>
      this._similarity(i.pattern, pattern) > 0.8
    );

    if (existing) {
      // 更新置信度（加权平均）
      existing.confidence = Math.min(1, existing.confidence * 0.7 + confidence * 0.3);
      existing.observationCount = (existing.observationCount || 1) + 1;
      existing.lastSeen = new Date().toISOString();
    } else {
      this._instincts.push({
        pattern: pattern.slice(0, this.maxLength),
        confidence,
        source,
        observationCount: 1,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });
    }

    this._save();
  }

  /**
   * 获取高置信度直觉规则，用于注入 prompt
   */
  getActiveInstincts() {
    this._load();

    return this._instincts
      .filter(i => i.confidence >= this.confidenceThreshold)
      .sort((a, b) => b.confidence - a.confidence || b.observationCount - a.observationCount)
      .slice(0, this.maxInjected)
      .map(i => ({
        rule: i.pattern,
        confidence: i.confidence,
        source: i.source,
      }));
  }

  /**
   * 生成注入到 volatile 层的 prompt 片段
   */
  buildInstinctPrompt() {
    const instincts = this.getActiveInstincts();
    if (instincts.length === 0) return '';

    const lines = [];
    lines.push('## 已学习的行为规则（Instincts）');
    lines.push('以下规则从历史交互中自动提取，置信度已验证。请遵循这些规则：');
    lines.push('');

    for (const inst of instincts) {
      const sourceTag = inst.source === 'user_feedback' ? '[用户反馈]' :
                        inst.source === 'tool_usage' ? '[工具经验]' : '[系统观察]';
      lines.push(`- ${sourceTag} ${inst.rule}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /**
   * 从工具执行结果自动学习
   * @param {string} toolName - 工具名
   * @param {boolean} success - 是否成功
   * @param {Object} meta - 额外信息
   */
  learnFromToolExecution(toolName, success, meta = {}) {
    // 连续失败的工具 → "避免使用 X 工具"
    if (!success && meta.consecutiveFailures >= 3) {
      this.learn(
        `工具 ${toolName} 连续失败 ${meta.consecutiveFailures} 次，优先使用替代方案`,
        Math.min(0.95, 0.5 + meta.consecutiveFailures * 0.1),
        'tool_usage'
      );
    }

    // 特定参数组合总是成功 → "使用 X 工具时推荐参数 Y"
    if (success && meta.paramHint && meta.consecutiveSuccesses >= 3) {
      this.learn(
        `使用 ${toolName} 时推荐: ${meta.paramHint}`,
        Math.min(0.9, 0.5 + meta.consecutiveSuccesses * 0.08),
        'tool_usage'
      );
    }
  }

  /**
   * 从用户反馈学习
   * @param {string} feedback - 用户反馈内容
   * @param {'positive'|'negative'} sentiment - 情感倾向
   */
  learnFromFeedback(feedback, sentiment) {
    const confidence = sentiment === 'negative' ? 0.85 : 0.75;
    this.learn(feedback.slice(0, this.maxLength), confidence, 'user_feedback');
  }

  /**
   * 获取所有直觉规则（管理用）
   */
  getAll() {
    this._load();
    return [...this._instincts];
  }

  /**
   * 删除直觉规则
   */
  remove(pattern) {
    this._load();
    const before = this._instincts.length;
    this._instincts = this._instincts.filter(i => i.pattern !== pattern);
    if (this._instincts.length < before) this._save();
    return this._instincts.length < before;
  }

  /**
   * 清理低置信度规则
   */
  prune() {
    this._load();
    const before = this._instincts.length;
    this._instincts = this._instincts.filter(i => i.confidence >= this.confidenceThreshold * 0.5);
    if (this._instincts.length < before) this._save();
    return before - this._instincts.length;
  }

  /**
   * 简单文本相似度（基于关键词重叠）
   */
  _similarity(a, b) {
    const tokensA = new Set(a.toLowerCase().split(/\s+/));
    const tokensB = new Set(b.toLowerCase().split(/\s+/));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.max(tokensA.size, tokensB.size);
  }
}

let _instance = null;
function getInstinctSystem() {
  if (!_instance) _instance = new InstinctSystem();
  return _instance;
}

module.exports = { InstinctSystem, getInstinctSystem };
