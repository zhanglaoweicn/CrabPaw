/**
 * LoopDetectionMiddleware - 循环检测中间件
 * 
 * 检测重复工具调用，防止 Agent 无限循环
 * 
 * 三级检测策略 (参考 OpenHuman RepeatFailureGuard):
 * 1. Hard Reject: 安全策略拒绝的重复尝试 (3次触发)
 * 2. Same Signature Loop: 相同工具+参数的重复失败 (5次触发)
 * 3. No Progress: 连续N次工具调用全部失败 (无进展检测)
 * 
 * 额外保留原有功能:
 * - 对每次模型响应的工具调用进行哈希 (name + args)
 * - 在滑动窗口中追踪最近的哈希值
 * - 如果相同哈希出现 >= warnThreshold 次，注入警告消息
 * - 如果相同哈希出现 >= hardLimit 次，强制停止
 */

const { Middleware } = require('./base');

const DEFAULT_WARN_THRESHOLD = 3;
const DEFAULT_HARD_LIMIT = 5;
const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MAX_TRACKED_THREADS = 100;

// 三级熔断阈值
const HARD_REJECT_REPEAT_THRESHOLD = 3;
const REPEAT_FAILURE_THRESHOLD = 5;
const NO_PROGRESS_FAILURE_THRESHOLD = 8;

// 安全拒绝关键词 — 标识被安全策略拦截的失败
const HARD_REJECT_PATTERNS = [
  /permission denied/i,
  /access denied/i,
  /not allowed/i,
  /forbidden/i,
  /blocked by security/i,
  /blocked by policy/i,
  /sandbox.*denied/i,
  /unauthorized/i,
  /安全策略.*拒绝/,
  /权限不足/,
  /操作被拒绝/,
];

function isHardRejection(result) {
  if (!result) return false;
  const text = typeof result === 'string' ? result : (result.error || result.message || String(result));
  return HARD_REJECT_PATTERNS.some(p => p.test(text));
}

function normalizeToolCallArgs(rawArgs) {
  if (typeof rawArgs === 'object' && rawArgs !== null) {
    return { args: rawArgs, fallbackKey: null };
  }

  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      if (typeof parsed === 'object' && parsed !== null) {
        return { args: parsed, fallbackKey: null };
      }
      return { args: {}, fallbackKey: rawArgs };
    } catch {
      return { args: {}, fallbackKey: rawArgs };
    }
  }

  if (rawArgs === null || rawArgs === undefined) {
    return { args: {}, fallbackKey: null };
  }

  return { args: {}, fallbackKey: String(rawArgs) };
}

function stableToolKey(name, args, fallbackKey) {
  // 2026-09-07: 补 'file_path'——bossagent Read 工具的实际参数名, 缺失时
  // 所有 Read 哈希成同一个 key → 读 5 个不同文件被判"同一调用重复 5 次"
  // 强制跳过(宣传片实测: 探索期 Read 全被拦, 整轮报废)。
  const salientFields = ['path', 'url', 'query', 'command', 'pattern', 'glob', 'cmd', 'file', 'directory', 'file_path'];

  // 大小写不敏感——工具主名是 PascalCase('Read'), 旧判断 name === 'read'
  // 永远不命中, Read 永远走不到路径分桶分支。
  const lname = String(name || '').toLowerCase();
  if (lname === 'read' || lname === 'read_file') {
    const path = args.path || args.file || args.file_path || '';
    const startLine = args.start_line || args.startLine || args.offset || 0;
    const endLine = args.end_line || args.endLine || args.limit || startLine + 200;
    
    const bucketSize = 200;
    const bucketStart = Math.floor(Math.max(0, startLine) / bucketSize);
    const bucketEnd = Math.floor(Math.max(0, endLine) / bucketSize);
    
    return `${path}:${bucketStart}-${bucketEnd}`;
  }

  if (name === 'write' || name === 'write_file' || name === 'str_replace') {
    if (fallbackKey) {
      return fallbackKey;
    }
    try {
      return JSON.stringify(args, Object.keys(args).sort());
    } catch {
      const stableFragment = typeof args === 'object' ? Object.keys(args || {}).sort().join(',') : String(args);
      return `${name}:${stableFragment.slice(0, 120)}`;
    }
  }

  const stableArgs = {};
  for (const field of salientFields) {
    if (args[field] !== undefined) {
      stableArgs[field] = args[field];
    }
  }

  if (Object.keys(stableArgs).length > 0) {
    try {
      return JSON.stringify(stableArgs);
    } catch {
      return fallbackKey || name;
    }
  }

  return fallbackKey || name;
}

