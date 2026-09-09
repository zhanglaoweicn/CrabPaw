const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { WORKSPACE_DIR } = require('../config');

class SubagentSessionStore extends EventEmitter {
  constructor(config = {}) {
    super();
    this._sessions = new Map();
    this._workspaceDir = config.workspaceDir || WORKSPACE_DIR;
    this._persistDir = path.join(this._workspaceDir, '.crabpaw', 'sessions');
    this._maxSessions = config.maxSessions || 100;
    this._sessionTTL = config.sessionTTL || 3600000;
    this._cleanupInterval = config.cleanupInterval || 300000;
    this._timer = null;
  }

  start() {
    this._loadPersistedSessions();
    this._timer = setInterval(() => this._cleanup(), this._cleanupInterval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  createSession(options = {}) {
    const sessionId = options.sessionId || `sess_${Date.now().toString(36)}_${require('crypto').randomBytes(4).toString('hex')}`;
    const session = {
      id: sessionId,
      parentId: options.parentId || null,
      rootId: options.rootId || sessionId,
      agents: new Map(),
      context: options.context || {},
      domainId: options.domainId || null,
      capabilityId: options.capabilityId || null,
      flowId: options.flowId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'active',
      metadata: options.metadata || {},
    };

    this._sessions.set(sessionId, session);
    this.emit('session:created', { sessionId });
    return sessionId;
  }

  getSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      parentId: session.parentId,
      rootId: session.rootId,
      agentCount: session.agents.size,
      context: { ...session.context },
      domainId: session.domainId,
      capabilityId: session.capabilityId,
      flowId: session.flowId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      status: session.status,
      metadata: { ...session.metadata },
    };
  }

  updateSessionContext(sessionId, contextUpdates) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.context = { ...session.context, ...contextUpdates };
    session.updatedAt = Date.now();
    this.emit('session:updated', { sessionId });
    return true;
  }

  addAgentToSession(sessionId, agentId, agentInfo = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.agents.set(agentId, {
      id: agentId,
      ...agentInfo,
      joinedAt: Date.now(),
    });
    session.updatedAt = Date.now();
    this.emit('session:agent_added', { sessionId, agentId });
    return true;
  }

  removeAgentFromSession(sessionId, agentId) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.agents.delete(agentId);
    session.updatedAt = Date.now();
    this.emit('session:agent_removed', { sessionId, agentId });
    return true;
  }

  getSessionAgents(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return [];
    return [...session.agents.values()];
  }

  getSessionContext(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;
    return { ...session.context };
  }

  closeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.status = 'closed';
    session.updatedAt = Date.now();
    this._persistSession(session);
    this.emit('session:closed', { sessionId });
    return true;
  }

  listSessions(filter = {}) {
    let sessions = [...this._sessions.values()];

    if (filter.status) {
      sessions = sessions.filter(s => s.status === filter.status);
    }
    if (filter.domainId) {
      sessions = sessions.filter(s => s.domainId === filter.domainId);
    }
    if (filter.flowId) {
      sessions = sessions.filter(s => s.flowId === filter.flowId);
    }

    return sessions.map(s => ({
      id: s.id,
      parentId: s.parentId,
      rootId: s.rootId,
      agentCount: s.agents.size,
      domainId: s.domainId,
      capabilityId: s.capabilityId,
      flowId: s.flowId,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  _cleanup() {
    const now = Date.now();
    for (const [sessionId, session] of this._sessions) {
      if (session.status === 'active' && now - session.updatedAt > this._sessionTTL) {
        session.status = 'expired';
        this.emit('session:expired', { sessionId });
      }
    }
  }

  _persistSession(session) {
    if (!fs.existsSync(this._persistDir)) {
      fs.mkdirSync(this._persistDir, { recursive: true });
    }

    const filePath = path.join(this._persistDir, `${session.id}.json`);
    const data = {
      id: session.id,
      parentId: session.parentId,
      rootId: session.rootId,
      context: session.context,
      domainId: session.domainId,
      capabilityId: session.capabilityId,
      flowId: session.flowId,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metadata: session.metadata,
      agents: [...session.agents.entries()].map(([id, info]) => ({ id, ...info })),
    };

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch { console.warn('[subagent-session-store] silent catch, error swallowed'); }
  }

  _loadPersistedSessions() {
    if (!fs.existsSync(this._persistDir)) return;

    try {
      const files = fs.readdirSync(this._persistDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this._persistDir, file), 'utf-8');
          const data = JSON.parse(content);

          if (data && data.id) {
            const session = {
              ...data,
              agents: new Map((data.agents || []).map(a => [a.id, a])),
            };
            this._sessions.set(data.id, session);
          }
        } catch { console.warn('[subagent-session-store] silent catch, error swallowed'); }
      }
    } catch { console.warn('[subagent-session-store] silent catch, error swallowed'); }
  }
}

module.exports = { SubagentSessionStore };
