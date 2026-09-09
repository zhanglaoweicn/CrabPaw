const { EventEmitter } = require('events');
const {
  // eslint-disable-next-line no-unused-vars
  estimateTokens,
  // eslint-disable-next-line no-unused-vars
  estimateMessagesTokens,
  // eslint-disable-next-line no-unused-vars
  summarizeToolResult,
  // eslint-disable-next-line no-unused-vars
  redactSensitiveText,
} = require('./compressor');
const { ContextForkStrategy, CONTEXT_LEVELS, FORK_STRATEGIES } = require('../agent/context-fork-strategy');
const { ResultSummarizer } = require('../agent/result-summarizer');
const { ContextSummarizer } = require('./summarizer');

const DEFAULT_TOOL_RESULT_BUDGET_BYTES = 20000;
const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;
const CLEARED_PLACEHOLDER = '[Old tool result content cleared]';





const SOFT_THRESHOLD_RATIO = 0.90;
const HARD_THRESHOLD_RATIO = 0.95;
const MAX_CONSECUTIVE_FAILURES = 3;

const CIRCUIT_BREAKER_RESET_MS = 300000; // 熔断5分钟后自动尝试恢复

const SESSION_MEMORY_MIN_TURNS = 5;
const SESSION_MEMORY_MIN_TOKENS = 10000;
const SESSION_MEMORY_MIN_TOOL_CALLS = 3;

class ContextGuard {
  constructor(config = {}) {
    this.contextWindow = config.contextWindow || 128000;
    this.softThreshold = config.softThreshold || Math.floor(this.contextWindow * SOFT_THRESHOLD_RATIO);
    this.hardThreshold = config.hardThreshold || Math.floor(this.contextWindow * HARD_THRESHOLD_RATIO);
    this.lastInputTokens = 0;
    this.lastOutputTokens = 0;
    this._consecutiveFailures = 0;
    this._circuitBreakerTripped = false;
    this._circuitBreakerTrippedAt = 0;
  }

  updateUsage(usage) {
    this.lastInputTokens = usage.input_tokens || usage.prompt_tokens || 0;
    this.lastOutputTokens = usage.output_tokens || usage.completion_tokens || 0;
  }

  get utilization() {
    if (this.contextWindow <= 0) return 0;
    return this.lastInputTokens / this.contextWindow;
  }

  get utilizationPct() {
    return Math.round(this.utilization * 100);
  }

  check() {
    if (this._circuitBreakerTripped) {
      // 熔断超时后自动尝试恢复
      if (Date.now() - this._circuitBreakerTrippedAt > CIRCUIT_BREAKER_RESET_MS) {
        this._circuitBreakerTripped = false;
        this._consecutiveFailures = 0;
      } else {
        return {
          status: 'exhausted',
          utilizationPct: this.utilizationPct,
          reason: 'Circuit breaker tripped: too many consecutive compression failures',
        };
      }
    }

    if (this.lastInputTokens >= this.hardThreshold) {
      return {
        status: 'exhausted',
        utilizationPct: this.utilizationPct,
        reason: `Input tokens ${this.lastInputTokens} >= hard threshold ${this.hardThreshold}`,
      };
    }

    if (this.lastInputTokens >= this.softThreshold) {
      return {
        status: 'compaction_needed',
        utilizationPct: this.utilizationPct,
      };
    }

    return { status: 'ok', utilizationPct: this.utilizationPct };
  }

  recordCompactionSuccess() {
    this._consecutiveFailures = 0;
    this._circuitBreakerTripped = false;
  }

  recordCompactionFailure() {
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this._circuitBreakerTripped = true;
      this._circuitBreakerTrippedAt = Date.now();
    }
  }
}

class MicrocompactStats {
  constructor() {
    this.envelopesCleared = 0;
    this.entriesCleared = 0;
    this.bytesFreed = 0;
  }
}

