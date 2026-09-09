/**
 * CommitmentTracker - 承诺跟踪系统
 *
 * - 从对话中自动提取用户承诺和待办事项
 * - 跟踪承诺状态（pending/sent/dismissed/snoozed/expired）
 * - 支持定时提醒和到期检查
 * - 去重机制防止重复跟踪
 *
 * 使用方式：
 *   const { getCommitmentTracker } = require('./commitment-tracker');
 *   const tracker = getCommitmentTracker();
 *   tracker.extractFromConversation(userText, assistantText, scope);
 *   const pending = tracker.getPendingCommitments(scope);
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// 类型定义
// ============================================================================

const COMMITMENT_KINDS = {
  EVENT_CHECK_IN: 'event_check_in',
  DEADLINE_CHECK: 'deadline_check',
  CARE_CHECK_IN: 'care_check_in',
  OPEN_LOOP: 'open_loop',
};

const COMMITMENT_STATUSES = {
  PENDING: 'pending',
  SENT: 'sent',
  DISMISSED: 'dismissed',
  SNOOZED: 'snoozed',
  EXPIRED: 'expired',
};

const COMMITMENT_SOURCES = {
  INFERRED: 'inferred_user_context',
  AGENT_PROMISE: 'agent_promise',
};

// ============================================================================
// 承诺提取模式
// ============================================================================

const COMMITMENT_PATTERNS = [
  // 时间相关承诺
  { pattern: /(?:我会|我将|我会在|我会在)\s*(.{2,40}?)\s*(之前|之前|之后|时|的时候|前)/i, kind: 'deadline_check', confidence: 0.8 },
  // 待办事项
  { pattern: /(?:待办|TODO|todo|需要|记得|别忘了|记住要|一定要)\s*(.{2,80})/i, kind: 'open_loop', confidence: 0.7 },
  // 跟进承诺
  { pattern: /(?:稍后|之后|回头|等下|待会|明天|下周|晚点)\s*(.{2,60}?)\s*(看看|检查|确认|跟进|处理|完成)/i, kind: 'event_check_in', confidence: 0.75 },
  // Agent 自身承诺
  { pattern: /(?:I'll|I will|let me|I'll make sure|I'll check|I'll follow up)\s+(.{2,80})/i, kind: 'agent_promise', confidence: 0.85 },
  // 关怀提醒
  { pattern: /(?:提醒我|别忘了|注意|小心|当心|确保)\s*(.{2,60})/i, kind: 'care_check_in', confidence: 0.7 },
];

// 去重键生成
function generateDedupeKey(kind, reason, scope) {
  const normalized = reason.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
  const scopeKey = scope ? `${scope.agentId || ''}:${scope.sessionKey || ''}` : '';
  return `${kind}:${scopeKey}:${normalized}`;
}

// 客套话/寒暄过滤：避免把智能体的客套话误识别为承诺
// 这些短语是智能体常用的友好表达，不是真正的承诺
const POLITE_PHRASE_PATTERNS = [
  /需要\s*(帮忙|帮助)?\s*的?[,，]?\s*(随时|直接|尽管)?\s*说/i,
  /需要\s*(我\s*)?(帮|帮忙|帮助|干|做)\s*[的么吗]?[,，。~～]?\s*(随时|直接|尽管)?\s*说/i,
  /需要\s*(我\s*)?(的话|的话)?[,，]?\s*(随时|直接|尽管)?\s*(找|联系|说)/i,
  /需要\s*(再|的话)?\s*(找我|联系我|说)/i,
  /有\s*(需要|问题|事|啥|什么)\s*(随时|直接|尽管)?\s*(说|找|联系)/i,
  /随时\s*(找我|联系我|说|问)/i,
  /注意\s*(休息|身体|健康|安全|保暖|饮食)/i,
  /保重\s*身体/i,
  /照顾好\s*自己/i,
  /别\s*(太|太)\s*(累|熬夜|辛苦)/i,
  /记得\s*(吃饭|休息|喝水|睡觉)/i,
  /晚安|早安|早上好|晚上好|好梦/i,
  /加油|努力|冲鸭|奥利给/i,
  /随时\s*(为你|为您)\s*(效劳|服务|解答)/i,
  /为你\s*(效劳|服务)/i,
  /啥\s*(都|都能)\s*(能\s*)?(办|干|做)/i,
  /都能\s*(办|干|做|帮)/i,
  /聊聊\s*(AI|趋势|技术|想法)/i,
  // v2 补充：遗漏的客套话/寒暄模式
  /回家\s*(好好)?\s*(睡|休息|躺)/i,
  /辛苦/i,
  /好好\s*(休息|睡|照顾)/i,
  /早安|午安|晚安/i,
  /明天见|回头见|下次聊|拜拜|再见|回头聊/i,
  /多\s*(休息|保重|喝水|注意|运动)/i,
  /没事|不客气|应该的|乐意/i,
  /慢走|路上小心|注意安全|一路平安/i,
  /睡\s*(一觉|个好觉|吧)/i,
  /有需要\s*(再)?\s*(找我|说|联系)/i,
  /开心|愉快|顺利|顺心/i,
  // v3: agent sign-off / polite closing with emoji
  /需要帮忙[的吗么呀哦]?\s*[？。、，]?\s*[🦀]\s*$/iu,
  /有什么\s*需要\s*[的吗么呀]?\s*[？！]?\s*[🦀]?\s*$/iu,
  // v3: agent self-referencing meta-talk about the loop / commitments
  /循环提醒|承诺提醒|承诺清理|记忆系统|清理掉.*不会再弹/i,
  /需要帮忙.*当成承诺|弹出来.*循环/i,
  // v3: agent promises about cleaning up
  /帮你清理|清理干净|一劳永逸.*不再|不会再弹了/i,
];

/**
 * 判断文本是否是客套话/寒暄，不应被识别为承诺
 * @param {string} text - 待检查的文本
 * @returns {boolean} true 表示是客套话，应跳过
 */
