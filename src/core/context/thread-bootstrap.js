class ThreadBootstrapProjection {
  constructor(config = {}) {
    this._projectionId = config.projectionId || 'thread-bootstrap';
    this._bootstrapContent = config.bootstrapContent || '';
    this._persistAcrossSessions = config.persistAcrossSessions || false;
    this._maxProjectionTokens = config.maxProjectionTokens || 2000;
    this._projectionCache = new Map();
  }

  createProjection(params) {
    const { sessionId, sessionKey, messages, summary } = params;

    const projection = {
      projectionId: this._projectionId,
      sessionId,
      sessionKey,
      bootstrapContent: this._bootstrapContent,
      summary: summary || null,
      keyFacts: this._extractKeyFacts(messages),
      activeTools: this._extractActiveTools(messages),
      createdAt: Date.now(),
    };

    this._projectionCache.set(sessionKey || sessionId, projection);
    return projection;
  }

  applyProjection(messages, projection) {
    if (!projection) return messages;

    const projectionMessages = [];

    if (projection.bootstrapContent) {
      projectionMessages.push({
        role: 'system',
        content: projection.bootstrapContent,
        _projection: true,
      });
    }

    if (projection.summary) {
      projectionMessages.push({
        role: 'system',
        content: `[线程引导摘要] ${projection.summary}`,
        _projection: true,
        _projectionType: 'thread-bootstrap',
      });
    }

    if (projection.keyFacts.length > 0) {
      projectionMessages.push({
        role: 'system',
        content: `[关键事实]\n${projection.keyFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}`,
        _projection: true,
        _projectionType: 'key-facts',
      });
    }

    return [...projectionMessages, ...messages];
  }

  getProjection(sessionKey) {
    return this._projectionCache.get(sessionKey) || null;
  }

  updateProjection(sessionKey, updates) {
    const existing = this._projectionCache.get(sessionKey);
    if (!existing) return null;

    Object.assign(existing, updates, { updatedAt: Date.now() });
    return existing;
  }

  removeProjection(sessionKey) {
    return this._projectionCache.delete(sessionKey);
  }

  _extractKeyFacts(messages) {
    const facts = [];
    const systemMessages = messages.filter(m => m.role === 'system');

    for (const msg of systemMessages.slice(-3)) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines.slice(0, 5)) {
        if (line.length > 10 && line.length < 200) {
          facts.push(line.trim());
        }
      }
    }

    return facts.slice(0, 10);
  }

  _extractActiveTools(messages) {
    const tools = new Set();
    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.name) tools.add(tc.function.name);
        }
      }
    }
    return Array.from(tools);
  }

  getStats() {
    return {
      projectionId: this._projectionId,
      cachedProjections: this._projectionCache.size,
      persistAcrossSessions: this._persistAcrossSessions,
    };
  }
}

module.exports = { ThreadBootstrapProjection };
