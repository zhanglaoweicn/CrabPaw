const { EventEmitter } = require('events');

const ENGINE_TYPES = {
  COMPRESSOR: 'compressor',
  LCM: 'lcm',
  SLIDING: 'sliding',
  HYBRID: 'hybrid',
};

class ContextEnginePlugin extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.name = opts.name || 'unknown';
    this.type = opts.type || ENGINE_TYPES.COMPRESSOR;
    this.thresholdPercent = opts.thresholdPercent || 0.75;
    this.protectFirstN = opts.protectFirstN || 3;
    this.protectLastN = opts.protectLastN || 6;
    this.lastPromptTokens = 0;
    this.lastCompletionTokens = 0;
    this.lastTotalTokens = 0;
    this.thresholdTokens = 0;
    this.contextLength = opts.contextLength || 128000;
    this.compressionCount = 0;
  }

  async onSessionStart(_sessionId) {}
  async onSessionEnd(_sessionId) {}

  updateFromResponse(usage) {
    if (!usage) return;
    this.lastPromptTokens = usage.prompt_tokens || this.lastPromptTokens;
    this.lastCompletionTokens = usage.completion_tokens || this.lastCompletionTokens;
    this.lastTotalTokens = usage.total_tokens || (this.lastPromptTokens + this.lastCompletionTokens);
    this.thresholdTokens = Math.floor(this.contextLength * this.thresholdPercent);
  }

  shouldCompress(promptTokens) {
    const tokens = promptTokens || this.lastPromptTokens;
    return tokens >= this.thresholdTokens;
  }

  // eslint-disable-next-line no-unused-vars
  async compress(messages, opts = {}) {
    throw new Error('compress() must be implemented by subclass');
  }

  getTools() {
    return [];
  }

  getState() {
    return {
      name: this.name,
      type: this.type,
      lastPromptTokens: this.lastPromptTokens,
      lastCompletionTokens: this.lastCompletionTokens,
      lastTotalTokens: this.lastTotalTokens,
      thresholdTokens: this.thresholdTokens,
      contextLength: this.contextLength,
      compressionCount: this.compressionCount,
      thresholdPercent: this.thresholdPercent,
    };
  }
}

class CompressorEngine extends ContextEnginePlugin {
  constructor(opts = {}) {
    super({ ...opts, name: 'compressor', type: ENGINE_TYPES.COMPRESSOR });
    this._summarizeFn = opts.summarizeFn || null;
    this._maxSummaryTokens = opts.maxSummaryTokens || 2000;
  }

  // eslint-disable-next-line no-unused-vars
  async compress(messages, opts = {}) {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= this.protectFirstN + this.protectLastN) {
      return messages;
    }

    const protectedFirst = nonSystemMessages.slice(0, this.protectFirstN);
    const protectedLast = nonSystemMessages.slice(-this.protectLastN);
    const middleMessages = nonSystemMessages.slice(this.protectFirstN, -this.protectLastN);

    let summary;
    if (this._summarizeFn) {
      try {
        const middleContent = middleMessages
          .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
          .join('\n');
        summary = await this._summarizeFn(middleContent, {
          maxTokens: this._maxSummaryTokens,
          context: 'conversation_compression',
        });
      } catch (e) {
        summary = this._extractKeyPoints(middleMessages);
      }
    } else {
      summary = this._extractKeyPoints(middleMessages);
    }

    this.compressionCount++;

    const summaryMessage = {
      role: 'system',
      content: `[Earlier conversation summary]\n${summary}`,
    };

    return [...systemMessages, ...protectedFirst, summaryMessage, ...protectedLast];
  }

  _extractKeyPoints(messages) {
    const points = [];
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length === 0) continue;

      const sentences = content.split(/[.!?。！？\n]/).filter(s => s.trim().length > 10);
      const keySentences = sentences.slice(0, 2);
      if (keySentences.length > 0) {
        points.push(keySentences.join('. '));
      }

      if (points.length >= 10) break;
    }
    return points.join('\n');
  }
}

class SlidingWindowEngine extends ContextEnginePlugin {
  constructor(opts = {}) {
    super({ ...opts, name: 'sliding', type: ENGINE_TYPES.SLIDING });
    this.windowSize = opts.windowSize || 50;
  }

  // eslint-disable-next-line no-unused-vars
  async compress(messages, opts = {}) {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    if (nonSystemMessages.length <= this.windowSize) {
      return messages;
    }

    const kept = nonSystemMessages.slice(-this.windowSize);
    this.compressionCount++;

    return [...systemMessages, ...kept];
  }
}

class HybridContextEngine extends ContextEnginePlugin {
  constructor(opts = {}) {
    super({ ...opts, name: 'hybrid', type: ENGINE_TYPES.HYBRID });
    this._compressor = new CompressorEngine(opts);
    this._slider = new SlidingWindowEngine(opts);
    this._strategy = opts.strategy || 'adaptive';
  }

  async compress(messages, opts = {}) {
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    const overflow = nonSystemMessages.length - (this.protectFirstN + this.protectLastN);

    if (this._strategy === 'adaptive') {
      if (overflow > 30) {
        return this._compressor.compress(messages, opts);
      } else {
        return this._slider.compress(messages, opts);
      }
    }

    if (this._strategy === 'compress_first') {
      return this._compressor.compress(messages, opts);
    }

    return this._slider.compress(messages, opts);
  }
}

class ContextEngineRegistry {
  constructor() {
    this._engines = new Map();
    this._activeEngine = null;

    this.register(new CompressorEngine());
    this.register(new SlidingWindowEngine());
    this.register(new HybridContextEngine());
  }

  register(engine) {
    if (!(engine instanceof ContextEnginePlugin)) {
      throw new Error('Engine must extend ContextEnginePlugin');
    }
    this._engines.set(engine.name, engine);
  }

  setActive(name) {
    const engine = this._engines.get(name);
    if (!engine) throw new Error(`Unknown context engine: ${name}`);
    this._activeEngine = engine;
    return engine;
  }

  getActive() {
    return this._activeEngine || this._engines.get('compressor');
  }

  listEngines() {
    return Array.from(this._engines.keys());
  }

  getEngine(name) {
    return this._engines.get(name);
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
  ContextEnginePlugin,
  CompressorEngine,
  SlidingWindowEngine,
  HybridContextEngine,
  ContextEngineRegistry,
  ENGINE_TYPES,
  getContextEngineRegistry,
};