function isLikelyPolitePhrase(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  // 短文本（<30字）更可能是客套话
  if (trimmed.length > 80) return false;
  for (const pattern of POLITE_PHRASE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// ============================================================================
// CommitmentTracker 类
// ============================================================================

class CommitmentTracker {
  constructor(config = {}) {

    this.commitments = new Map();  // id -> CommitmentRecord
    this.config = {
      maxCommitments: config.maxCommitments || 500,
      defaultTtlMs: config.defaultTtlMs || 7 * 24 * 60 * 60 * 1000, // 7天
      persistPath: config.persistPath || null,
      autoPersist: config.autoPersist !== false,
    };
    this._nextId = 1;

    // 尝试从持久化存储恢复
    if (this.config.persistPath) {

      this._loadFromDisk();
    }
  }

  /** Alias for init() ? used by init.js orchestration layer */
  async initialize() {
    return this.init();
  }

  /**
   * 从对话中提取承诺
   * @param {string} userText - 用户消息
   * @param {string} assistantText - 助手消息
   * @param {Object} scope - 作用域 { agentId, sessionKey, channel }
   * @returns {Array<CommitmentRecord>} 新创建的承诺
   */
  extractFromConversation(userText, assistantText, scope = {}) {
    const newCommitments = [];
    const texts = [
      { text: userText, source: 'inferred_user_context' },
      { text: assistantText, source: 'agent_promise' },
    ];

    for (const { text, source } of texts) {
      if (!text || typeof text !== 'string') continue;

      // 客套话过滤：跳过明显的寒暄/客套话，不识别为承诺
      if (isLikelyPolitePhrase(text)) {
        continue;
      }

      for (const { pattern, kind, confidence } of COMMITMENT_PATTERNS) {
        const match = text.match(pattern);
        if (!match) continue;

        const reason = match[0].trim();
        // 二次过滤：对提取出的承诺内容也进行客套话检查
        if (isLikelyPolitePhrase(reason)) {
          continue;
        }
        const suggestedText = match[1] ? match[1].trim() : reason;
        const dedupeKey = generateDedupeKey(kind, reason, scope);

        // 去重检查
        const existing = Array.from(this.commitments.values()).find(
          c => c.dedupeKey === dedupeKey && c.status === 'pending'
        );
        if (existing) continue;

        // Fix C: 低置信度(<0.5)承诺1小时后自动过期，避免客套话永久驻留
        const effectiveTtlMs = confidence < 0.5
          ? 60 * 60 * 1000  // 1小时
          : this.config.defaultTtlMs;
        const now = Date.now();
        const record = {
          id: `commit_${this._nextId++}`,
          kind,
          sensitivity: 'routine',
          source,
          status: 'pending',
          reason,
          suggestedText,
          dedupeKey,
          confidence,
          dueWindow: {
            earliestMs: now,
            latestMs: now + effectiveTtlMs,
          },
          scope: { ...scope },
          createdAtMs: now,
          updatedAtMs: now,
          attempts: 0,
          injectCount: 0,  // Fix B: 注入次数追踪
        };

        this.commitments.set(record.id, record);
        newCommitments.push(record);

        // 容量限制
        if (this.commitments.size > this.config.maxCommitments) {
          this._evictOldest();
        }
      }
    }

    if (newCommitments.length > 0 && this.config.autoPersist) {
      this._persistToDisk();
    }

    return newCommitments;
  }

  /**
   * 获取待处理的承诺
   */

  /**
   * ????????????????????
   */
  init() {
    this._intervalId = setInterval(() => {
      this._cleanupExpired();
    }, 60000); // Check every minute
    this._started = true;
    this._initialized = true;
    return this;
  }

  /**
   * ????????
   */
  start() {
    if (this._started) return;
    this._started = true;
    if (this._intervalId) clearInterval(this._intervalId);
    this._intervalId = setInterval(() => this._cleanupExpired(), 60000);
  }

  /**
   * ????????
   */
  stop() {
    this._started = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  /**
   * ?????????
   */
  _cleanupExpired() {
    const now = Date.now();
    // eslint-disable-next-line no-unused-vars -- id 未使用，仅遍历 record
    for (const [id, record] of this.commitments) {
      if (record.status === 'pending' && record.expiresAt && record.expiresAt < now) {
        record.status = 'expired';
      }
    }
  }

  /**
   * ?????????????????
   */
  shutdown() {
    this.stop();
    if (this.config.autoPersist) {
      this._persistToDisk();
    }
  }

  getPendingCommitments(scope = {}) {
    const now = Date.now();
    return Array.from(this.commitments.values()).filter(c => {
      if (c.status !== 'pending') return false;
      if (scope.agentId && c.scope.agentId !== scope.agentId) return false;
      if (scope.sessionKey && c.scope.sessionKey !== scope.sessionKey) return false;
      // 检查是否已过期
      if (c.dueWindow.latestMs < now) {
        c.status = 'expired';
        c.expiredAtMs = now;
        c.updatedAtMs = now;
        return false;
      }
      return true;
    });
  }

  /**
   * 获取到期需要提醒的承诺
   */
  getDueCommitments(scope = {}) {
    const now = Date.now();
    return this.getPendingCommitments(scope).filter(c => {
      return c.dueWindow.earliestMs <= now;
    });
  }

  /**
   * 更新承诺状态
   */
  updateStatus(id, newStatus, extra = {}) {
    const record = this.commitments.get(id);
    if (!record) return null;

    record.status = newStatus;
    record.updatedAtMs = Date.now();

    if (newStatus === 'sent') {
      record.sentAtMs = Date.now();
      record.attempts += 1;
    } else if (newStatus === 'dismissed') {
      record.dismissedAtMs = Date.now();
    } else if (newStatus === 'snoozed') {
      record.snoozedUntilMs = extra.snoozeUntilMs || Date.now() + 60 * 60 * 1000;
    } else if (newStatus === 'expired') {
      record.expiredAtMs = Date.now();
    }

    if (this.config.autoPersist) {
      this._persistToDisk();
    }

    return record;
  }

  /**
   * 标记承诺已发送提醒
   */
  markSent(id) {
    return this.updateStatus(id, 'sent');
  }

  /**
   * 忽略承诺
   */
  dismiss(id) {
    return this.updateStatus(id, 'dismissed');
  }

  /**
   * 暂停提醒
   */
  snooze(id, durationMs = 3600000) {
    return this.updateStatus(id, 'snoozed', { snoozeUntilMs: Date.now() + durationMs });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const byStatus = {};
    const byKind = {};
    for (const record of this.commitments.values()) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      byKind[record.kind] = (byKind[record.kind] || 0) + 1;
    }
    return {
      total: this.commitments.size,
      byStatus,
      byKind,
    };
  }

  /**
   * 清理过期承诺
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, record] of this.commitments) {
      if (record.status === 'expired' || record.status === 'dismissed') {
        if (now - record.updatedAtMs > 24 * 60 * 60 * 1000) {
          this.commitments.delete(id);
          cleaned++;
        }
      }
    }
    if (cleaned > 0 && this.config.autoPersist) {
      this._persistToDisk();
    }
    return cleaned;
  }

  // 内部方法

  /**
   * 构建承诺提示文本，注入到对话上下文中
   * @param {string} userId
   * @returns {string}
   */
  buildCommitmentsPrompt(_userId) {
    // Fix B: 自动清理已注入超过3次的承诺（避免无限循环）
    const MAX_INJECT = 3;
    // eslint-disable-next-line no-unused-vars -- id 未使用，仅遍历 c
    for (const [id, c] of this.commitments) {
      if ((c.injectCount || 0) >= MAX_INJECT && c.status === "pending") {
        c.status = "dismissed";
        c.dismissedAtMs = Date.now();
        c.updatedAtMs = Date.now();
      }
    }

    const pending = this.getPendingCommitments()
      .filter(c => (c.injectCount || 0) < MAX_INJECT);
    const due = this.getDueCommitments()
      .filter(c => (c.injectCount || 0) < MAX_INJECT);
    if (pending.length === 0 && due.length === 0) return "";

    const parts = [];
    if (due.length > 0) {
      parts.push("【到期承诺提醒】");
      for (const c of due.slice(0, 5)) {
        c.injectCount = (c.injectCount || 0) + 1;
        parts.push(`- [${c.kind}] ${c.reason} (来源: ${c.source})`);
      }
    }
    if (pending.length > 0) {
      parts.push("【待处理承诺】");
      for (const c of pending.slice(0, 5)) {
        c.injectCount = (c.injectCount || 0) + 1;
        parts.push(`- [${c.kind}] ${c.reason} (来源: ${c.source})`);
      }
      if (pending.length > 5) {
        parts.push(`... 还有 ${pending.length - 5} 条待处理承诺`);
      }
    }
    return "\n\n" + parts.join("\n");
  }

  /**
   * 入队提取任务（兼容旧接口）
   * @param {Object} params
   */
  enqueueExtraction({ userText, assistantText, sessionId, channel }) {
    const newCommitments = this.extractFromConversation(userText, assistantText, {
      agentId: sessionId,
      channel,
    });
    if (newCommitments.length > 0 && this.config.autoPersist) {
      this._persistToDisk();
    }
    return newCommitments;
  }

  _evictOldest() {
    let oldest = null;
    for (const [id, record] of this.commitments) {
      if (!oldest || record.createdAtMs < oldest.createdAtMs) {
        oldest = { id, createdAtMs: record.createdAtMs };
      }
    }
    if (oldest) {
      this.commitments.delete(oldest.id);
    }
  }

  _persistToDisk() {
    if (!this.config.persistPath) return;
    try {
      const dir = path.dirname(this.config.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: 1,
        commitments: Array.from(this.commitments.values()),
        nextId: this._nextId,
      };
      fs.writeFileSync(this.config.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[CommitmentTracker] 持久化失败:', e.message);
    }
  }

  _loadFromDisk() {
    if (!this.config.persistPath) return;
    try {
      if (!fs.existsSync(this.config.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.config.persistPath, 'utf-8'));
      if (data.version === 1 && Array.isArray(data.commitments)) {
        for (const record of data.commitments) {
          this.commitments.set(record.id, record);
        }
        this._nextId = data.nextId || this.commitments.size + 1;
      }
    } catch (e) {
      console.warn('[CommitmentTracker] 加载失败:', e.message);
    }
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let _globalTracker = null;

function getCommitmentTracker(config) {
  if (!_globalTracker) {
    const defaultPath = path.join(
      process.env.CONFIG_DIR || require('../path-utils').CRABPAW_HOME,
      'commitments.json'
    );
    _globalTracker = new CommitmentTracker({
      persistPath: defaultPath,
      ...config,
    });
  }
  return _globalTracker;
}

function resetCommitmentTracker() {
  if (_globalTracker) {
    _globalTracker.commitments.clear();
  }
  _globalTracker = null;
}

// 兼容旧接口的全局实例
const globalCommitmentTracker = getCommitmentTracker();

module.exports = {
  CommitmentTracker,
  COMMITMENT_KINDS,
  COMMITMENT_STATUSES,
  COMMITMENT_SOURCES,
  getCommitmentTracker,
  resetCommitmentTracker,
  globalCommitmentTracker,
};
