const { EventEmitter } = require('events');

const ENGINE_LIFECYCLE = {
  BOOTSTRAPPED: 'bootstrapped',
  ACTIVE: 'active',
  COMPACTING: 'compacting',
  COMPACTED: 'compacted',
  ERROR: 'error',
};

class ContextEngineV2 extends EventEmitter {
  constructor(config = {}) {
    super();
    this._engineId = config.engineId || 'base-v2';
    this._state = null;
    this._sessionId = null;
    this._sessionKey = null;
    this._sessionFile = null;
    this._messages = [];
    this._summary = null;
    this._projection = null;
    this._tokenBudget = config.tokenBudget || 128000;
    this._stats = {
      bootstraps: 0,
      ingests: 0,
      assembles: 0,
      compacts: 0,
      maintains: 0,
      afterTurns: 0,
    };
  }

  get engineId() { return this._engineId; }
  get state() { return this._state; }
  get sessionId() { return this._sessionId; }

  async bootstrap(params) {
    const { sessionId, sessionKey, sessionFile } = params;

    this._sessionId = sessionId;
    this._sessionKey = sessionKey || sessionId;
    this._sessionFile = sessionFile;
    this._messages = [];
    this._summary = null;
    this._projection = null;
    this._state = ENGINE_LIFECYCLE.BOOTSTRAPPED;
    this._stats.bootstraps++;

    const result = {
      sessionId: this._sessionId,
      sessionKey: this._sessionKey,
      state: this._state,
      restored: false,
    };

    this.emit('bootstrap', result);
    return result;
  }

  async ingest(params) {
    // eslint-disable-next-line no-unused-vars
    const { sessionId, sessionKey, message, isHeartbeat } = params;

    if (!message) {
      return { accepted: false, reason: 'null_message' };
    }

    this._messages.push({
      ...message,
      _ingestedAt: Date.now(),
      _isHeartbeat: !!isHeartbeat,
    });

    this._stats.ingests++;
    this._state = ENGINE_LIFECYCLE.ACTIVE;

    const result = {
      accepted: true,
      messageCount: this._messages.length,
      isHeartbeat: !!isHeartbeat,
    };

    this.emit('ingest', { sessionId: sessionId || this._sessionId, message, result });
    return result;
  }

  async assemble(params) {
    // eslint-disable-next-line no-unused-vars
    const { sessionId, sessionKey, messages, tokenBudget, availableTools, model, prompt } = params;

    const budget = tokenBudget || this._tokenBudget;
    const sourceMessages = messages || this._messages;

    const assembledMessages = this._applyBudget(sourceMessages, budget);

    const promptAuthority = prompt || null;
    const projection = this._projection || null;

    this._stats.assembles++;

    const result = {
      messages: assembledMessages,
      promptAuthority,
      projection,
      tokenBudget: budget,
      usedTokens: this._estimateTokens(assembledMessages),
      messageCount: assembledMessages.length,
      totalAvailable: sourceMessages.length,
      truncated: sourceMessages.length > assembledMessages.length,
    };

    this.emit('assemble', { sessionId: sessionId || this._sessionId, result });
    return result;
  }

  async compact(params) {
    // eslint-disable-next-line no-unused-vars
    const { sessionId, sessionKey, sessionFile, tokenBudget, force, abortSignal } = params;

    this._state = ENGINE_LIFECYCLE.COMPACTING;

    const budget = tokenBudget || this._tokenBudget;
    const shouldCompact = force || this._shouldCompact(budget);

    if (!shouldCompact) {
      this._state = ENGINE_LIFECYCLE.ACTIVE;
      return {
        compacted: false,
        reason: 'not_needed',
        messageCount: this._messages.length,
      };
    }

    if (abortSignal?.aborted) {
      this._state = ENGINE_LIFECYCLE.ACTIVE;
      return { compacted: false, reason: 'aborted' };
    }

    const beforeCount = this._messages.length;
    const compactedMessages = this._performCompaction(budget);

    this._messages = compactedMessages;
    this._state = ENGINE_LIFECYCLE.COMPACTED;
    this._stats.compacts++;

    const result = {
      compacted: true,
      beforeCount,
      afterCount: this._messages.length,
      tokensSaved: 0,
    };

    this.emit('compact', { sessionId: sessionId || this._sessionId, result });
    return result;
  }

  async maintain(params) {
    // eslint-disable-next-line no-unused-vars
    const { sessionId, sessionKey, transcriptRewrite } = params;

    if (transcriptRewrite && this._messages.length > 0) {
      this._messages = transcriptRewrite(this._messages);
    }

    this._stats.maintains++;

    const result = {
      maintained: true,
      messageCount: this._messages.length,
    };

    this.emit('maintain', { sessionId: sessionId || this._sessionId, result });
    return result;
  }

  async afterTurn(params) {
    // eslint-disable-next-line no-unused-vars
    const { sessionId, sessionKey, turnResult } = params;

    this._stats.afterTurns++;

    const result = {
      processed: true,
      turnNumber: this._stats.afterTurns,
    };

    this.emit('afterTurn', { sessionId: sessionId || this._sessionId, turnResult, result });
    return result;
  }

  setProjection(projection) {
    this._projection = projection;
  }

  getProjection() {
    return this._projection;
  }

  getMessages() {
    return [...this._messages];
  }

  getMessageCount() {
    return this._messages.length;
  }

  _applyBudget(messages, budget) {
    const estimated = this._estimateTokens(messages);
    if (estimated <= budget) return messages;

    const ratio = budget / estimated;
    const keepCount = Math.max(1, Math.floor(messages.length * ratio));

    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const keepNonSystem = Math.max(1, keepCount - systemMessages.length);
    const kept = nonSystemMessages.slice(-keepNonSystem);

    return [...systemMessages, ...kept];
  }

  _shouldCompact(budget) {
    const estimated = this._estimateTokens(this._messages);
    return estimated > budget * 0.8;
  }

  _performCompaction(_budget) {
    if (this._messages.length <= 2) return this._messages;

    const systemMessages = this._messages.filter(m => m.role === 'system');
    const nonSystemMessages = this._messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= 4) return this._messages;

    const kept = nonSystemMessages.slice(-4);
    const removed = nonSystemMessages.slice(0, -4);

    const summaryMessage = {
      role: 'system',
      content: `[上下文摘要] 之前的 ${removed.length} 条消息已被压缩。` +
        (this._summary ? ` 摘要: ${this._summary}` : ''),
      _compacted: true,
      _compactedFrom: removed.length,
    };

    return [...systemMessages, summaryMessage, ...kept];
  }

  _estimateTokens(messages) {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      total += Math.ceil(content.length / 3.5);
    }
    return total;
  }

  getStats() {
    return {
      ...this._stats,
      engineId: this._engineId,
      state: this._state,
      sessionId: this._sessionId,
      messageCount: this._messages.length,
      tokenBudget: this._tokenBudget,
    };
  }
}

ContextEngineV2.ENGINE_LIFECYCLE = ENGINE_LIFECYCLE;

module.exports = { ContextEngineV2, ENGINE_LIFECYCLE };