function applyToolResultBudget(messages, budgetBytes = DEFAULT_TOOL_RESULT_BUDGET_BYTES) {
  let totalBytes = 0;
  let truncated = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    const contentBytes = Buffer.byteLength(content, 'utf-8');

    if (contentBytes > budgetBytes) {
      const ratio = budgetBytes / contentBytes;
      const keepChars = Math.floor(content.length * ratio);
      messages[i] = {
        ...msg,
        content: content.slice(0, keepChars) + '\n...[truncated by budget]',
      };
      truncated++;
    }
    totalBytes += Math.min(contentBytes, budgetBytes);
  }

  return { totalBytes, truncated };
}

function microcompact(messages, keepRecent = DEFAULT_KEEP_RECENT_TOOL_RESULTS) {
  const stats = new MicrocompactStats();
  const toolResultIndices = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= keepRecent) return stats;

  const cut = toolResultIndices.length - keepRecent;
  const toClear = toolResultIndices.slice(0, cut);

  for (const idx of toClear) {
    const msg = messages[idx];
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content === CLEARED_PLACEHOLDER) continue;

    const oldLen = content.length;
    messages[idx] = { ...msg, content: CLEARED_PLACEHOLDER };
    stats.bytesFreed += Math.max(0, oldLen - CLEARED_PLACEHOLDER.length);
    stats.entriesCleared++;
    stats.envelopesCleared++;
  }

  return stats;
}

class SessionMemoryState {
  constructor() {
    this.currentTurn = 0;
    this.totalTokens = 0;
    this.totalToolCalls = 0;
    this.lastExtractionTurn = 0;
    this.lastExtractionTokens = 0;
  }

  recordUsage(tokens) {
    this.totalTokens += tokens;
  }

  tickTurn() {
    this.currentTurn++;
  }

  recordToolCalls(n) {
    this.totalToolCalls += n;
  }

  shouldExtract(config = {}) {
    const minTurns = config.minTurns || SESSION_MEMORY_MIN_TURNS;
    const minTokens = config.minTokens || SESSION_MEMORY_MIN_TOKENS;
    const minToolCalls = config.minToolCalls || SESSION_MEMORY_MIN_TOOL_CALLS;
    const turnsSinceLast = this.currentTurn - this.lastExtractionTurn;
    const tokensSinceLast = this.totalTokens - this.lastExtractionTokens;

    return (
      turnsSinceLast >= minTurns &&
      tokensSinceLast >= minTokens &&
      this.totalToolCalls >= minToolCalls
    );
  }

  markExtracted() {
    this.lastExtractionTurn = this.currentTurn;
    this.lastExtractionTokens = this.totalTokens;
  }
}

class ContextPipelineConfig {
  constructor(opts = {}) {
    this.contextWindow = opts.contextWindow || 128000;
    this.toolResultBudgetBytes = opts.toolResultBudgetBytes || DEFAULT_TOOL_RESULT_BUDGET_BYTES;
    this.microcompactKeepRecent = opts.microcompactKeepRecent || DEFAULT_KEEP_RECENT_TOOL_RESULTS;
    this.microcompactEnabled = opts.microcompactEnabled !== false;
    this.autocompactEnabled = opts.autocompactEnabled !== false;
    this.sessionMemoryEnabled = opts.sessionMemoryEnabled !== false;
    this.sessionMemory = {
      minTurns: opts.sessionMemoryMinTurns || SESSION_MEMORY_MIN_TURNS,
      minTokens: opts.sessionMemoryMinTokens || SESSION_MEMORY_MIN_TOKENS,
      minToolCalls: opts.sessionMemoryMinToolCalls || SESSION_MEMORY_MIN_TOOL_CALLS,
    };
    this.llmCompressFn = opts.llmCompressFn || null;
    this.maxSummaryTokens = opts.maxSummaryTokens || 2000;
  }
}

