const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ContextPipeline } = require('./pipeline');

const SESSION_MEMORY_EXTRACTION_PROMPT = `Analyze the following conversation segment and extract key information that should be preserved as long-term memory.

Focus on:
1. User preferences and patterns
2. Important decisions and their rationale
3. Technical context (tools, frameworks, configurations)
4. Unresolved questions or action items
5. Key facts about the user or project

Respond in JSON format:
{
  "facts": [{"content": "...", "category": "preference|decision|technical|question|fact", "importance": 0.0-1.0}],
  "summary": "Brief summary of the conversation segment"
}`;

class UnifiedContextManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._pipeline = new ContextPipeline(config);
    this._store = config.store || null;
    this._embeddingRouter = config.embeddingRouter || null;
    this._namespaceManager = config.namespaceManager || null;
    this._model = config.model || null;

    this._segmentBuffer = [];
    this._segmentMaxTurns = config.segmentMaxTurns || 20;
    this._segmentMaxTokens = config.segmentMaxTokens || 50000;

    this._sessionMemoryConfig = {
      minTurns: config.sessionMemoryMinTurns || 5,
      minTokens: config.sessionMemoryMinTokens || 10000,
      minToolCalls: config.sessionMemoryMinToolCalls || 3,
      autoExtract: config.sessionMemoryAutoExtract !== false,
    };

    this._stats = {
      segmentsCreated: 0,
      memoriesExtracted: 0,
      autocompactions: 0,
    };
  }

  get pipeline() {
    return this._pipeline;
  }

  get guard() {
    return this._pipeline.guard;
  }

  setStore(store) {
    this._store = store;
  }

  setModel(model) {
    this._model = model;
  }

  setEmbeddingRouter(router) {
    this._embeddingRouter = router;
  }

  recordUsage(usage) {
    this._pipeline.recordUsage(usage);
  }

  tickTurn(toolCallCount = 0) {
    this._pipeline.tickTurn();
    this._pipeline.recordToolCalls(toolCallCount);
  }

  runBeforeCall(messages) {
    const result = this._pipeline.runBeforeCall(messages);

    if (this._pipeline.shouldExtractSessionMemory()) {
      this.emit('session_memory:extraction_needed', {
        turn: this._pipeline.sessionMemory.currentTurn,
        tokens: this._pipeline.sessionMemory.totalTokens,
      });
    }

    return result;
  }

  async executeAutocompact(messages) {
    const result = await this._pipeline.executeAutocompact(messages);
    if (result.compressed) {
      this._stats.autocompactions++;
    }
    return result;
  }

  async extractSessionMemory(messages, sessionId, namespace = 'global') {
    if (!this._store || messages.length < 3) return null;

    const segment = this._buildSegment(messages, sessionId, namespace);

    if (this._model && this._sessionMemoryConfig.autoExtract) {
      try {
        const extraction = await this._extractMemoriesFromSegment(messages);
        if (extraction && extraction.facts) {
          for (const fact of extraction.facts) {
            this._store.addMemory({
              type: fact.category || 'general',
              title: fact.content.slice(0, 80),
              content: fact.content,
              importance: fact.importance || 0.5,
              source: 'session_extraction',
              namespace,
            });
            this._stats.memoriesExtracted++;
          }
        }

        if (extraction && extraction.summary) {
          segment.summary = extraction.summary;
        }
      } catch (e) {
        this.emit('session_memory:extraction_error', { error: e.message });
      }
    }

    if (this._embeddingRouter && segment.summary) {
      try {
        const embedding = await this._embeddingRouter.embed(segment.summary);
        const { embeddingToBuffer } = require('../memory/embedding-router');
        segment.embedding = embeddingToBuffer(embedding);
      } catch { console.warn('[unified-context-manager] 嵌入向量生成失败'); }
    }

    this._store.upsertConversationSegment(segment);
    this._stats.segmentsCreated++;

    this._pipeline.sessionMemory.markExtracted();

    this.emit('session_memory:extracted', {
      sessionId,
      segmentId: segment.id,
      factsExtracted: this._stats.memoriesExtracted,
    });

    return segment;
  }

  _buildSegment(messages, sessionId, namespace) {
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');
    const toolMessages = messages.filter(m => m.role === 'tool');

    const totalTokens = messages.reduce((sum, m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      return sum + Math.ceil(content.length / 4);
    }, 0);

    return {
      id: `seg_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
      session_id: sessionId,
      namespace,
      start_message_id: messages[0]?.id || null,
      end_message_id: messages[messages.length - 1]?.id || null,
      summary: null,
      embedding: null,
      topic_tags: [],
      turn_count: userMessages.length,
      token_count: totalTokens,
      metadata: {
        userMessages: userMessages.length,
        assistantMessages: assistantMessages.length,
        toolMessages: toolMessages.length,
      },
    };
  }

  async _extractMemoriesFromSegment(messages) {
    if (!this._model) return null;

    try {
      const conversationText = messages
        .slice(-20)
        .map(m => {
          const role = m.role || 'unknown';
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return `[${role}] ${content.slice(0, 300)}`;
        })
        .join('\n');

      const response = await this._model.chat.completions.create({
        model: this._model.model || 'default',
        messages: [
          { role: 'system', content: SESSION_MEMORY_EXTRACTION_PROMPT },
          { role: 'user', content: conversationText },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      });

      const content = response.choices?.[0]?.message?.content || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  getStats() {
    return {
      ...this._stats,
      pipeline: this._pipeline.getStats(),
    };
  }
}

class ConversationBoundaryDetector {
  static detectBoundaries(messages) {
    const boundaries = [];
    let currentStart = 0;
    let lastTopic = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;

      const content = typeof msg.content === 'string' ? msg.content : '';
      const topic = ConversationBoundaryDetector._inferTopic(content);

      if (lastTopic && topic !== lastTopic) {
        const gap = i - currentStart;
        if (gap >= 3) {
          boundaries.push({
            startIndex: currentStart,
            endIndex: i - 1,
            topic: lastTopic,
            turnCount: Math.floor(gap / 2),
          });
          currentStart = i;
        }
      }

      lastTopic = topic;
    }

    if (currentStart < messages.length - 1) {
      boundaries.push({
        startIndex: currentStart,
        endIndex: messages.length - 1,
        topic: lastTopic || 'general',
        turnCount: Math.floor((messages.length - currentStart) / 2),
      });
    }

    return boundaries;
  }

  static _inferTopic(content) {
    if (/\b(code|implement|fix|bug|feature|function|class|module|api)\b/i.test(content)) return 'coding';
    if (/\b(analyze|research|investigate|explore|search)\b/i.test(content)) return 'research';
    if (/\b(plan|design|architect|organize|schedule)\b/i.test(content)) return 'planning';
    if (/\b(test|verify|check|validate|review)\b/i.test(content)) return 'verification';
    if (/\b(learn|explain|teach|understand|how)\b/i.test(content)) return 'learning';
    if (/\b(config|setup|install|deploy|environment)\b/i.test(content)) return 'configuration';
    return 'general';
  }
}

let _instance = null;

function getUnifiedContextManager(config) {
  if (!_instance) {
    _instance = new UnifiedContextManager(config);
  }
  return _instance;
}

module.exports = {
  UnifiedContextManager,
  ConversationBoundaryDetector,
  getUnifiedContextManager,
  SESSION_MEMORY_EXTRACTION_PROMPT,
};
