'use strict';

const { EventEmitter } = require('events');

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_TOKEN_THRESHOLD_RATIO = 0.85;
const DEFAULT_MESSAGE_THRESHOLD = 50;
const DEFAULT_SESSION_AGE_TRIGGER_MS = 4 * 60 * 60 * 1000;

const DEFAULT_RECENT_MESSAGES = 10;
const DEFAULT_SYSTEM_BUDGET_RATIO = 0.20;
const DEFAULT_RECENT_BUDGET_RATIO = 0.30;
const DEFAULT_IMPORTANT_BUDGET_RATIO = 0.50;

const IMPORTANCE_WEIGHTS = {
  tool_result: 3.0,
  code_block: 2.5,
  decision_point: 2.0,
  tool_call: 1.8,
  error: 1.5,
  user_message: 1.3,
  assistant_message: 1.0,
  system_message: 0.5,
};

const URGENCY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

const PHASE = {
  NONE: 0,
  PRE_COMPACTION: 1,
  FULL_COMPACTION: 2,
};

class CompactionPlanner extends EventEmitter {
  constructor(config = {}) {
    super();
    this._contextWindow = config.contextWindow || DEFAULT_CONTEXT_WINDOW;
    this._tokenThreshold = config.tokenThreshold || Math.floor(
      DEFAULT_CONTEXT_WINDOW * DEFAULT_TOKEN_THRESHOLD_RATIO
    );
    this._messageThreshold = config.messageThreshold || DEFAULT_MESSAGE_THRESHOLD;
    this._sessionAgeTriggerMs = config.sessionAgeTriggerMs || DEFAULT_SESSION_AGE_TRIGGER_MS;
    this._tokenEstimator = config.tokenEstimator || null;
  }

  shouldCompact(context) {
    const {
      tokenCount = 0,
      messageCount = 0,
      sessionAgeMs = 0,
      lastCompactedAt = null,
    } = context || {};

    const reasons = [];
    let phase = PHASE.NONE;
    let urgency = URGENCY_LEVELS.LOW;

    const tokenRatio = tokenCount / this._contextWindow;

    if (tokenCount >= this._tokenThreshold) {
      reasons.push(`token_threshold_exceeded:${tokenCount}/${this._tokenThreshold}`);
      phase = PHASE.FULL_COMPACTION;
      urgency = this._assessUrgency(tokenRatio);
    } else if (tokenCount >= this._tokenThreshold * 0.85) {
      reasons.push(`token_near_threshold:${tokenCount}/${this._tokenThreshold}`);
      if (phase < PHASE.PRE_COMPACTION) phase = PHASE.PRE_COMPACTION;
      if (urgency === URGENCY_LEVELS.LOW) urgency = URGENCY_LEVELS.MEDIUM;
    }

    if (messageCount >= this._messageThreshold) {
      reasons.push(`message_threshold_exceeded:${messageCount}/${this._messageThreshold}`);
      if (phase < PHASE.PRE_COMPACTION) phase = PHASE.PRE_COMPACTION;
    }

    if (sessionAgeMs >= this._sessionAgeTriggerMs) {
      reasons.push(`session_age_exceeded:${Math.round(sessionAgeMs / 3600000)}h`);
      if (phase < PHASE.PRE_COMPACTION) phase = PHASE.PRE_COMPACTION;
    }

    if (lastCompactedAt) {
      const elapsed = Date.now() - new Date(lastCompactedAt).getTime();
      if (elapsed < 5 * 60 * 1000 && phase !== PHASE.NONE) {
        reasons.push('recent_compaction_cooldown');
        phase = Math.max(PHASE.NONE, phase - 1);
      }
    }

    const needed = phase !== PHASE.NONE;

    this.emit('compaction_assessed', {
      needed,
      phase,
      urgency,
      reasons,
      tokenCount,
      messageCount,
      sessionAgeMs,
    });

    return {
      needed,
      phase,
      reason: reasons.length > 0 ? reasons.join('; ') : 'none',
      urgency,
    };
  }

