const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { WORKSPACE_DIR } = require('../config');

const EVENT_TYPES = {
  AGENT_SPAWNED: 'agent_spawned',
  AGENT_COMPLETED: 'agent_completed',
  AGENT_FAILED: 'agent_failed',
  TASK_DELEGATED: 'task_delegated',
  TASK_RESULT: 'task_result',
  CONTEXT_SHARED: 'context_shared',
  FLOW_STARTED: 'flow_started',
  FLOW_COMPLETED: 'flow_completed',
  FLOW_FAILED: 'flow_failed',
  EVOLUTION_TRIGGERED: 'evolution_triggered',
  EVOLUTION_APPLIED: 'evolution_applied',
  DOMAIN_ACTIVATED: 'domain_activated',
  DOMAIN_DEACTIVATED: 'domain_deactivated',
  PROFILE_UPDATED: 'profile_updated',
};

class AgentEventLedger extends EventEmitter {
  constructor(config = {}) {
    super();
    this._events = [];
    this._workspaceDir = config.workspaceDir || WORKSPACE_DIR;
    this._ledgerDir = path.join(this._workspaceDir, '.crabpaw', 'ledger');
    this._maxEvents = config.maxEvents || 10000;
    this._persistBatchSize = config.persistBatchSize || 100;
    this._dirtyCount = 0;
    this._currentIndex = 0;
  }

  record(eventType, data = {}) {
    const entry = {
      index: this._currentIndex++,
      type: eventType,
      timestamp: Date.now(),
      agentId: data.agentId || null,
      sessionId: data.sessionId || null,
      domainId: data.domainId || null,
      capabilityId: data.capabilityId || null,
      flowId: data.flowId || null,
      data: data.data || data,
    };

    this._events.push(entry);

    if (this._events.length > this._maxEvents) {
      this._events = this._events.slice(-this._maxEvents);
    }

    this._dirtyCount++;
    if (this._dirtyCount >= this._persistBatchSize) {
      this.persist();
    }

    this.emit('event:recorded', { type: eventType, index: entry.index });
    return entry.index;
  }

  query(filter = {}) {
    let results = [...this._events];

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      results = results.filter(e => types.includes(e.type));
    }
    if (filter.agentId) {
      results = results.filter(e => e.agentId === filter.agentId);
    }
    if (filter.sessionId) {
      results = results.filter(e => e.sessionId === filter.sessionId);
    }
    if (filter.domainId) {
      results = results.filter(e => e.domainId === filter.domainId);
    }
    if (filter.since) {
      results = results.filter(e => e.timestamp >= filter.since);
    }
    if (filter.until) {
      results = results.filter(e => e.timestamp <= filter.until);
    }

    if (filter.limit) {
      results = results.slice(-filter.limit);
    }

    return results;
  }

  getEventByIndex(index) {
    return this._events.find(e => e.index === index) || null;
  }

  getRecentEvents(limit = 50) {
    return this._events.slice(-limit);
  }

  getEventsByAgent(agentId, limit = 50) {
    return this.query({ agentId, limit });
  }

  getEventsBySession(sessionId, limit = 50) {
    return this.query({ sessionId, limit });
  }

  getEventCounts(since = null) {
    const events = since ? this._events.filter(e => e.timestamp >= since) : this._events;
    const counts = {};

    for (const event of events) {
      counts[event.type] = (counts[event.type] || 0) + 1;
    }

    return counts;
  }

  getAgentActivityTimeline(agentId, limit = 20) {
    return this.query({ agentId, limit })
      .map(e => ({
        time: e.timestamp,
        type: e.type,
        summary: this._summarizeEvent(e),
      }));
  }

  _summarizeEvent(event) {
    switch (event.type) {
      case EVENT_TYPES.AGENT_SPAWNED:
        return `Agent ${event.agentId} spawned`;
      case EVENT_TYPES.AGENT_COMPLETED:
        return `Agent ${event.agentId} completed`;
      case EVENT_TYPES.AGENT_FAILED:
        return `Agent ${event.agentId} failed`;
      case EVENT_TYPES.TASK_DELEGATED:
        return `Task delegated to ${event.agentId}`;
      case EVENT_TYPES.FLOW_STARTED:
        return `Flow ${event.flowId} started`;
      case EVENT_TYPES.FLOW_COMPLETED:
        return `Flow ${event.flowId} completed`;
      case EVENT_TYPES.EVOLUTION_TRIGGERED:
        return `Evolution triggered`;
      default:
        return event.type;
    }
  }

  persist() {
    if (!fs.existsSync(this._ledgerDir)) {
      fs.mkdirSync(this._ledgerDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this._ledgerDir, `ledger_${dateStr}.jsonl`);

    try {
      const newEvents = this._events.slice(-this._dirtyCount);
      const lines = newEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(filePath, lines, 'utf-8');
      this._dirtyCount = 0;
    } catch { console.warn('[agent-event-ledger] silent catch, error swallowed'); }
  }

  load(dateStr = null) {
    if (!fs.existsSync(this._ledgerDir)) return;

    try {
      const targetDate = dateStr || new Date().toISOString().slice(0, 10);
      const filePath = path.join(this._ledgerDir, `ledger_${targetDate}.jsonl`);

      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          this._events.push(entry);
          this._currentIndex = Math.max(this._currentIndex, entry.index + 1);
        } catch { console.warn('[agent-event-ledger] silent catch, error swallowed'); }
      }

      if (this._events.length > this._maxEvents) {
        this._events = this._events.slice(-this._maxEvents);
      }
    } catch { console.warn('[agent-event-ledger] silent catch, error swallowed'); }
  }

  getStats() {
    const counts = this.getEventCounts();
    const total = this._events.length;

    const timeRange = total > 0 ? {
      earliest: this._events[0]?.timestamp,
      latest: this._events[total - 1]?.timestamp,
    } : null;

    return {
      total,
      counts,
      timeRange,
      dirtyCount: this._dirtyCount,
    };
  }
}

module.exports = { AgentEventLedger, EVENT_TYPES };
