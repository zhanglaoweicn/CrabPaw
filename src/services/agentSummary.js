/**
 * Agent Summary Service
 */
class AgentSummaryService {
  constructor() {
    this._initialized = false;
    this._summaries = new Map();
  }

  async initialize() {
    this._initialized = true;
  }

  recordSession(agentId, summary) {
    if (!this._initialized) return;
    this._summaries.set(agentId, { summary, ts: Date.now() });
  }

  getSummary(agentId) {
    return this._summaries.get(agentId) || null;
  }

  clear() { this._summaries.clear(); }
  shutdown() { this._initialized = false; }
}

const agentSummaryService = new AgentSummaryService();
module.exports = { agentSummaryService, AgentSummaryService };