  // eslint-disable-next-line no-unused-vars
  planCompaction(messages, contextWindow) {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const plan = {
      keep: [],
      summarize: [],
      drop: [],
      systemMessages,
      estimatedTokens: 0,
      budgetAllocation: {
        system: 0,
        recent: 0,
        important: 0,
        summary: 0,
      },
    };

    const systemTokens = this._estimateTokens(systemMessages);
    plan.budgetAllocation.system = systemTokens;
    plan.estimatedTokens += systemTokens;

    const recentCount = Math.min(DEFAULT_RECENT_MESSAGES, nonSystemMessages.length);
    const recentMessages = nonSystemMessages.slice(-recentCount);
    const olderMessages = nonSystemMessages.slice(0, -recentCount);

    const recentTokens = this._estimateTokens(recentMessages);
    plan.keep.push(...recentMessages);
    plan.budgetAllocation.recent = recentTokens;
    plan.estimatedTokens += recentTokens;

    const importantMessages = [];
    const otherMessages = [];

    for (const msg of olderMessages) {
      const score = this._computeImportanceScore(msg);
      if (score >= 1.5) {
        importantMessages.push({ message: msg, score });
      } else {
        otherMessages.push(msg);
      }
    }

    importantMessages.sort((a, b) => b.score - a.score);
    const importantCount = Math.min(importantMessages.length, 15);
    const selectedImportant = importantMessages.slice(0, importantCount).map(x => x.message);

    plan.keep.push(...selectedImportant);
    plan.budgetAllocation.important = this._estimateTokens(selectedImportant);
    plan.estimatedTokens += plan.budgetAllocation.important;

    if (olderMessages.length > 0) {
      plan.summarize.push(...otherMessages);
      plan.summarize.push(
        ...importantMessages.slice(importantCount).map(x => x.message)
      );
      plan.budgetAllocation.summary = this._estimateTokens(plan.summarize);
    }

    return plan;
  }

  _assessUrgency(tokenRatio) {
    if (tokenRatio >= 0.95) return URGENCY_LEVELS.HIGH;
    if (tokenRatio >= 0.90) return URGENCY_LEVELS.MEDIUM;
    return URGENCY_LEVELS.LOW;
  }

  _computeImportanceScore(message) {
    if (!message || !message.content) return 0.5;

    let score = 0.5;
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content || '');

    if (message.role === 'tool') {
      score *= IMPORTANCE_WEIGHTS.tool_result;
    }

    if (message.role === 'tool_call') {
      score *= IMPORTANCE_WEIGHTS.tool_call;
    }

    if (content.includes('```') || /function|const |class |import |export /.test(content)) {
      score *= IMPORTANCE_WEIGHTS.code_block;
    }

    if (content.includes('错误') || content.includes('error') || content.includes('Error') ||
        content.includes('失败') || content.includes('failed')) {
      score *= IMPORTANCE_WEIGHTS.error;
    }

    if (/决定|决策|decided|decision|方案|strategy|approach/.test(content)) {
      score *= IMPORTANCE_WEIGHTS.decision_point;
    }

    if (message.role === 'user') {
      score *= IMPORTANCE_WEIGHTS.user_message;
    } else if (message.role === 'assistant') {
      score *= IMPORTANCE_WEIGHTS.assistant_message;
    } else if (message.role === 'system') {
      score *= IMPORTANCE_WEIGHTS.system_message;
    }

    if (message._toolResult) score *= 1.5;
    if (message._decisionPoint) score *= 1.3;

    return Math.min(score, 10.0);
  }

  _estimateTokens(messages) {
    if (!messages || messages.length === 0) return 0;
    if (this._tokenEstimator) {
      return this._tokenEstimator(messages);
    }
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
      total += Math.ceil(content.length / 4);
    }
    return total;
  }
}

