/**
 * DoomLoopDetector - 末日循环检测器
 *
 * 灵感来源于 Grok Build 的 doom loop detection 机制。
 * 用于在 AI Agent 陷入重复、无意义的循环时，通过多策略识别并触发流式中断 (mid-stream abortion)。
 *
 * 检测策略:
 *   1. 工具调用重复 (Tool Call Repetition)
 *   2. 工具循环 (Tool Cycle)
 *   3. 消息重复 (Message Repetition)
 *   4. 升级重试模式 (Escalation Pattern)
 *   5. 上下文饱和 (Context Saturation)
 *
 * 设计要点:
 *   - 每个检测策略独立产生置信度 (0~1)
 *   - 多个模式叠加时置信度快速累积
 *   - 超过阈值后进入告警态，持续高置信度触发 abort
 *   - 全部基于 Set/Map 实现以获得 O(1) 查找
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

const DEFAULT_CONFIG = Object.freeze({
  minOccurrences: 3,
  timeWindowMs: 30000,
  confidenceThreshold: 0.7,
  warningThreshold: 0.45,
  cycleMinLength: 2,
  cycleMaxLength: 8,
  messageSimilarityThreshold: 0.85,
  saturationTokenThreshold: 50000,
  saturationMinMessages: 6,
  maxTrackedMessages: 50,
  maxTrackedToolCalls: 200,
  abortCooldownMs: 8000,
});

function argsHash(args) {
  try {
    const serialized = args === undefined || args === null
      ? ''
      : typeof args === 'string'
        ? args
        : JSON.stringify(args);
    return crypto.createHash('sha1').update(serialized).digest('hex');
  } catch {
    return crypto.createHash('sha1').update(String(args)).digest('hex');
  }
}

function stableMessageHash(message) {
  if (typeof message !== 'string') return '';
  const normalized = message
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .slice(0, 2000);
  if (!normalized) return '';
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1],
          matrix[i][j - 1],
          matrix[i - 1][j - 1],
        ) + 1;
      }
    }
  }
  return matrix[b.length][a.length];
}

function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function textSimilarity(a, b) {
  if (!a || !b) return 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const maxLen = Math.max(longer.length, 1);
  const levRatio = 1 - levenshteinDistance(longer, shorter) / maxLen;
  const jac = jaccardSimilarity(a, b);
  return 0.6 * levRatio + 0.4 * jac;
}

class DoomLoopDetector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.detectorId = config.detectorId || `doom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    this._toolCalls = [];
    this._messageHistory = [];
    this._recentHashes = new Map();
    this._recentToolSequences = new Map();
    this._failureStreak = new Map();
    this._tokenUsage = [];
    this._totalTokens = 0;
    this._productiveMessages = 0;
    this._startTime = Date.now();
    this._lastAbortAt = 0;
    this._confidence = 0;
    this._lastPattern = null;
    this._warningEmitted = false;
  }

  recordToolCall(toolName, args = null, meta = {}) {
    const now = Date.now();
    const hash = argsHash(args);
    const entry = {
      tool: toolName,
      hash,
      ts: now,
      success: meta.success !== false,
      error: meta.error || null,
      productive: meta.productive !== false,
      tokens: meta.tokens || 0,
    };

    this._toolCalls.push(entry);
    if (this._toolCalls.length > this.config.maxTrackedToolCalls) {
      this._toolCalls.splice(0, this._toolCalls.length - this.config.maxTrackedToolCalls);
    }

    if (hash) {
      const count = (this._recentHashes.get(hash) || 0) + 1;
      this._recentHashes.set(hash, count);
    }

    if (!entry.success) {
      const key = `${toolName}:${hash}`;
      this._failureStreak.set(key, (this._failureStreak.get(key) || 0) + 1);
    } else {
      const key = `${toolName}:${hash}`;
      this._failureStreak.delete(key);
      if (entry.productive) {
        this._productiveMessages++;
      }
    }

    if (entry.tokens) {
      this._totalTokens += entry.tokens;
      this._tokenUsage.push({ ts: now, tokens: entry.tokens, productive: entry.productive });
    }

    this._pruneExpired();
  }

  recordAssistantMessage(message, meta = {}) {
    const now = Date.now();
    const entry = {
      text: typeof message === 'string' ? message : String(message ?? ''),
      hash: stableMessageHash(message),
      ts: now,
      tokens: meta.tokens || 0,
      productive: meta.productive !== false,
    };

    this._messageHistory.push(entry);
    if (this._messageHistory.length > this.config.maxTrackedMessages) {
      this._messageHistory.splice(0, this._messageHistory.length - this.config.maxTrackedMessages);
    }

    if (entry.tokens) {
      this._totalTokens += entry.tokens;
      this._tokenUsage.push({ ts: now, tokens: entry.tokens, productive: entry.productive });
    }

    if (entry.productive) {
      this._productiveMessages++;
    }

    this._pruneExpired();
  }

  checkDoomLoop() {
    this._pruneExpired();

    const signals = [];

    const repSignal = this._detectToolRepetition();
    if (repSignal) signals.push(repSignal);

    const cycleSignal = this._detectToolCycle();
    if (cycleSignal) signals.push(cycleSignal);

    const msgSignal = this._detectMessageRepetition();
    if (msgSignal) signals.push(msgSignal);

    const escalSignal = this._detectEscalation();
    if (escalSignal) signals.push(escalSignal);

    const satSignal = this._detectContextSaturation();
    if (satSignal) signals.push(satSignal);

    if (signals.length === 0) {
      this._confidence = Math.max(0, this._confidence * 0.5);
      return {
        detected: false,
        confidence: this._confidence,
        pattern: null,
        details: {},
      };
    }

    signals.sort((a, b) => b.confidence - a.confidence);

    const combined = this._combineConfidences(signals.map(s => s.confidence));
    this._confidence = combined;
    const primary = signals[0];

    const details = {
      primaryPattern: primary.pattern,
      primaryConfidence: primary.confidence,
      contributingPatterns: signals.map(s => ({
        pattern: s.pattern,
        confidence: s.confidence,
        evidence: s.evidence,
      })),
      toolCallCount: this._toolCalls.length,
      messageCount: this._messageHistory.length,
      totalTokens: this._totalTokens,
    };

    const detected = combined >= this.config.confidenceThreshold;

    if (detected) {
      if (combined >= this.config.confidenceThreshold && this._lastPattern !== primary.pattern) {
        this._lastPattern = primary.pattern;
        this._warningEmitted = false;
        this.emit('doom_detected', {
          detectorId: this.detectorId,
          confidence: combined,
          pattern: primary.pattern,
          details,
        });
      }
    } else if (combined >= this.config.warningThreshold && !this._warningEmitted) {
      this._warningEmitted = true;
      this.emit('doom_warning', {
        detectorId: this.detectorId,
        confidence: combined,
        pattern: primary.pattern,
        details,
      });
    } else if (combined < this.config.warningThreshold) {
      this._warningEmitted = false;
    }

    return {
      detected,
      confidence: combined,
      pattern: primary.pattern,
      details,
    };
  }

  shouldAbort() {
    const result = this.checkDoomLoop();
    const cooldownOk = Date.now() - this._lastAbortAt > this.config.abortCooldownMs;
    const patternActive = result.pattern !== null;
    if (result.detected && cooldownOk && patternActive) {
      this._lastAbortAt = Date.now();
      this.emit('abort_triggered', {
        detectorId: this.detectorId,
        confidence: result.confidence,
        pattern: result.pattern,
        details: result.details,
      });
      return true;
    }
    return false;
  }

  reset() {
    this._toolCalls.length = 0;
    this._messageHistory.length = 0;
    this._recentHashes.clear();
    this._recentToolSequences.clear();
    this._failureStreak.clear();
    this._tokenUsage.length = 0;
    this._totalTokens = 0;
    this._productiveMessages = 0;
    this._startTime = Date.now();
    this._confidence = 0;
    this._lastPattern = null;
    this._lastAbortAt = 0;
    this._warningEmitted = false;
    this.emit('reset', { detectorId: this.detectorId });
  }

  getStats() {
    return {
      detectorId: this.detectorId,
      toolCallCount: this._toolCalls.length,
      messageCount: this._messageHistory.length,
      totalTokens: this._totalTokens,
      productiveMessages: this._productiveMessages,
      currentConfidence: this._confidence,
      currentPattern: this._lastPattern,
      uptimeMs: Date.now() - this._startTime,
      lastAbortAt: this._lastAbortAt,
    };
  }

  _pruneExpired() {
    const cutoff = Date.now() - this.config.timeWindowMs;
    while (this._toolCalls.length > 0 && this._toolCalls[0].ts < cutoff) {
      this._toolCalls.shift();
    }
    while (this._messageHistory.length > 0 && this._messageHistory[0].ts < cutoff) {
      this._messageHistory.shift();
    }
    if (this._toolCalls.length === 0) {
      this._recentHashes.clear();
      this._failureStreak.clear();
    }
  }

  _detectToolRepetition() {
    const counts = new Map();
    const recent = this._toolCalls.slice(-1 * this.config.minOccurrences * 2);
    for (const tc of recent) {
      const key = `${tc.tool}::${tc.hash}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    let maxCount = 0;
    let maxKey = null;
    for (const [key, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        maxKey = key;
      }
    }

    if (maxCount >= this.config.minOccurrences) {
      const confidence = Math.min(1, maxCount / (this.config.minOccurrences * 2));
      return {
        pattern: 'tool_repetition',
        confidence,
        evidence: { key: maxKey, count: maxCount, totalTracked: recent.length },
      };
    }
    return null;
  }

  _detectToolCycle() {
    const calls = this._toolCalls;
    const n = calls.length;
    const minLen = this.config.cycleMinLength;
    const maxLen = Math.min(this.config.cycleMaxLength, Math.floor(n / 2));

    if (n < minLen * 2) return null;

    for (let len = maxLen; len >= minLen; len--) {
      const patternCalls = calls.slice(-len);
      const patternSig = patternCalls.map(c => `${c.tool}::${c.hash}`).join('|');

      let repetitions = 1;
      for (let start = n - len - len; start >= 0; start -= len) {
        const segment = calls.slice(start, start + len);
        const segSig = segment.map(c => `${c.tool}::${c.hash}`).join('|');
        if (segSig === patternSig) {
          repetitions++;
        } else {
          break;
        }
      }

      if (repetitions >= 2) {
        const confidence = Math.min(1, (repetitions - 1) * 0.35 + (len / maxLen) * 0.2);
        return {
          pattern: 'tool_cycle',
          confidence,
          evidence: { length: len, repetitions, signature: patternSig.slice(0, 80) },
        };
      }
    }
    return null;
  }

  _detectMessageRepetition() {
    const messages = this._messageHistory;
    const n = messages.length;
    if (n < 2) return null;

    const simThreshold = this.config.messageSimilarityThreshold;
    let maxSimilarity = 0;
    let similarPair = null;
    const recent = messages.slice(-12);

    for (let i = 0; i < recent.length; i++) {
      for (let j = i + 1; j < recent.length; j++) {
        if (recent[i].hash && recent[i].hash === recent[j].hash) {
          const sim = 1;
          if (sim > maxSimilarity) {
            maxSimilarity = sim;
            similarPair = { i, j, exact: true };
          }
        }
      }
    }

    if (maxSimilarity < simThreshold && recent.length >= 2) {
      const last = recent[recent.length - 1];
      for (let i = 0; i < recent.length - 1; i++) {
        const sim = textSimilarity(recent[i].text, last.text);
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
          similarPair = { i, j: recent.length - 1, exact: false };
        }
      }
    }

    if (maxSimilarity >= simThreshold) {
      const confidence = Math.min(1, 0.4 + (maxSimilarity - simThreshold) * 4);
      return {
        pattern: 'message_repetition',
        confidence,
        evidence: { similarity: maxSimilarity, pair: similarPair, messageCount: n },
      };
    }
    return null;
  }

  _detectEscalation() {
    let worstStreak = 0;
    let worstKey = null;
    for (const [key, count] of this._failureStreak) {
      if (count > worstStreak) {
        worstStreak = count;
        worstKey = key;
      }
    }

    const recentFailures = this._toolCalls.filter(tc => !tc.success);
    const recentSuccess = this._toolCalls.filter(tc => tc.success).length;
    const recentTotal = this._toolCalls.length;
    const failRatio = recentTotal > 0 ? recentFailures.length / recentTotal : 0;

    const escalating = worstStreak >= this.config.minOccurrences
      || (failRatio > 0.7 && recentTotal >= this.config.minOccurrences);

    if (escalating) {
      const streakConf = Math.min(1, worstStreak / (this.config.minOccurrences * 2));
      const ratioConf = failRatio > 0 ? (failRatio - 0.5) * 2 : 0;
      const confidence = Math.max(streakConf, ratioConf);
      return {
        pattern: 'escalation',
        confidence,
        evidence: {
          worstStreak,
          worstKey,
          failRatio,
          recentFailures: recentFailures.length,
          recentSuccess,
          recentTotal,
        },
      };
    }
    return null;
  }

  _detectContextSaturation() {
    const recent = this._tokenUsage.slice(-this.config.saturationMinMessages);
    if (recent.length < this.config.saturationMinMessages) return null;

    const totalInWindow = recent.reduce((sum, r) => sum + r.tokens, 0);
    const productiveInWindow = recent.filter(r => r.productive).length;
    const productivityRatio = recent.length > 0 ? productiveInWindow / recent.length : 1;

    const highTokens = totalInWindow >= this.config.saturationTokenThreshold;
    const lowProductivity = productivityRatio < 0.2;

    if (highTokens && lowProductivity) {
      const tokenScore = Math.min(1, totalInWindow / (this.config.saturationTokenThreshold * 2));
      const prodScore = 1 - productivityRatio;
      const confidence = Math.min(1, 0.5 * tokenScore + 0.5 * prodScore);
      return {
        pattern: 'context_saturation',
        confidence,
        evidence: {
          tokensInWindow: totalInWindow,
          productiveRatio: productivityRatio,
          samples: recent.length,
        },
      };
    }
    return null;
  }

  _combineConfidences(confidences) {
    if (confidences.length === 0) return 0;
    if (confidences.length === 1) return confidences[0];
    const sorted = [...confidences].sort((a, b) => b - a);
    let combined = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const remaining = 1 - combined;
      combined += remaining * sorted[i] * 0.75;
    }
    return Math.min(1, combined);
  }
}

module.exports = {
  DoomLoopDetector,
  DEFAULT_CONFIG,
  argsHash,
  stableMessageHash,
  textSimilarity,
  levenshteinDistance,
  jaccardSimilarity,
};
