const { EventEmitter } = require('events');
const crypto = require('crypto');

const ACP_MESSAGE_TYPES = {
  TASK_DELEGATE: 'task_delegate',
  TASK_RESULT: 'task_result',
  TASK_ERROR: 'task_error',
  CONTEXT_SHARE: 'context_share',
  CONTEXT_REQUEST: 'context_request',
  HEARTBEAT: 'heartbeat',
  COORDINATION: 'coordination',
  BROADCAST: 'broadcast',
};

const ACP_MESSAGE_PRIORITIES = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  URGENT: 3,
};

class ACPMessage {
  constructor(options = {}) {
    this.id = options.id || `acp_${crypto.randomUUID().slice(0, 12)}`;
    this.type = options.type || ACP_MESSAGE_TYPES.COORDINATION;
    this.from = options.from || 'unknown';
    this.to = options.to || '*';
    this.payload = options.payload || {};
    this.priority = options.priority ?? ACP_MESSAGE_PRIORITIES.NORMAL;
    this.timestamp = options.timestamp || Date.now();
    this.ttl = options.ttl || 60000;
    this.correlationId = options.correlationId || null;
    this.sessionId = options.sessionId || null;
    this.metadata = options.metadata || {};
  }

  isExpired() {
    return Date.now() - this.timestamp > this.ttl;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      from: this.from,
      to: this.to,
      payload: this.payload,
      priority: this.priority,
      timestamp: this.timestamp,
      ttl: this.ttl,
      correlationId: this.correlationId,
      sessionId: this.sessionId,
      metadata: this.metadata,
    };
  }

  static fromJSON(data) {
    return new ACPMessage(data);
  }
}

class ACPLiteProtocol extends EventEmitter {
  constructor(config = {}) {
    super();
    this._agents = new Map();
    this._messageQueue = [];
    this._maxQueueSize = config.maxQueueSize || 1000;
    this._processingInterval = config.processingInterval || 50;
    this._timer = null;
    this._sessionId = config.sessionId || `session_${Date.now()}`;
    this._messageHandlers = new Map();
    this._pendingRequests = new Map();
    this._requestTimeout = config.requestTimeout || 30000;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._timer = setInterval(() => this._processQueue(), this._processingInterval);
    this.emit('protocol:started', { sessionId: this._sessionId });
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.emit('protocol:stopped', { sessionId: this._sessionId });
  }

  registerAgent(agentId, agentInfo = {}) {
    this._agents.set(agentId, {
      id: agentId,
      info: agentInfo,
      registeredAt: Date.now(),
      lastHeartbeat: Date.now(),
      status: 'active',
    });
    this.emit('agent:registered', { agentId });
  }

  unregisterAgent(agentId) {
    this._agents.delete(agentId);
    this.emit('agent:unregistered', { agentId });
  }

  getAgent(agentId) {
    return this._agents.get(agentId) || null;
  }

  listAgents() {
    return [...this._agents.values()];
  }

  send(message) {
    if (!(message instanceof ACPMessage)) {
      message = new ACPMessage(message);
    }

    if (message.isExpired()) {
      this.emit('message:expired', { messageId: message.id });
      return false;
    }

    if (this._messageQueue.length >= this._maxQueueSize) {
      this._messageQueue.shift();
      this.emit('queue:overflow', { messageId: message.id });
    }

    this._messageQueue.push(message);
    this._messageQueue.sort((a, b) => b.priority - a.priority);

    this.emit('message:queued', { messageId: message.id, type: message.type });
    return true;
  }

  delegateTask(fromAgentId, toAgentId, task, options = {}) {
    const message = new ACPMessage({
      type: ACP_MESSAGE_TYPES.TASK_DELEGATE,
      from: fromAgentId,
      to: toAgentId,
      payload: {
        task,
        domainId: options.domainId,
        capabilityId: options.capabilityId,
        constraints: options.constraints,
        maxIterations: options.maxIterations,
      },
      priority: options.priority ?? ACP_MESSAGE_PRIORITIES.NORMAL,
      sessionId: options.sessionId || this._sessionId,
      correlationId: options.correlationId || `req_${Date.now()}`,
    });

    this.send(message);
    return message.correlationId;
  }

  reportResult(fromAgentId, toAgentId, result, correlationId) {
    const message = new ACPMessage({
      type: ACP_MESSAGE_TYPES.TASK_RESULT,
      from: fromAgentId,
      to: toAgentId,
      payload: { result },
      correlationId,
      sessionId: this._sessionId,
    });

    this.send(message);
  }

  reportError(fromAgentId, toAgentId, error, correlationId) {
    const message = new ACPMessage({
      type: ACP_MESSAGE_TYPES.TASK_ERROR,
      from: fromAgentId,
      to: toAgentId,
      payload: { error: typeof error === 'string' ? error : error.message },
      correlationId,
      sessionId: this._sessionId,
      priority: ACP_MESSAGE_PRIORITIES.HIGH,
    });

    this.send(message);
  }

