/**
 * Agent Summary Service
 * 
 * Agent 摘要生成服务
 * 借鉴 Claude Code 的 AgentSummary/agentSummary.ts 实现
 */

const { EventEmitter } = require('events');

class AgentSummaryService extends EventEmitter {
  constructor() {
    super();
    this.initialized = false;
    this.summaries = new Map();
    this.config = {
      enabled: true,
      summaryInterval: 30000,
      maxSummaryLength: 100,
    };
    this.summaryTimers = new Map();
  }

  async initialize(config = {}) {
    if (this.initialized) {
      return;
    }

    this.config = { ...this.config, ...config };
    this.initialized = true;
    this.emit('initialized');
  }

  async shutdown() {
    if (!this.initialized) {
      return;
    }

    // eslint-disable-next-line no-unused-vars
    for (const [agentId, timer] of this.summaryTimers) {
      clearInterval(timer);
    }
    this.summaryTimers.clear();
    this.summaries.clear();
    this.initialized = false;
    this.emit('shutdown');
  }

  startSummarization(agentId, options = {}) {
    if (!this.config.enabled) {
      return { stop: () => {} };
    }

    if (this.summaryTimers.has(agentId)) {
      return { stop: () => this.stopSummarization(agentId) };
    }

    const timer = setInterval(async () => {
      await this.generateSummary(agentId, options);
    }, this.config.summaryInterval);

    this.summaryTimers.set(agentId, timer);
    this.emit('summarization:started', { agentId });

    return {
      stop: () => this.stopSummarization(agentId),
    };
  }

  stopSummarization(agentId) {
    const timer = this.summaryTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.summaryTimers.delete(agentId);
      this.emit('summarization:stopped', { agentId });
    }
  }

  async generateSummary(agentId, options = {}) {
    try {
      const previousSummary = this.summaries.get(agentId) || null;
      
      if (options.generateSummary) {
        const summary = await options.generateSummary(previousSummary);
        if (summary) {
          this.summaries.set(agentId, summary);
          this.emit('summary:generated', { agentId, summary });
          return summary;
        }
      }

      return null;
    } catch (error) {
      this.emit('error', { agentId, error });
      return null;
    }
  }

  getSummary(agentId) {
    return this.summaries.get(agentId) || null;
  }

  updateSummary(agentId, summary) {
    const truncated = summary.length > this.config.maxSummaryLength
      ? summary.slice(0, this.config.maxSummaryLength - 3) + '...'
      : summary;
    
    this.summaries.set(agentId, truncated);
    this.emit('summary:updated', { agentId, summary: truncated });
  }

  clearSummary(agentId) {
    this.summaries.delete(agentId);
    this.stopSummarization(agentId);
    this.emit('summary:cleared', { agentId });
  }

  getAllSummaries() {
    const result = {};
    for (const [agentId, summary] of this.summaries) {
      result[agentId] = summary;
    }
    return result;
  }

  getStats() {
    return {
      initialized: this.initialized,
      enabled: this.config.enabled,
      summaryCount: this.summaries.size,
      activeTimers: this.summaryTimers.size,
    };
  }
}

const agentSummaryService = new AgentSummaryService();

module.exports = {
  AgentSummaryService,
  agentSummaryService,
};
