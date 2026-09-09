const { EventEmitter } = require('events');
const ContextCompressor = require('./context/compressor');
const { ContextPipeline } = require('./context/pipeline');
const { getAuxiliaryClient, TASK_TYPES } = require('./auxiliary-client');

class ContextEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.lastPromptTokens = 0;
    this.lastCompletionTokens = 0;
    this.lastTotalTokens = 0;
    this.thresholdTokens = config.thresholdTokens || 0;
    this.contextLength = 0;
    this.compressionCount = 0;
    this.thresholdPercent = config.thresholdPercent || 0.75;
    this.protectFirstN = config.protectFirstN || 3;
    this.protectLastN = config.protectLastN || 6;
    this.maxSummaryTokens = config.maxSummaryTokens || 2000;
    this._sessionHistory = new Map();
    this._compressionCache = new Map();
    this._cacheTTL = config.cacheTTL || 3600000;
    this._llmSummaryEnabled = config.llmSummaryEnabled !== false;
    this._llmSummaryTimeout = config.llmSummaryTimeout || 30000;
    this._llmSummaryFailCount = 0;
    this._llmSummaryMaxFails = config.llmSummaryMaxFails || 3;
    this._llmSummaryCooldownUntil = 0;
    this._previousSummary = null;

    this._compressor = new ContextCompressor({
      maxTokens: config.maxTokens || 128000,
      summaryThreshold: this.thresholdPercent,
      protectFirstN: this.protectFirstN,
      quietMode: config.quietMode || false,
    });

    if (this._llmSummaryEnabled) {
      this._setupLLMCompress();
    }

    this._pipeline = new ContextPipeline({
      contextWindow: config.maxTokens || 128000,
      llmCompressFn: this._compressor._llmCompressFn || null,
    });
    this._pipeline.setCompressor(this._compressor);
  }

  get name() {
    return 'base';
  }

  get pipeline() {
    return this._pipeline;
  }

  _setupLLMCompress() {
    try {
      const client = getAuxiliaryClient();
      this._compressor.setLLMCompressFn(async (prompt, options = {}) => {
        const resolved = client.resolveProvider(TASK_TYPES.COMPRESSION);
        if (!resolved) {
          this._llmSummaryFailCount++;
          return null;
        }
        const providerCfg = client._getProviderConfig(resolved.provider);
        if (!providerCfg) {
          this._llmSummaryFailCount++;
          return null;
        }
        const result = await client.callLlm({
          taskType: TASK_TYPES.COMPRESSION,
          messages: [
            // P1-②(2026-09-03, dsh 机制⑦): 辅助压缩调用带会话真前缀——system 消息
            // 与会话主请求逐字节一致时, 同供应商 KV cache 可命中该前缀; 未传时维持
            // 原独立请求形状(向后兼容)。
            ...(options.systemMessage
              ? [{ role: 'system', content: options.systemMessage }]
              : []),
            { role: 'user', content: prompt },
          ],
          maxTokens: options.maxTokens || 2000,
          temperature: 0.3,
          timeout: this._llmSummaryTimeout,
        });
        return result.content || null;
      });
    } catch (e) {
      this._llmSummaryEnabled = false;
    }
  }

  updateFromResponse(usage) {
    if (!usage) return;
    this.lastPromptTokens = usage.prompt_tokens || usage.input_tokens || 0;
    this.lastCompletionTokens = usage.completion_tokens || usage.output_tokens || 0;
    this.lastTotalTokens = this.lastPromptTokens + this.lastCompletionTokens;
    this.contextLength = this.lastPromptTokens;
    this._compressor.updateModel(null, this.thresholdTokens || 128000);
    if (this._pipeline) {
      this._pipeline.recordUsage(usage);
    }
    this.emit('usage_updated', {
      promptTokens: this.lastPromptTokens,
      completionTokens: this.lastCompletionTokens,
      totalTokens: this.lastTotalTokens,
    });
  }

  should_compress(promptTokens) {
    const tokens = promptTokens || this.lastPromptTokens;
    if (this.thresholdTokens <= 0) return false;
    return tokens >= this.thresholdTokens * this.thresholdPercent;
  }

  should_compress_preflight(messages) {
    if (!messages || messages.length < this.protectFirstN + this.protectLastN + 2) {
      return false;
    }
    const estimatedTokens = this._estimateTokens(messages);
    return this.should_compress(estimatedTokens);
  }

  _estimateTokens(messages) {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += (msg.content || '').length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          totalChars += (tc.function?.name || '').length;
          totalChars += (tc.function?.arguments || '').length;
        }
      }
    }
    return Math.ceil(totalChars / 3.5);
  }

  has_content_to_compress(messages) {
    if (!messages || messages.length <= this.protectFirstN + this.protectLastN) {
      return false;
    }
    const middleMessages = messages.slice(this.protectFirstN, -this.protectLastN);
    return middleMessages.some(m => (m.content || '').length > 50);
  }

  _splitMessages(messages) {
    if (messages.length <= this.protectFirstN + this.protectLastN) {
      return { head: messages, middle: [], tail: [] };
    }
    const head = messages.slice(0, this.protectFirstN);
    const tail = messages.slice(-this.protectLastN);
    const middle = messages.slice(this.protectFirstN, -this.protectLastN);
    return { head, middle, tail };
  }

  _extractTopics(messages) {
    const topics = new Set();
    for (const msg of messages) {
      const content = msg.content || '';
      const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
      for (const block of codeBlocks) {
        const langMatch = block.match(/```(\w+)/);
        if (langMatch) topics.add(`code:${langMatch[1]}`);
      }
      const fileRefs = content.match(/[\w/.-]+\.\w{1,10}/g) || [];
      for (const ref of fileRefs) {
        if (ref.length > 5) topics.add(`file:${ref}`);
      }
    }
    return Array.from(topics).slice(0, 10);
  }

  _summarizeLocally(messages) {
    const parts = [];
    let currentRole = null;
    let currentContent = [];

    for (const msg of messages) {
      const role = msg.role || 'unknown';
      if (role !== currentRole) {
        if (currentContent.length > 0) {
          parts.push(this._formatRoleChunk(currentRole, currentContent));
        }
        currentRole = role;
        currentContent = [];
      }
      currentContent.push(msg);
    }
    if (currentContent.length > 0) {
      parts.push(this._formatRoleChunk(currentRole, currentContent));
    }

    return parts.join('\n\n');
  }

  _formatRoleChunk(role, messages) {
    const label = role === 'user' ? '👤 用户' : role === 'assistant' ? '🤖 助手' : role === 'system' ? '⚙️ 系统' : '🔧 工具';
    const summaries = [];
    for (const msg of messages) {
      const content = msg.content || '';
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          summaries.push(`调用 ${tc.function?.name || 'unknown'}(${this._truncateArgs(tc.function?.arguments)})`);
        }
        if (content) summaries.push(content.substring(0, 100));
      } else if (msg.tool_call_id) {
        summaries.push(`工具结果: ${content.substring(0, 150)}`);
      } else {
        summaries.push(content.substring(0, 200));
      }
    }
    return `${label}: ${summaries.join(' → ')}`;
  }

  _truncateArgs(args) {
    if (!args) return '';
    try {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args;
      const keys = Object.keys(parsed);
      return keys.map(k => `${k}=${String(parsed[k]).substring(0, 30)}`).join(', ');
    } catch {
      return String(args).substring(0, 60);
    }
  }

  async compress(messages, currentTokens, focusTopic) {
    if (!this.has_content_to_compress(messages)) {
      return messages;
    }

    const { head, middle, tail } = this._splitMessages(messages);
    if (middle.length === 0) {
      return messages;
    }

    const cacheKey = this._getCacheKey(middle);
    const cached = this._compressionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._cacheTTL) {
      this.compressionCount++;
      return [...head, cached.summary, ...tail];
    }

    let summaryContent = null;
    let usedLLM = false;

    if (this._llmSummaryEnabled && Date.now() >= this._llmSummaryCooldownUntil) {
      try {
        const llmResult = await this._generateLLMSummary(middle, focusTopic);
        if (llmResult) {
          summaryContent = llmResult;
          usedLLM = true;
          this._llmSummaryFailCount = 0;
        }
      } catch (e) {
        this._llmSummaryFailCount++;
        if (this._llmSummaryFailCount >= this._llmSummaryMaxFails) {
          this._llmSummaryCooldownUntil = Date.now() + 60000;
          this._llmSummaryFailCount = 0;
        }
      }
    }

    if (!summaryContent) {
      summaryContent = this._generateStructuredLocalSummary(middle, focusTopic);
    }

    const topics = this._extractTopics(middle);
    const topicStr = topics.length > 0 ? `\n\n涉及主题: ${topics.join(', ')}` : '';
    const methodTag = usedLLM ? 'LLM摘要' : '本地摘要';

    const summaryMessage = {
      role: 'system',
      content: `[上下文摘要 - ${methodTag} - 已压缩 ${middle.length} 条消息]${topicStr}\n\n${summaryContent}`,
      _compressed: true,
      _originalCount: middle.length,
      _compressedAt: Date.now(),
      _compressionMethod: usedLLM ? 'llm' : 'local',
    };

    this._compressionCache.set(cacheKey, {
      summary: summaryMessage,
      timestamp: Date.now(),
    });

    this._previousSummary = summaryContent;
    this._cleanCache();
    this.compressionCount++;
    this.emit('compressed', {
      originalCount: middle.length + head.length + tail.length,
      compressedCount: head.length + 1 + tail.length,
      savedMessages: middle.length - 1,
      method: usedLLM ? 'llm' : 'local',
    });

    return [...head, summaryMessage, ...tail];
  }

  async _generateLLMSummary(middleMessages, focusTopic) {
    const client = getAuxiliaryClient();
    const resolved = client.resolveProvider(TASK_TYPES.COMPRESSION);
    if (!resolved) return null;

    const serialized = this._serializeForLLMSummary(middleMessages);
    const focusSection = focusTopic
      ? `\n\n聚焦主题: "${focusTopic}" — 与此主题相关的内容保留完整细节，其他内容更积极压缩`
      : '';

    const previousSection = this._previousSummary
      ? `\n\n之前的摘要:\n${this._previousSummary.slice(0, 3000)}\n\n请基于之前的摘要和新增对话更新摘要。保留所有仍相关的信息，添加新的已完成操作，更新当前状态。`
      : '';

    const prompt = `你是一个摘要代理，正在创建上下文检查点。将下面对话轮次压缩为结构化摘要。绝不包含API密钥、令牌、密码或凭证 — 用 [REDACTED] 替换。

使用以下结构:
## 活跃任务
[用户最近的未完成请求原文]
## 目标
[用户整体想完成的事情]
## 约束与偏好
[用户偏好、编码风格、约束、重要决定]
## 已完成操作
[编号列表，包含工具名、目标、结果]
## 当前状态
[工作目录、修改/创建的文件、测试状态]
## 进行中
[压缩触发时正在进行的工作]
## 阻塞
[未解决的错误或问题]
## 关键决策
[重要技术决策及其原因]
## 相关文件
[涉及的文件 — 附简要说明]
## 关键上下文
[必须保留的具体值、错误信息、配置细节]
${previousSection}${focusSection}

需要摘要的对话:
${serialized}`;

    const result = await client.callLlm({
      taskType: TASK_TYPES.COMPRESSION,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: this.maxSummaryTokens,
      temperature: 0.3,
      timeout: this._llmSummaryTimeout,
    });

    const content = result.content || '';
    if (!content || content.trim().length < 50) return null;
    return content.trim();
  }

  _serializeForLLMSummary(messages) {
    const parts = [];
    for (const msg of messages) {
      const role = msg.role || 'unknown';
      const content = msg.content || '';
      if (msg.tool_calls) {
        const callDesc = msg.tool_calls.map(tc =>
          `${tc.function?.name || '?'}(${(tc.function?.arguments || '').substring(0, 120)})`
        ).join(', ');
        parts.push(`[助手→调用工具] ${callDesc}`);
        if (content) parts.push(`[助手回复] ${content.substring(0, 500)}`);
      } else if (msg.tool_call_id) {
        parts.push(`[工具结果] ${content.substring(0, 300)}`);
      } else if (role === 'user') {
        parts.push(`[用户] ${content.substring(0, 500)}`);
      } else if (role === 'assistant') {
        parts.push(`[助手] ${content.substring(0, 500)}`);
      } else if (role === 'system') {
        parts.push(`[系统] ${content.substring(0, 200)}`);
      }
    }
    return parts.join('\n\n');
  }

  _generateStructuredLocalSummary(middleMessages, focusTopic) {
    const localSummary = this._summarizeLocally(middleMessages);
    const focusStr = focusTopic ? `\n\n当前关注: ${focusTopic}` : '';

    if (this._previousSummary) {
      return `## 迭代更新\n\n### 新增对话要点\n${localSummary}\n\n### 之前摘要（保留所有仍相关的信息）\n${this._previousSummary.slice(0, 3000)}${focusStr}`;
    }

    return `## 活跃任务\n[见最近用户请求]\n\n## 已完成操作\n${localSummary.split('\n').slice(0, 30).map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\n## 当前状态\n[见最新消息]${focusStr}`;
  }

  async compressWithCompressor(messages, options = {}) {
    const currentTokens = options.currentTokens || this._estimateTokens(messages);
    this._compressor.updateModel(options.model, this.thresholdTokens || options.maxTokens);

    if (this._llmSummaryEnabled && !this._compressor._llmCompressFn) {
      this._setupLLMCompress();
    }

    const result = await this._compressor.compress(messages, {
      currentTokens,
      focusTopic: options.focusTopic,
    });

    if (result.compressed) {
      this.compressionCount++;
      this.emit('compressed', {
        originalCount: messages.length,
        compressedCount: result.messages.length,
        savedMessages: messages.length - result.messages.length,
        method: this._compressor._llmCompressFn ? 'llm' : 'local',
        savingsPct: result.savingsPct,
      });
    }

    return result;
  }

  _getCacheKey(messages) {
    const parts = messages.map(m => `${m.role}:${(m.content || '').substring(0, 50)}`);
    return parts.join('|');
  }

  _cleanCache() {
    if (this._compressionCache.size <= 50) return;
    const entries = Array.from(this._compressionCache.entries());
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toDelete = entries.slice(0, entries.length - 30);
    for (const [key] of toDelete) {
      this._compressionCache.delete(key);
    }
  }

  on_session_start(sessionId, _kwargs) {
    this._sessionHistory.set(sessionId, {
      startTime: Date.now(),
      messageCount: 0,
      compressionCount: 0,
    });
    this._previousSummary = null;
    this._compressor.onSessionReset();
  }

  on_session_end(sessionId, messages) {
    const session = this._sessionHistory.get(sessionId);
    if (session) {
      session.endTime = Date.now();
      session.messageCount = messages ? messages.length : 0;
      session.duration = session.endTime - session.startTime;
    }
  }

  on_session_reset() {
    this._sessionHistory.clear();
    this._compressionCache.clear();
    this._previousSummary = null;
    this._llmSummaryFailCount = 0;
    this._llmSummaryCooldownUntil = 0;
    this._compressor.onSessionReset();
  }

  getSessionStats(sessionId) {
    return this._sessionHistory.get(sessionId) || null;
  }

  getCompressor() {
    return this._compressor;
  }

  getStats() {
    const compressorStats = this._compressor.getStats();
    return {
      name: this.name,
      lastPromptTokens: this.lastPromptTokens,
      lastCompletionTokens: this.lastCompletionTokens,
      lastTotalTokens: this.lastTotalTokens,
      thresholdTokens: this.thresholdTokens,
      contextLength: this.contextLength,
      compressionCount: this.compressionCount,
      thresholdPercent: this.thresholdPercent,
      activeSessions: this._sessionHistory.size,
      cacheSize: this._compressionCache.size,
      llmSummaryEnabled: this._llmSummaryEnabled,
      llmSummaryFailCount: this._llmSummaryFailCount,
      compressorStats,
    };
  }
}

class ContextEngineRegistry {
  constructor() {
    this._engines = new Map();
    this._activeEngine = null;
  }

  register(engine) {
    if (!(engine instanceof ContextEngine)) {
      throw new Error('引擎必须继承 ContextEngine');
    }
    this._engines.set(engine.name, engine);
  }

  unregister(name) {
    this._engines.delete(name);
    if (this._activeEngine && this._activeEngine.name === name) {
      this._activeEngine = null;
    }
  }

  setActive(name) {
    const engine = this._engines.get(name);
    if (!engine) {
      throw new Error(`上下文引擎未注册: ${name}`);
    }
    this._activeEngine = engine;
    return engine;
  }

  getActive() {
    return this._activeEngine;
  }

  getRegistered() {
    return Array.from(this._engines.keys());
  }

  get(name) {
    return this._engines.get(name) || null;
  }
}

let _registry = null;

function getContextEngineRegistry() {
  if (!_registry) {
    _registry = new ContextEngineRegistry();
  }
  return _registry;
}

module.exports = {
  ContextEngine,
  ContextEngineRegistry,
  getContextEngineRegistry,
};