  shareContext(fromAgentId, toAgentId, contextData) {
    const message = new ACPMessage({
      type: ACP_MESSAGE_TYPES.CONTEXT_SHARE,
      from: fromAgentId,
      to: toAgentId,
      payload: { context: contextData },
      sessionId: this._sessionId,
    });

    this.send(message);
  }

  broadcast(fromAgentId, payload) {
    const message = new ACPMessage({
      type: ACP_MESSAGE_TYPES.BROADCAST,
      from: fromAgentId,
      to: '*',
      payload,
      sessionId: this._sessionId,
    });

    this.send(message);
  }

  heartbeat(agentId) {
    const agent = this._agents.get(agentId);
    if (agent) {
      agent.lastHeartbeat = Date.now();
      agent.status = 'active';
    }

    this.send(new ACPMessage({
      type: ACP_MESSAGE_TYPES.HEARTBEAT,
      from: agentId,
      to: '*',
      payload: { status: 'alive' },
    }));
  }

  onMessage(type, handler) {
    if (!this._messageHandlers.has(type)) {
      this._messageHandlers.set(type, []);
    }
    this._messageHandlers.get(type).push(handler);
  }

  _processQueue() {
    while (this._messageQueue.length > 0) {
      const message = this._messageQueue.shift();
      if (message.isExpired()) continue;
      this._dispatchMessage(message);
    }

    this._checkAgentHealth();
  }

  _dispatchMessage(message) {
    this.emit('message:dispatch', { messageId: message.id, type: message.type, from: message.from, to: message.to });

    const handlers = this._messageHandlers.get(message.type) || [];
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (e) {
        this.emit('handler:error', { messageId: message.id, error: e.message });
      }
    }

    if (message.to === '*') {
      this.emit('broadcast', message);
    } else {
      this.emit(`message:${message.to}`, message);
    }

    this.emit(`type:${message.type}`, message);
  }

  _checkAgentHealth() {
    const now = Date.now();
    const heartbeatThreshold = 120000;

    for (const [agentId, agent] of this._agents) {
      if (now - agent.lastHeartbeat > heartbeatThreshold && agent.status === 'active') {
        agent.status = 'unhealthy';
        this.emit('agent:unhealthy', { agentId, lastHeartbeat: agent.lastHeartbeat });
      }
    }
  }

  getQueueSize() {
    return this._messageQueue.length;
  }

  getSessionId() {
    return this._sessionId;
  }

  async request(fromAgentId, toAgentId, payload, options = {}) {
    const correlationId = options.correlationId || `req_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const timeout = options.timeout || this._requestTimeout;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(correlationId);
        reject(new Error(`ACP request timeout (${timeout}ms): ${fromAgentId} -> ${toAgentId}`));
      }, timeout);

      this._pendingRequests.set(correlationId, { resolve, reject, timer });

      const message = new ACPMessage({
        type: ACP_MESSAGE_TYPES.TASK_DELEGATE,
        from: fromAgentId,
        to: toAgentId,
        payload,
        correlationId,
        sessionId: options.sessionId || this._sessionId,
        priority: options.priority ?? ACP_MESSAGE_PRIORITIES.NORMAL,
      });

      this.send(message);
    });
  }

  async respond(correlationId, fromAgentId, toAgentId, result) {
    const pending = this._pendingRequests.get(correlationId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(result);
      this._pendingRequests.delete(correlationId);
    }

    this.reportResult(fromAgentId, toAgentId, result, correlationId);
  }

  async requestApproval(fromAgentId, toAgentId, action, details, options = {}) {
    return this.request(fromAgentId, toAgentId, {
      action,
      details,
      requiresApproval: true,
    }, {
      ...options,
      type: ACP_MESSAGE_TYPES.COORDINATION,
      timeout: options.timeout || 120000,
    });
  }

  createStream(fromAgentId, toAgentId, options = {}) {
    const streamId = `stream_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const correlationId = options.correlationId || streamId;

    return {
      streamId,
      write: (chunk) => {
        this.send(new ACPMessage({
          type: ACP_MESSAGE_TYPES.CONTEXT_SHARE,
          from: fromAgentId,
          to: toAgentId,
          payload: { streamId, chunk, done: false },
          correlationId,
          sessionId: this._sessionId,
        }));
      },
      end: (finalChunk) => {
        this.send(new ACPMessage({
          type: ACP_MESSAGE_TYPES.CONTEXT_SHARE,
          from: fromAgentId,
          to: toAgentId,
          payload: { streamId, chunk: finalChunk || null, done: true },
          correlationId,
          sessionId: this._sessionId,
        }));
      },
      error: (err) => {
        this.reportError(fromAgentId, toAgentId, err, correlationId);
      },
    };
  }

  getStats() {
    return {
      agents: this._agents.size,
      queueSize: this._messageQueue.length,
      pendingRequests: this._pendingRequests.size,
      messageHandlers: [...this._messageHandlers.entries()].reduce((acc, [type, handlers]) => {
        acc[type] = handlers.length;
        return acc;
      }, {}),
      sessionId: this._sessionId,
      started: this._started,
    };
  }
}

module.exports = {
  ACPLiteProtocol,
  ACPMessage,
  ACP_MESSAGE_TYPES,
  ACP_MESSAGE_PRIORITIES,
};