function hashToolCall(toolCall) {
  const name = toolCall.name || toolCall.function?.name || 'unknown';
  const rawArgs = toolCall.arguments || toolCall.function?.arguments || toolCall.args || {};
  
  const { args, fallbackKey } = normalizeToolCallArgs(rawArgs);
  const key = stableToolKey(name, args, fallbackKey);
  
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  return {
    hash: Math.abs(hash).toString(16),
    name,
    key
  };
}

/**
 * RepeatFailureGuard - 三级熔断守卫
 * 
 * 参考 OpenHuman tool_loop.rs 的 RepeatFailureGuard 实现：
 * - Hard Reject: 安全策略拒绝的重复尝试
 * - Same Signature Loop: 相同工具+参数的重复失败
 * - No Progress: 连续N次工具调用全部失败
 * 
 * 每级返回定制化错误消息，指导 Agent 换策略而非盲目重试
 */
class RepeatFailureGuard {
  constructor(config = {}) {
    this.sigCounts = new Map();   // "tool:argsSig" -> count
    this.consecutive = 0;         // 连续失败次数
    this.hardRejectThreshold = config.hardRejectThreshold || HARD_REJECT_REPEAT_THRESHOLD;
    this.repeatFailureThreshold = config.repeatFailureThreshold || REPEAT_FAILURE_THRESHOLD;
    this.noProgressThreshold = config.noProgressThreshold || NO_PROGRESS_FAILURE_THRESHOLD;
  }

  record(tool, argsSig, success, result) {
    if (success) {
      this.consecutive = 0;
      const key = `${tool}:${argsSig}`;
      this.sigCounts.delete(key);
      return null;
    }

    this.consecutive += 1;
    const key = `${tool}:${argsSig}`;
    const count = (this.sigCounts.get(key) || 0) + 1;
    this.sigCounts.set(key, count);

    if (isHardRejection(result)) {
      if (count >= this.hardRejectThreshold) {
        return `Agent repeatedly attempted a disallowed action (${count} times). ` +
          `This action is blocked by security policy and will not succeed. ` +
          `Please try a different approach.`;
      }
    }

    if (count >= this.repeatFailureThreshold) {
      return `Agent is stuck in a loop: the same ${tool} tool call has failed ${count} times ` +
        `with identical arguments. This suggests the current approach isn't working. ` +
        `Please try a different strategy.`;
    }

    if (this.consecutive >= this.noProgressThreshold) {
      return `Agent has made no progress after ${this.consecutive} consecutive failed tool calls. ` +
        `This suggests the current task may not be completable with available tools or information. ` +
        `Please check inputs and try again.`;
    }

    return null;
  }

  reset() {
    this.sigCounts.clear();
    this.consecutive = 0;
  }

  getStats() {
    return {
      consecutive: this.consecutive,
      trackedSignatures: this.sigCounts.size,
      topFailures: Array.from(this.sigCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, count]) => ({ signature: key, failures: count }))
    };
  }
}

class LoopDetectionMiddleware extends Middleware {
  constructor(config = {}) {
    super({
      name: 'LoopDetectionMiddleware',
      priority: 100,
      ...config
    });

    this.warnThreshold = config.warnThreshold || DEFAULT_WARN_THRESHOLD;
    this.hardLimit = config.hardLimit || DEFAULT_HARD_LIMIT;
    this.windowSize = config.windowSize || DEFAULT_WINDOW_SIZE;
    this.maxTrackedThreads = config.maxTrackedThreads || DEFAULT_MAX_TRACKED_THREADS;
    this.crossTurnWarnThreshold = config.crossTurnWarnThreshold || 8;
    this.crossTurnHardLimit = config.crossTurnHardLimit || 12;
    this.advisoryOnly = config.advisoryOnly === true;

    this._threadHashes = new Map();
    this._warnedHashes = new Set();
    this._lock = new Map();
    this._crossTurnCounts = new Map();
    this._crossTurnWarned = new Set();
    this._failureGuards = new Map();
    this._eventCallback = null;
  }

  setEventCallback(cb) {
    this._eventCallback = cb;
  }

  _emit(event) {
    if (this._eventCallback) {
      try { this._eventCallback(event); } catch (e) { console.warn('[loop-detection] eventCallback 失败:', e?.message || e); }
    }
  }

  /**
   * 获取或创建线程的 RepeatFailureGuard
   */
  _getFailureGuard(threadId) {
    if (!this._failureGuards.has(threadId)) {
      if (this._failureGuards.size >= this.maxTrackedThreads) {
        const oldestKey = this._failureGuards.keys().next().value;
        this._failureGuards.delete(oldestKey);
      }
      this._failureGuards.set(threadId, new RepeatFailureGuard());
    }
    return this._failureGuards.get(threadId);
  }

