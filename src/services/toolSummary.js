/**
 * Tool Summary Service
 */
class ToolSummaryService {
  constructor() {
    this._initialized = false;
    this._summaries = new Map();
  }

  async initialize() {
    this._initialized = true;
  }

  record(toolName, result, durationMs) {
    if (!this._initialized) return;
    const existing = this._summaries.get(toolName) || { count: 0, totalDuration: 0 };
    existing.count++;
    existing.totalDuration += durationMs || 0;
    existing.lastResult = typeof result === 'string' ? result.slice(0, 200) : '[non-string]';
    this._summaries.set(toolName, existing);
  }

  getSummary(toolName) {
    return this._summaries.get(toolName) || null;
  }

  getAllSummaries() {
    return Object.fromEntries(this._summaries);
  }

  shutdown() { this._initialized = false; }
}

const toolSummaryService = new ToolSummaryService();
module.exports = { toolSummaryService, ToolSummaryService };