class ContextPipeline extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = new ContextPipelineConfig(config);
    this.guard = new ContextGuard({
      contextWindow: this.config.contextWindow,
    });
    this.sessionMemory = new SessionMemoryState();
    this._compressor = null;
    this._forkStrategy = new ContextForkStrategy();
    this._resultSummarizer = new ResultSummarizer();
    this._summarizer = new ContextSummarizer({
      keepRecent: this.config.microcompactKeepRecent + 5,
      maxSummaryTokens: this.config.maxSummaryTokens,
    });
    this._stats = {
      budgetTruncations: 0,
      microcompactions: 0,
      autocompactions: 0,
      sessionMemoryExtractions: 0,
      totalBytesFreed: 0,
      contextForks: 0,
      resultSummaries: 0,
    };
  }

  get forkStrategy() {
    return this._forkStrategy;
  }

  get resultSummarizer() {
    return this._resultSummarizer;
  }

  forkContext(parentContext, targetAgent, options = {}) {
    this._stats.contextForks++;
    return this._forkStrategy.fork(parentContext, targetAgent, options);
  }

  mergeContext(childResults, parentContext, options = {}) {
    return this._forkStrategy.merge(childResults, parentContext, options);
  }

  summarizeResult(agentResult, options = {}) {
    this._stats.resultSummaries++;
    return this._resultSummarizer.summarize(agentResult, options);
  }

  summarizeFlowResults(flowResults, options = {}) {
    return this._resultSummarizer.summarizeFlowResults(flowResults, options);
  }

  setCompressor(compressor) {
    this._compressor = compressor;
  }

  setLLMCompressFn(fn) {
    this.config.llmCompressFn = fn;
    this._summarizer.setLLMFn(fn);
  }

  recordUsage(usage) {
    this.guard.updateUsage(usage);
    const total = (usage.input_tokens || usage.prompt_tokens || 0) +
                  (usage.output_tokens || usage.completion_tokens || 0);
    this.sessionMemory.recordUsage(total);
  }

  tickTurn() {
    this.sessionMemory.tickTurn();
  }

  recordToolCalls(n) {
    this.sessionMemory.recordToolCalls(n);
  }

  shouldExtractSessionMemory() {
    return this.sessionMemory.shouldExtract(this.config.sessionMemory);
  }

  runBeforeCall(messages) {
    const check = this.guard.check();

    if (check.status === 'ok') {
      return { outcome: 'noop', utilizationPct: check.utilizationPct };
    }

    if (check.status === 'exhausted') {
      this.guard.recordCompactionFailure();
      return {
        outcome: 'exhausted',
        utilizationPct: check.utilizationPct,
        reason: check.reason,
      };
    }

    if (this.config.microcompactEnabled) {
      const stats = microcompact(messages, this.config.microcompactKeepRecent);
      if (stats.envelopesCleared > 0) {
        this.guard.recordCompactionSuccess();
        this._stats.microcompactions++;
        this._stats.totalBytesFreed += stats.bytesFreed;
        this.emit('microcompacted', stats);
        return {
          outcome: 'microcompacted',
          stats,
          utilizationPct: check.utilizationPct,
        };
      }
    }

    if (this.config.autocompactEnabled) {
      this._stats.autocompactions++;
      this.emit('autocompaction_requested', {
        utilizationPct: check.utilizationPct,
      });
      return {
        outcome: 'autocompaction_requested',
        utilizationPct: check.utilizationPct,
      };
    }

    return {
      outcome: 'autocompaction_disabled',
      utilizationPct: check.utilizationPct,
    };
  }

  // eslint-disable-next-line no-unused-vars
  async executeAutocompact(messages, opts = {}) {
    if (this._summarizer && this.config.llmCompressFn) {
      try {
        const result = await this._summarizer.summarize(messages, {
          keepRecent: this.config.microcompactKeepRecent + 5,
          llmFn: this.config.llmCompressFn,
        });
        if (result.compressed) {
          this.guard.recordCompactionSuccess();
          this.emit('autocompacted', {
            originalCount: result.stats.messagesRemoved,
            compressedTo: 1,
            tokensFreed: result.stats.approxTokensFreed,
          });
          return { compressed: true, messages: result.messages, stats: result.stats };
        }
      } catch (e) {
        this.guard.recordCompactionFailure();
        this.emit('autocompaction_failed', { error: e.message });
      }
    }

    if (this.config.llmCompressFn) {
      const { head, middle, tail } = this._splitMessages(messages);
      if (middle.length === 0) {
        return { compressed: false, reason: 'no middle messages to compress' };
      }

      try {
        const summaryText = this._formatMiddleForSummary(middle);
        // P1-②(2026-09-03, dsh 机制⑦): 会话真前缀——原始 system 消息随 opts 下发
        const sessionSystem = messages.find((m) => m && m.role === 'system' && !m._summarizer) || null;
        const summary = await this.config.llmCompressFn(
          `请压缩以下对话历史，保留关键决策、技术细节和重要上下文，移除冗余内容:\n\n${summaryText}`,
          { maxTokens: this.config.maxSummaryTokens, systemMessage: sessionSystem ? sessionSystem.content : null }
        );

        if (summary) {
          const summaryMsg = {
            role: 'system',
            content: `[上下文摘要] ${summary}`,
          };
          const newMessages = [...head, summaryMsg, ...tail];
          this.guard.recordCompactionSuccess();
          this.emit('autocompacted', {
            originalCount: middle.length,
            compressedTo: 1,
          });
          return { compressed: true, messages: newMessages };
        }
      } catch (e) {
        this.guard.recordCompactionFailure();
        this.emit('autocompaction_failed', { error: e.message });
      }
    }

    if (this._compressor) {
      try {
        const result = this._compressor._pruneOldToolResults(messages);
        if (result.prunedCount > 0) {
          this.guard.recordCompactionSuccess();
          return { compressed: true, messages: result.messages };
        }
      } catch (e) {
        /* 忽略错误 */
        console.warn('[pipeline.js] 空 catch 补日志:', e && e.message);
      }

    }

    const fallbackMessages = messages.slice(0, 2).concat(messages.slice(-6));
    this.guard.recordCompactionFailure();
    return { compressed: true, messages: fallbackMessages, fallback: true };
  }

  _splitMessages(messages) {
    const protectFirst = 2;
    const protectLast = 6;
    if (messages.length <= protectFirst + protectLast) {
      return { head: messages, middle: [], tail: [] };
    }
    return {
      head: messages.slice(0, protectFirst),
      middle: messages.slice(protectFirst, -protectLast),
      tail: messages.slice(-protectLast),
    };
  }

  _formatMiddleForSummary(messages) {
    const parts = [];
    for (const msg of messages) {
      const role = msg.role || 'unknown';
      const content = typeof msg.content === 'string' ? msg.content : '';
      const preview = content.slice(0, 500);
      parts.push(`[${role}] ${preview}`);
    }
    return parts.join('\n');
  }

  getStats() {
    return {
      ...this._stats,
      guard: {
        utilizationPct: this.guard.utilizationPct,
        circuitBreakerTripped: this.guard._circuitBreakerTripped,
        consecutiveFailures: this.guard._consecutiveFailures,
      },
      sessionMemory: {
        currentTurn: this.sessionMemory.currentTurn,
        totalTokens: this.sessionMemory.totalTokens,
        totalToolCalls: this.sessionMemory.totalToolCalls,
      },
    };
  }
}

module.exports = {
  ContextPipeline,
  ContextPipelineConfig,
  ContextGuard,
  MicrocompactStats,
  SessionMemoryState,
  ContextSummarizer,
  applyToolResultBudget,
  microcompact,
  CLEARED_PLACEHOLDER,
  DEFAULT_TOOL_RESULT_BUDGET_BYTES,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  SOFT_THRESHOLD_RATIO,
  HARD_THRESHOLD_RATIO,
  ContextForkStrategy,
  CONTEXT_LEVELS,
  FORK_STRATEGIES,
  ResultSummarizer,
};