  /**
   * 记录工具执行结果，检查三级熔断
   * @param {string} threadId - 线程ID
   * @param {string} toolName - 工具名
   * @param {string} argsSig - 参数签名
   * @param {boolean} success - 是否成功
   * @param {string} result - 执行结果文本
   * @returns {string|null} 熔断消息，null表示未触发
   */
  recordToolResult(threadId, toolName, argsSig, success, result) {
    const guard = this._getFailureGuard(threadId);
    return guard.record(toolName, argsSig, success, result);
  }

  _getThreadHashes(threadId) {
    if (!this._threadHashes.has(threadId)) {
      if (this._threadHashes.size >= this.maxTrackedThreads) {
        const oldestKey = this._threadHashes.keys().next().value;
        this._threadHashes.delete(oldestKey);
        this._warnedHashes.delete(oldestKey);
      }
      this._threadHashes.set(threadId, []);
    }
    return this._threadHashes.get(threadId);
  }

  _detectLoop(threadId, hashInfo) {
    const hashes = this._getThreadHashes(threadId);
    const { hash, name } = hashInfo;

    hashes.push({ hash, name, timestamp: Date.now() });

    if (hashes.length > this.windowSize) {
      hashes.shift();
    }

    const count = hashes.filter(h => h.hash === hash).length;
    // 工具名级别检测：同一工具名（不区分参数）调用次数
    const nameCount = hashes.filter(h => h.name === name).length;
    const nameHardLimit = this.hardLimit + 2; // 工具名级别阈值比精确匹配宽松2次

    return {
      count,
      isWarning: count >= this.warnThreshold,
      isHardLimit: count >= this.hardLimit || nameCount >= nameHardLimit,
      toolName: name
    };
  }

  async beforeModel(context) {
    // eslint-disable-next-line no-unused-vars
    const threadId = context.getMetadata('threadId') || 'default';

    return null;
  }

  async afterModel(context, response) {
    if (!response || !response.tool_calls || response.tool_calls.length === 0) {
      return response;
    }

    const threadId = context.getMetadata('threadId') || 'default';
    const results = [];

    for (const toolCall of response.tool_calls) {
      const hashInfo = hashToolCall(toolCall);
      const loopStatus = this._detectLoop(threadId, hashInfo);

      if (loopStatus.isHardLimit) {
        const warningKey = `${threadId}:${hashInfo.hash}`;
        
        if (!this._warnedHashes.has(warningKey)) {
          this._warnedHashes.add(warningKey);
          
          const warnMsg = `<loop_warning>
检测到工具调用循环: "${loopStatus.toolName}" 已连续调用 ${loopStatus.count} 次。
你必须立即停止调用此工具，并执行以下操作：
1. 用自然语言向用户总结你目前已获取的信息
2. 如果信息不完整，向用户解释缺少什么以及为什么无法获取
3. 给出替代建议或后续步骤
不要再调用相同的工具。直接向用户回复。
</loop_warning>`;

          context.addMessage({ role: 'system', content: warnMsg });
          context.setMetadata('loopDetected', {
            toolName: loopStatus.toolName, count: loopStatus.count, hash: hashInfo.hash
          });
          this._emit({ type: 'loop_warning', level: 'hard', tool: loopStatus.toolName, count: loopStatus.count, message: warnMsg });
        }

        if (this.advisoryOnly) {
          results.push({ toolCall, loopStatus, advisoryPassed: true });
          // Still track cross-turn in advisory mode
          const advCrossKey = `${threadId}:${hashInfo.hash}`;
          const advEntry = this._crossTurnCounts.get(advCrossKey) || {
            count: 0, firstSeen: Date.now(), lastSeen: Date.now(), toolName: hashInfo.name,
          };
          advEntry.count += 1;
          advEntry.lastSeen = Date.now();
          this._crossTurnCounts.set(advCrossKey, advEntry);
          continue;
        }

        const filteredToolCalls = response.tool_calls.filter(tc => {
          const tcHash = hashToolCall(tc);
          return tcHash.hash !== hashInfo.hash;
        });

        if (filteredToolCalls.length === 0) {
          this._emit({ type: 'loop_warning', level: 'blocked', tool: loopStatus.toolName, count: loopStatus.count });
          return {
            ...response,
            tool_calls: [],
            content: response.content || '我已完成当前任务的分析。'
          };
        }

        return {
          ...response,
          tool_calls: filteredToolCalls
        };
      }

      if (loopStatus.isWarning) {
        const warningKey = `${threadId}:${hashInfo.hash}`;
        
        if (!this._warnedHashes.has(warningKey)) {
          this._warnedHashes.add(warningKey);
          
          const hintMsg = `<loop_hint>
注意: 工具 "${loopStatus.toolName}" 已调用 ${loopStatus.count} 次。
如果继续重复，将被强制停止。请考虑：
- 换一种方法或工具来完成任务
- 如果已有部分结果，直接向用户总结当前信息
- 如果工具持续失败，向用户解释原因并给出替代建议
</loop_hint>`;

          context.addMessage({ role: 'system', content: hintMsg });
          this._emit({ type: 'loop_warning', level: 'hint', tool: loopStatus.toolName, count: loopStatus.count, message: hintMsg });
        }
      }

      results.push({ toolCall, loopStatus });

      // ── 跨轮次循环检测 ──────────────────────────────────────
      const crossKey = `${threadId}:${hashInfo.hash}`;
      const crossEntry = this._crossTurnCounts.get(crossKey) || {
        count: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        toolName: hashInfo.name,
      };
      crossEntry.count += 1;
      crossEntry.lastSeen = Date.now();
      this._crossTurnCounts.set(crossKey, crossEntry);

      // 跨轮次硬限制：检测跨多轮的重复调用
      if (crossEntry.count >= this.crossTurnHardLimit && !this._crossTurnWarned.has(crossKey)) {
        this._crossTurnWarned.add(crossKey);
        context.addMessage({
          role: 'system',
          content: `<cross_turn_loop_warning>
⚠️ 跨轮次循环检测: "${crossEntry.toolName}" 在 ${crossEntry.count} 个轮次中被重复调用（首次: ${new Date(crossEntry.firstSeen).toISOString()}）。
这表示你跨越多轮对话反复执行相同的操作。请：
1. 检查是否陷入了跨轮次的重复模式
2. 向用户总结当前进度，确认是否还需要继续
3. 如果任务已经完成，直接报告结果
</cross_turn_loop_warning>`
        });
      } else if (crossEntry.count >= this.crossTurnWarnThreshold && !this._crossTurnWarned.has(crossKey)) {
        this._crossTurnWarned.add(crossKey);
        context.addMessage({
          role: 'system',
          content: `<cross_turn_loop_hint>
注意: "${crossEntry.toolName}" 已在 ${crossEntry.count} 个轮次中被调用。请确认这确实是需要的，而非陷入了重复模式。
</cross_turn_loop_hint>`
        });
      }

      // 清理过期的跨轮次记录（超过 1 小时未使用的）
      if (this._crossTurnCounts.size > 500) {
        const now = Date.now();
        for (const [key, entry] of this._crossTurnCounts) {
          if (now - entry.lastSeen > 3600000) {
            this._crossTurnCounts.delete(key);
            this._crossTurnWarned.delete(key);
          }
        }
      }
    }

    context.setMetadata('loopAnalysis', results);
    return response;
  }