class MessageTrimmer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._recentMessages = config.recentMessages || DEFAULT_RECENT_MESSAGES;
    this._systemBudgetRatio = config.systemBudgetRatio || DEFAULT_SYSTEM_BUDGET_RATIO;
    this._recentBudgetRatio = config.recentBudgetRatio || DEFAULT_RECENT_BUDGET_RATIO;
    this._importantBudgetRatio = config.importantBudgetRatio || DEFAULT_IMPORTANT_BUDGET_RATIO;
    this._tokenEstimator = config.tokenEstimator || null;
  }

  trim(messages, _contextWindow) {
    if (!messages || messages.length === 0) {
      return { messages: [], trimmedCount: 0, strategy: 'none' };
    }

    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= this._recentMessages) {
      return { messages, trimmedCount: 0, strategy: 'none' };
    }

    const recentMessages = nonSystemMessages.slice(-this._recentMessages);
    const olderMessages = nonSystemMessages.slice(0, -this._recentMessages);

    const scored = olderMessages.map(msg => ({
      message: msg,
      score: this._scoreMessage(msg),
    }));

    scored.sort((a, b) => b.score - a.score);

    const importantCount = Math.min(
      Math.ceil(olderMessages.length * 0.4),
      scored.length
    );
    const importantMessages = scored
      .slice(0, importantCount)
      .map(x => x.message);

    const importantSet = new Set(importantMessages.map(m => m._id || JSON.stringify(m)));
    const droppedMessages = olderMessages.filter(
      m => !importantSet.has(m._id || JSON.stringify(m))
    );

    const keptMessages = [...systemMessages, ...importantMessages, ...recentMessages];

    const originalTokens = this._estimateTokens(messages);
    const keptTokens = this._estimateTokens(keptMessages);

    const result = {
      messages: keptMessages,
      trimmedCount: messages.length - keptMessages.length,
      droppedCount: droppedMessages.length,
      strategy: 'smart_trim',
      originalTokens,
      keptTokens,
      budgetAllocation: {
        system: this._estimateTokens(systemMessages),
        recent: this._estimateTokens(recentMessages),
        important: this._estimateTokens(importantMessages),
      },
      droppedMessages,
    };

    this.emit('trimmed', {
      originalCount: messages.length,
      keptCount: keptMessages.length,
      trimmedCount: result.trimmedCount,
    });

    return result;
  }

  _scoreMessage(message) {
    if (!message) return 0;

    let score = 1.0;
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content || '');

    if (message.role === 'tool') score += 3.0;
    if (message.role === 'tool_call') score += 2.0;
    if (message.role === 'user') score += 1.0;
    if (message.role === 'assistant') score += 0.5;

    if (content.includes('```')) score += 2.0;
    if (/function|const |class |import |export |=>/.test(content)) score += 1.5;

    if (message._toolResult) score += 2.0;
    if (message._decisionPoint) score += 1.5;
    if (message._important) score += 1.0;

    if (content.length > 500) score += 0.5;

    if (/错误|error|Error|失败|failed|异常|exception/i.test(content)) score += 1.0;

    if (/决定|决策|decided|decision|方案|strategy|结论/.test(content)) score += 1.0;

    return score;
  }

  _estimateTokens(messages) {
    if (!messages || messages.length === 0) return 0;
    if (this._tokenEstimator) return this._tokenEstimator(messages);
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
      total += Math.ceil(content.length / 4);
    }
    return total;
  }
}

class SummaryGenerator extends EventEmitter {
  constructor(config = {}) {
    super();
    this._llmFn = config.llmFn || null;
    this._maxSummaryTokens = config.maxSummaryTokens || 2000;
    this._chunkSize = config.chunkSize || 8;
    this._summaries = [];
    this._stats = {
      totalSummaries: 0,
      failedSummaries: 0,
      totalTokensSaved: 0,
    };
  }

  setLLMFn(fn) {
    this._llmFn = fn;
  }

