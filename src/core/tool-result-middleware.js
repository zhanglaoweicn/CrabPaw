const { redactText } = require('./secret-redactor');
const TRUNCATION_MARKER = '\n...[结果已截断]...\n';

class ToolResultMiddleware {
  constructor() {
    this._middleware = [];
    this._middlewareById = new Map();
    this._nextId = 1;
  }

  use(middleware) {
    const id = this._nextId++;
    const entry = {
      id,
      name: middleware.name || `middleware_${id}`,
      priority: middleware.priority ?? 50,
      before: middleware.before || null,
      after: middleware.after || null,
      onError: middleware.onError || null,
      enabled: middleware.enabled !== false,
    };
    this._middleware.push(entry);
    this._middlewareById.set(id, entry);
    this._middleware.sort((a, b) => a.priority - b.priority);
    return id;
  }

  remove(id) {
    const idx = this._middleware.findIndex(m => m.id === id);
    if (idx >= 0) {
      this._middlewareById.delete(id);
      this._middleware.splice(idx, 1);
      return true;
    }
    return false;
  }

  enable(id) {
    const entry = this._middlewareById.get(id);
    if (entry) {
      entry.enabled = true;
      return true;
    }
    return false;
  }

  disable(id) {
    const entry = this._middlewareById.get(id);
    if (entry) {
      entry.enabled = false;
      return true;
    }
    return false;
  }

  async processBefore(toolName, params, context) {
    let currentParams = { ...params };
    let currentContext = { ...context };

    for (const mw of this._middleware) {
      if (!mw.enabled || !mw.before) continue;
      try {
        const result = await mw.before(toolName, currentParams, currentContext);
        if (result) {
          if (result.params) currentParams = result.params;
          if (result.context) currentContext = result.context;
          if (result.skip === true) {
            return { params: currentParams, context: currentContext, skip: true, reason: result.reason };
          }
        }
      } catch (err) {
        if (mw.onError) {
          mw.onError(err, { phase: 'before', toolName });
        }
      }
    }

    return { params: currentParams, context: currentContext, skip: false };
  }

  async processAfter(toolName, result, context) {
    let currentResult = result;
    let currentContext = { ...context };

    for (const mw of this._middleware) {
      if (!mw.enabled || !mw.after) continue;
      try {
        const modified = await mw.after(toolName, currentResult, currentContext);
        if (modified) {
          if (modified.result !== undefined) currentResult = modified.result;
          if (modified.context) currentContext = modified.context;
        }
      } catch (err) {
        if (mw.onError) {
          mw.onError(err, { phase: 'after', toolName });
        }
      }
    }

    return { result: currentResult, context: currentContext };
  }

  list() {
    return this._middleware.map(m => ({
      id: m.id,
      name: m.name,
      priority: m.priority,
      enabled: m.enabled,
      hasBefore: !!m.before,
      hasAfter: !!m.after,
    }));
  }
}

function createTruncationMiddleware(maxLength = 50000) {
  return {
    name: 'result_truncation',
    priority: 90,
    after: async (toolName, result, _context) => {
      if (typeof result !== 'string') return { result };
      if (result.length <= maxLength) return { result };

      const headLen = Math.floor(maxLength * 0.4);
      const tailLen = Math.floor(maxLength * 0.4);
      const truncated = result.slice(0, headLen) + TRUNCATION_MARKER + result.slice(-tailLen);
      return { result: truncated };
    },
  };
}

function createSensitiveDataMiddleware() {
  // 额外模式（密钥脱敏已由 secret-redactor 覆盖，此处仅保留业务特定模式）
  const patterns = [
    { re: /\b\d{16,19}\b/g, replacement: '[CARD_REDACTED]' },
    { re: /\b1[3-9]\d{9}\b/g, replacement: '[PHONE_REDACTED]' },
    { re: /\b[\w.-]+@[\w.-]+\.\w{2,}\b/g, replacement: '[EMAIL_REDACTED]' },
  ];

  return {
    name: 'sensitive_data_redaction',
    priority: 80,
    after: async (toolName, result, _context) => {
      if (typeof result !== 'string') return { result };
      let redacted = redactText(result, { force: true });
      for (const { re, replacement } of patterns) {
        redacted = redacted.replace(re, replacement);
      }
      return { result: redacted };
    },
  };
}

function createFormatNormalizationMiddleware() {
  return {
    name: 'format_normalization',
    priority: 70,
    after: async (toolName, result, _context) => {
      if (typeof result !== 'string') {
        try {
          return { result: JSON.stringify(result, null, 2) };
        } catch {
          return { result: String(result) };
        }
      }
      return { result };
    },
  };
}

function createErrorEnrichmentMiddleware() {
  return {
    name: 'error_enrichment',
    priority: 60,
    after: async (toolName, result, context) => {
      if (result && typeof result === 'object' && result.error) {
        const enriched = {
          ...result,
          error: result.error,
          tool: toolName,
          timestamp: new Date().toISOString(),
        };
        if (context && context.sessionId) {
          enriched.sessionId = context.sessionId;
        }
        return { result: enriched };
      }
      return { result };
    },
  };
}

function createMetricsMiddleware() {
  const metrics = new Map();

  return {
    name: 'tool_metrics',
    priority: 10,
    before: async (toolName, params, context) => {
      context._metricsStartTime = Date.now();
      return { params, context };
    },
    after: async (toolName, result, context) => {
      const duration = Date.now() - (context._metricsStartTime || Date.now());
      const key = toolName;
      const m = metrics.get(key) || { calls: 0, totalMs: 0, errors: 0, lastCall: 0 };
      m.calls++;
      m.totalMs += duration;
      m.lastCall = Date.now();
      if (result && typeof result === 'object' && result.error) {
        m.errors++;
      }
      metrics.set(key, m);
      return { result, context };
    },
    getMetrics: () => {
      const result = {};
      for (const [key, m] of metrics) {
        result[key] = { ...m, avgMs: m.calls > 0 ? Math.round(m.totalMs / m.calls) : 0 };
      }
      return result;
    },
  };
}

const globalToolResultMiddleware = new ToolResultMiddleware();

globalToolResultMiddleware.use(createTruncationMiddleware());
globalToolResultMiddleware.use(createSensitiveDataMiddleware());
globalToolResultMiddleware.use(createFormatNormalizationMiddleware());
globalToolResultMiddleware.use(createErrorEnrichmentMiddleware());
globalToolResultMiddleware.use(createMetricsMiddleware());

module.exports = {
  ToolResultMiddleware,
  globalToolResultMiddleware,
  createTruncationMiddleware,
  createSensitiveDataMiddleware,
  createFormatNormalizationMiddleware,
  createErrorEnrichmentMiddleware,
  createMetricsMiddleware,
  TRUNCATION_MARKER,
};