  /**
   * 导出跨轮次状态（供持久化使用）
   * @returns {object} 可序列化的跨轮次状态
   */
  exportCrossTurnState() {
    return {
      counts: Array.from(this._crossTurnCounts.entries()),
      warned: Array.from(this._crossTurnWarned),
      exportedAt: Date.now(),
    };
  }

  /**
   * 恢复跨轮次状态（从持久化存储加载）
   * @param {object} state - 由 exportCrossTurnState() 导出的状态
   */
  restoreCrossTurnState(state) {
    if (!state || !state.counts) return;
    const now = Date.now();
    const maxAge = 86400000; // 24 hours
    this._crossTurnCounts = new Map(
      state.counts.filter(([, entry]) => now - entry.lastSeen < maxAge)
    );
    this._crossTurnWarned = new Set(
      Array.from(state.warned || []).filter(key => this._crossTurnCounts.has(key))
    );
  }

  reset(threadId) {
    this._threadHashes.delete(threadId);
    this._failureGuards.delete(threadId);

    for (const key of this._warnedHashes) {
      if (key.startsWith(`${threadId}:`)) {
        this._warnedHashes.delete(key);
      }
    }
    // 注意：_crossTurnCounts 和 _crossTurnWarned 不在 reset() 中清除
    // 它们只有通过 restoreCrossTurnState() 或超时过期才会被清除
  }

  getStats(threadId) {
    const hashes = this._getThreadHashes(threadId);
    const counts = {};
    
    for (const h of hashes) {
      counts[h.hash] = (counts[h.hash] || 0) + 1;
    }
    
    return {
      totalCalls: hashes.length,
      uniqueHashes: Object.keys(counts).length,
      topRepeated: Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([hash, count]) => ({ hash, count }))
    };
  }
}

module.exports = {
  LoopDetectionMiddleware,
  RepeatFailureGuard,
  hashToolCall,
  stableToolKey,
  normalizeToolCallArgs,
  isHardRejection,
  DEFAULT_WARN_THRESHOLD,
  DEFAULT_HARD_LIMIT,
  DEFAULT_WINDOW_SIZE,
  HARD_REJECT_REPEAT_THRESHOLD,
  REPEAT_FAILURE_THRESHOLD,
  NO_PROGRESS_FAILURE_THRESHOLD
};