  async generateSummaries(messages, opts = {}) {
    const llmFn = opts.llmFn || this._llmFn;
    const chunkSize = opts.chunkSize || this._chunkSize;

    if (!messages || messages.length === 0) {
      return { summaries: [], messages: [], tokensSaved: 0 };
    }

    if (!llmFn) {
      return {
        summaries: [],
        messages,
        tokensSaved: 0,
        reason: 'no_llm_fn',
      };
    }

    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= chunkSize) {
      return {
        summaries: [],
        messages,
        tokensSaved: 0,
        reason: 'insufficient_messages_for_summary',
      };
    }

    const chunks = this._splitIntoChunks(nonSystemMessages, chunkSize);
    const summaries = [];
    const summaryMessages = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk.length === 0) continue;

      const chunkStart = nonSystemMessages.indexOf(chunk[0]);
      const chunkEnd = nonSystemMessages.indexOf(chunk[chunk.length - 1]);

      try {
        const summary = await this._summarizeChunk(chunk, llmFn, chunkStart, chunkEnd);
        if (summary) {
          summaries.push(summary);
          summaryMessages.push({
            role: 'system',
            content: `[对话摘要] ${summary.summaryText}`,
            _compacted: true,
            _compactedFrom: chunk.length,
            _sectionStart: chunkStart,
            _sectionEnd: chunkEnd,
            _keyDecisions: summary.keyDecisions || [],
            _entities: summary.entities || [],
            _actionItems: summary.actionItems || [],
          });
          this._stats.totalSummaries++;
        } else {
          this._stats.failedSummaries++;
          summaryMessages.push(...chunk);
        }
      } catch (err) {
        this._stats.failedSummaries++;
        summaryMessages.push(...chunk);
        this.emit('summary_failed', { error: err.message, chunkIndex: i });
      }
    }

    const originalTokens = this._estimateTokens(messages);
    const finalMessages = [...systemMessages, ...summaryMessages];
    const compactedTokens = this._estimateTokens(finalMessages);
    const tokensSaved = Math.max(0, originalTokens - compactedTokens);

    this._stats.totalTokensSaved += tokensSaved;
    this._summaries.push(...summaries);

    this.emit('summaries_generated', {
      chunksProcessed: chunks.length,
      summariesCreated: summaries.length,
      tokensSaved,
    });

    return {
      summaries,
      messages: finalMessages,
      tokensSaved,
      originalTokens,
      compactedTokens,
    };
  }

  createSummaryStructure(sectionStart, sectionEnd, summaryText, extra = {}) {
    return {
      sectionStart,
      sectionEnd,
      summary: summaryText,
      keyDecisions: extra.keyDecisions || [],
      entities: extra.entities || [],
      actionItems: extra.actionItems || [],
      timestamp: extra.timestamp || new Date().toISOString(),
    };
  }

  _splitIntoChunks(messages, chunkSize) {
    const chunks = [];
    for (let i = 0; i < messages.length; i += chunkSize) {
      chunks.push(messages.slice(i, i + chunkSize));
    }
    return chunks;
  }

  async _summarizeChunk(chunk, llmFn, chunkStart, chunkEnd) {
    const transcript = this._formatTranscript(chunk);

    const prompt = this._buildSummaryPrompt(transcript);

    try {
      const rawSummary = await llmFn(prompt, {
        maxTokens: this._maxSummaryTokens,
        temperature: 0.2,
      });

      if (!rawSummary || typeof rawSummary !== 'string' || rawSummary.trim().length === 0) {
        return null;
      }

      const parsed = this._parseSummary(rawSummary);

      return this.createSummaryStructure(
        chunkStart,
        chunkEnd,
        parsed.summaryText || rawSummary.trim(),
        {
          keyDecisions: parsed.keyDecisions,
          entities: parsed.entities,
          actionItems: parsed.actionItems,
        }
      );
    } catch (err) {
      return null;
    }
  }

  _buildSummaryPrompt(transcript) {
    return [
      '你是一个专业的对话摘要器。请将以下对话历史压缩为结构化摘要。',
      '',
      '要求：',
      '1. 保留关键决策、重要实体、待办事项',
      '2. 去除寒暄、冗余确认、重复内容',
      '3. 使用简洁的第三人称叙述',
      '4. 输出 JSON 格式',
      '',
      '对话内容：',
      transcript,
      '',
      '请输出以下 JSON 结构：',
      '{"summaryText": "简要摘要", "keyDecisions": ["决策1", "决策2"], "entities": ["实体1", "实体2"], "actionItems": ["待办1", "待办2"]}',
    ].join('\n');
  }

  _formatTranscript(messages) {
    return messages
      .map(msg => {
        const role = msg.role || 'unknown';
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content || '');
        const name = msg.name ? ` [${msg.name}]` : '';
        return `[${role}]${name}: ${content}`;
      })
      .join('\n---\n');
  }

  _parseSummary(rawSummary) {
    try {
      const jsonMatch = rawSummary.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summaryText: parsed.summaryText || rawSummary,
          keyDecisions: Array.isArray(parsed.keyDecisions) ? parsed.keyDecisions : [],
          entities: Array.isArray(parsed.entities) ? parsed.entities : [],
          actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        };
      }
    } catch (_) {

      // fallback to raw text

      console.warn('[two-phase-compaction.js] 空 catch 补日志:', _ && _.message);
    }


    return {
      summaryText: rawSummary.trim(),
      keyDecisions: [],
      entities: [],
      actionItems: [],
    };
  }

  _estimateTokens(messages) {
    if (!messages || messages.length === 0) return 0;
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
      total += Math.ceil(content.length / 4);
    }
    return total;
  }

  getStats() {
    return { ...this._stats };
  }

  getSummaries() {
    return [...this._summaries];
  }

  clearSummaries() {
    this._summaries = [];
    this._stats = {
      totalSummaries: 0,
      failedSummaries: 0,
      totalTokensSaved: 0,
    };
  }
}

class CompactionEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this._contextWindow = config.contextWindow || DEFAULT_CONTEXT_WINDOW;
    this._planner = new CompactionPlanner({
      contextWindow: this._contextWindow,
      tokenThreshold: config.tokenThreshold,
      messageThreshold: config.messageThreshold,
      tokenEstimator: config.tokenEstimator,
      sessionAgeTriggerMs: config.sessionAgeTriggerMs,
    });
    this._trimmer = new MessageTrimmer({
      recentMessages: config.recentMessages,
      systemBudgetRatio: config.systemBudgetRatio,
      recentBudgetRatio: config.recentBudgetRatio,
      importantBudgetRatio: config.importantBudgetRatio,
      tokenEstimator: config.tokenEstimator,
    });
    this._generator = new SummaryGenerator({
      llmFn: config.llmFn,
      maxSummaryTokens: config.maxSummaryTokens,
      chunkSize: config.chunkSize,
    });
    this._stats = {
      totalCompactions: 0,
      preCompactions: 0,
      fullCompactions: 0,
      totalTokensSaved: 0,
      lastCompactedAt: null,
    };
  }

  get planner() { return this._planner; }
  get trimmer() { return this._trimmer; }
  get generator() { return this._generator; }

  setLLMFn(fn) {
    this._generator.setLLMFn(fn);
  }

  async compact(messages, context = {}) {
    if (!messages || messages.length === 0) {
      return this._createResult(messages, [], 0, 0);
    }

    const assessment = this._planner.shouldCompact(context);

    if (!assessment.needed) {
      return this._createResult(messages, [], 0, 0, {
        compacted: false,
        reason: 'not_needed',
        phase: PHASE.NONE,
      });
    }

    const originalTokens = this._estimateTokens(messages);

    if (assessment.phase === PHASE.PRE_COMPACTION) {
      return this._executePreCompaction(messages, assessment, originalTokens);
    }

    if (assessment.phase === PHASE.FULL_COMPACTION) {
      return this._executeFullCompaction(messages, assessment, originalTokens);
    }

    return this._createResult(messages, [], 0, originalTokens, {
      compacted: false,
      reason: 'unknown_phase',
      phase: assessment.phase,
    });
  }

  async _executePreCompaction(messages, assessment, originalTokens) {
    const trimmed = this._trimmer.trim(messages, this._contextWindow);

    this._stats.preCompactions++;
    this._stats.totalCompactions++;
    this._stats.lastCompactedAt = Date.now();

    const tokensSaved = originalTokens - trimmed.keptTokens;
    const compactionRatio = originalTokens > 0 ? tokensSaved / originalTokens : 0;

    this.emit('pre_compaction_completed', {
      originalCount: messages.length,
      keptCount: trimmed.messages.length,
      tokensSaved,
      urgency: assessment.urgency,
    });

    return {
      messages: trimmed.messages,
      summaries: [],
      tokensSaved,
      originalTokens,
      compactionRatio,
      compacted: true,
      phase: PHASE.PRE_COMPACTION,
      strategy: trimmed.strategy,
      droppedMessages: trimmed.droppedMessages,
      budgetAllocation: trimmed.budgetAllocation,
    };
  }

  async _executeFullCompaction(messages, assessment, originalTokens) {
    const plan = this._planner.planCompaction(messages, this._contextWindow);

    const systemMessages = plan.systemMessages;
    const keptMessages = plan.keep;
    const summarizeMessages = plan.summarize;

    let summariesResult = {
      summaries: [],
      messages: [],
      tokensSaved: 0,
    };

    if (summarizeMessages.length > 0 && this._generator._llmFn) {
      summariesResult = await this._generator.generateSummaries(summarizeMessages);
    }

    const finalMessages = [
      ...systemMessages,
      ...keptMessages,
      ...summariesResult.messages,
    ];

    this._stats.fullCompactions++;
    this._stats.totalCompactions++;
    this._stats.lastCompactedAt = Date.now();

    const finalTokens = this._estimateTokens(finalMessages);
    const tokensSaved = Math.max(0, originalTokens - finalTokens);
    this._stats.totalTokensSaved += tokensSaved;
    const compactionRatio = originalTokens > 0 ? tokensSaved / originalTokens : 0;

    this.emit('full_compaction_completed', {
      originalCount: messages.length,
      finalCount: finalMessages.length,
      tokensSaved,
      summaryCount: summariesResult.summaries.length,
      urgency: assessment.urgency,
      compactionRatio,
    });

    return {
      messages: finalMessages,
      summaries: summariesResult.summaries,
      tokensSaved,
      originalTokens,
      compactionRatio,
      compacted: true,
      phase: PHASE.FULL_COMPACTION,
      summaryMessages: finalMessages.filter(m => m._compacted),
    };
  }

  _createResult(messages, summaries, tokensSaved, originalTokens, extra = {}) {
    return {
      messages,
      summaries,
      tokensSaved,
      originalTokens,
      compactionRatio: originalTokens > 0 ? tokensSaved / originalTokens : 0,
      compacted: false,
      phase: PHASE.NONE,
      ...extra,
    };
  }

  _estimateTokens(messages) {
    if (!messages || messages.length === 0) return 0;
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
      total += Math.ceil(content.length / 4);
    }
    return total;
  }

  getStats() {
    return {
      ...this._stats,
      generatorStats: this._generator.getStats(),
    };
  }

  reset() {
    this._stats = {
      totalCompactions: 0,
      preCompactions: 0,
      fullCompactions: 0,
      totalTokensSaved: 0,
      lastCompactedAt: null,
    };
    this._generator.clearSummaries();
    this.emit('engine_reset');
  }
}

module.exports = {
  CompactionPlanner,
  CompactionEngine,
  MessageTrimmer,
  SummaryGenerator,
  PHASE,
  URGENCY_LEVELS,
};