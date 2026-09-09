const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RPC_SOCKET_DIR = os.platform() === 'win32'
  ? '\\\\.\\pipe\\crabpaw'
  : path.join(os.homedir(), '.crabpaw', 'rpc');
const RPC_MAGIC = 'CRPC';
const RPC_VERSION = 1;
const RPC_MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

const RPC_MESSAGE_TYPE = {
  REQUEST: 0x01,
  RESPONSE: 0x02,
  NOTIFICATION: 0x03,
  ERROR: 0x04,
  HEARTBEAT: 0x05
};

const RPC_METHOD = {
  PING: 'ping',
  EXECUTE_STEP: 'execute_step',
  GET_STATUS: 'get_status',
  CANCEL: 'cancel',
  PUSH_CONTEXT: 'push_context',
  GET_RESULT: 'get_result',
  TERMINAL_INPUT: 'terminal_input',
  TERMINAL_OUTPUT: 'terminal_output',
  SPAWN_SUB_AGENT: 'spawn_sub_agent',
  LIST_SUB_AGENTS: 'list_sub_agents'
};

class RpcMessage {
  constructor(type, method, params, id) {
    this.type = type;
    this.method = method;
    this.params = params || {};
    this.id = id || RpcMessage.generateId();
    this.timestamp = Date.now();
  }

  static generateId() {
    return crypto.randomBytes(8).toString('hex');
  }

  serialize() {
    const payload = JSON.stringify({
      type: this.type,
      method: this.method,
      params: this.params,
      id: this.id,
      timestamp: this.timestamp
    });
    const header = Buffer.alloc(12);
    header.write(RPC_MAGIC, 0, 4, 'ascii');
    header.writeUInt32BE(RPC_VERSION, 4);
    header.writeUInt32BE(payload.length, 8);
    return Buffer.concat([header, Buffer.from(payload, 'utf-8')]);
  }

  static deserialize(buffer) {
    if (buffer.length < 12) return null;

    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== RPC_MAGIC) {
      throw new Error(`Invalid RPC magic: ${magic}`);
    }

    const version = buffer.readUInt32BE(4);
    if (version !== RPC_VERSION) {
      throw new Error(`Unsupported RPC version: ${version}`);
    }

    const payloadLength = buffer.readUInt32BE(8);
    if (buffer.length < 12 + payloadLength) return null;

    const payload = buffer.toString('utf-8', 12, 12 + payloadLength);
    const data = JSON.parse(payload);

    const msg = new RpcMessage(data.type, data.method, data.params, data.id);
    msg.timestamp = data.timestamp;
    return msg;
  }

  static headerSize() {
    return 12;
  }

  static payloadLengthFromHeader(buffer) {
    if (buffer.length < 12) return -1;
    return buffer.readUInt32BE(8);
  }
}

class RpcTransport extends EventEmitter {
  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
    this._server = null;
    this._connections = new Map();
    this._pendingRequests = new Map();
    this._requestTimeout = 30000;
    this._buffer = Buffer.alloc(0);
  }

  async startServer() {
    this._ensureSocketDir();

    if (fs.existsSync(this.socketPath)) {
      try { fs.unlinkSync(this.socketPath); } catch { console.warn('[sub-agent-rpc.js] failed to unlink stale socket path'); }
    }

    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        const connId = crypto.randomBytes(4).toString('hex');
        this._connections.set(connId, {
          socket,
          buffer: Buffer.alloc(0),
          agentId: null,
          connectedAt: Date.now()
        });

        socket.on('data', (data) => this._onData(connId, data));
        socket.on('close', () => {
          this._connections.delete(connId);
          this.emit('disconnection', { connId });
        });
        socket.on('error', (err) => {
          console.warn(`⚠️ RPC 连接错误 (${connId}):`, err.message);
          this._connections.delete(connId);
        });

        this.emit('connection', { connId });
      });

      this._server.listen(this.socketPath, () => {
        console.log(`🔌 RPC 服务器已启动: ${this.socketPath}`);
        resolve();
      });

      this._server.on('error', reject);
    });
  }

  async connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('RPC 连接超时'));
        }
      }, 10000);

      const socket = net.createConnection(this.socketPath, () => {
        if (settled) {
          socket.destroy();
          return;
        }
        settled = true;
        clearTimeout(timeoutId);

        const connId = crypto.randomBytes(4).toString('hex');
        this._connections.set(connId, {
          socket,
          buffer: Buffer.alloc(0),
          agentId: null,
          connectedAt: Date.now()
        });

        socket.on('data', (data) => this._onData(connId, data));
        socket.on('close', () => {
          this._connections.delete(connId);
          this.emit('disconnection', { connId });
        });
        socket.on('error', (err) => {
          this._connections.delete(connId);
          this.emit('error', err);
        });

        resolve(connId);
      });

      socket.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });
  }

  async sendRequest(connId, method, params, timeout) {
    const conn = this._connections.get(connId);
    if (!conn) {
      throw new Error(`RPC connection not found: ${connId}`);
    }

    const msg = new RpcMessage(RPC_MESSAGE_TYPE.REQUEST, method, params);
    const serialized = msg.serialize();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(msg.id);
        reject(new Error(`RPC 请求超时: ${method}`));
      }, timeout || this._requestTimeout);

      this._pendingRequests.set(msg.id, { resolve, reject, timer });

      conn.socket.write(serialized);
    });
  }

  sendNotification(connId, method, params) {
    const conn = this._connections.get(connId);
    if (!conn) return;

    const msg = new RpcMessage(RPC_MESSAGE_TYPE.NOTIFICATION, method, params);
    conn.socket.write(msg.serialize());
  }

  sendResponse(connId, requestId, result) {
    const conn = this._connections.get(connId);
    if (!conn) return;

    const msg = new RpcMessage(RPC_MESSAGE_TYPE.RESPONSE, null, result, requestId);
    conn.socket.write(msg.serialize());
  }

  sendError(connId, requestId, error) {
    const conn = this._connections.get(connId);
    if (!conn) return;

    const msg = new RpcMessage(RPC_MESSAGE_TYPE.ERROR, null, { error: error.message }, requestId);
    conn.socket.write(msg.serialize());
  }

  broadcast(method, params) {
    for (const [connId] of this._connections) {
      this.sendNotification(connId, method, params);
    }
  }

  _onData(connId, data) {
    const conn = this._connections.get(connId);
    if (!conn) return;

    conn.buffer = Buffer.concat([conn.buffer, data]);

    while (conn.buffer.length >= RpcMessage.headerSize()) {
      const payloadLength = RpcMessage.payloadLengthFromHeader(conn.buffer);
      if (payloadLength < 0 || payloadLength > RPC_MAX_MESSAGE_SIZE) {
        conn.buffer = Buffer.alloc(0);
        break;
      }

      const totalLength = RpcMessage.headerSize() + payloadLength;
      if (conn.buffer.length < totalLength) break;

      const msgBuffer = Buffer.from(conn.buffer.subarray(0, totalLength));
      conn.buffer = Buffer.from(conn.buffer.subarray(totalLength));

      try {
        const msg = RpcMessage.deserialize(msgBuffer);
        if (msg) {
          this._handleMessage(connId, msg);
        }
      } catch (e) {
        console.warn(`⚠️ RPC 消息解析失败:`, e.message);
      }
    }
  }

  _handleMessage(connId, msg) {
    switch (msg.type) {
      case RPC_MESSAGE_TYPE.REQUEST:
        this.emit('request', { connId, msg });
        break;

      case RPC_MESSAGE_TYPE.RESPONSE:
      case RPC_MESSAGE_TYPE.ERROR: {
        const pending = this._pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingRequests.delete(msg.id);
          if (msg.type === RPC_MESSAGE_TYPE.ERROR) {
            pending.reject(new Error(msg.params.error || 'RPC Error'));
          } else {
            pending.resolve(msg.params);
          }
        }
        break;
      }

      case RPC_MESSAGE_TYPE.NOTIFICATION:
        this.emit('notification', { connId, msg });
        break;

      case RPC_MESSAGE_TYPE.HEARTBEAT:
        this.sendNotification(connId, 'heartbeat_ack', {});
        break;
    }
  }

  _ensureSocketDir() {
    if (!fs.existsSync(RPC_SOCKET_DIR)) {
      fs.mkdirSync(RPC_SOCKET_DIR, { recursive: true });
    }
  }

  async close() {
    for (const [, conn] of this._connections) {
      try { conn.socket.destroy(); } catch { console.warn('[sub-agent-rpc.js] failed to destroy connection socket'); }
    }
    this._connections.clear();

    if (this._server) {
      return new Promise((resolve) => {
        this._server.close(() => {
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          resolve();
        });
      });
    }
  }

  getConnectionCount() {
    return this._connections.size;
  }

  getConnections() {
    return [...this._connections.entries()].map(([id, conn]) => ({
      connId: id,
      agentId: conn.agentId,
      connectedAt: conn.connectedAt
    }));
  }
}

class IsolatedTerminal extends EventEmitter {
  constructor(agentId, config = {}) {
    super();
    this.agentId = agentId;
    this.shell = config.shell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
    this.cwd = config.cwd || process.cwd();
    this.env = { ...process.env, ...(config.env || {}), CRABPAW_AGENT_ID: agentId };
    this._process = null;
    this._outputBuffer = [];
    this._maxBuffer = config.maxBuffer || 1000;
    this._running = false;
  }

  start() {
    if (this._running) return;

    this._process = spawn(this.shell, [], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this._running = true;

    this._process.stdout.on('data', (data) => {
      const text = data.toString();
      this._appendOutput('stdout', text);
      this.emit('output', { agentId: this.agentId, stream: 'stdout', data: text });
    });

    this._process.stderr.on('data', (data) => {
      const text = data.toString();
      this._appendOutput('stderr', text);
      this.emit('output', { agentId: this.agentId, stream: 'stderr', data: text });
    });

    this._process.on('close', (code) => {
      this._running = false;
      this.emit('exit', { agentId: this.agentId, code });
    });

    this._process.on('error', (err) => {
      this._running = false;
      this.emit('error', { agentId: this.agentId, error: err.message });
    });

    this.emit('started', { agentId: this.agentId });
  }

  write(input) {
    if (!this._running || !this._process) {
      throw new Error(`子代理终端未运行: ${this.agentId}`);
    }
    this._process.stdin.write(input);
  }

  executeCommand(command) {
    if (!this._running || !this._process) {
      throw new Error(`子代理终端未运行: ${this.agentId}`);
    }
    this._process.stdin.write(command + '\n');
  }

  stop() {
    if (this._process && this._running) {
      try {
        this._process.stdin.end();
        if (process.platform === 'win32') {
          const { execFileSync } = require('child_process');
          try {
            execFileSync('taskkill', ['/pid', String(this._process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          } catch {
            this._process.kill();
          }
        } else {
          this._process.kill('SIGTERM');
          setTimeout(() => {
            try { this._process.kill('SIGKILL'); } catch { console.warn('[sub-agent-rpc.js] failed to SIGKILL sub-agent'); }
          }, 5000);
        }
      } catch {
        console.warn('[sub-agent-rpc.js] failed to kill sub-agent process');
      }
    }
    this._running = false;
  }

  getRecentOutput(lines = 50) {
    return this._outputBuffer.slice(-lines);
  }

  isRunning() {
    return this._running;
  }

  _appendOutput(stream, text) {
    this._outputBuffer.push({
      stream,
      text,
      timestamp: Date.now()
    });

    if (this._outputBuffer.length > this._maxBuffer) {
      this._outputBuffer = this._outputBuffer.slice(-this._maxBuffer);
    }
  }
}

class SubAgentRpcBridge extends EventEmitter {
  constructor(orchestrator, config = {}) {
    super();
    this.orchestrator = orchestrator;
    this.socketPath = config.socketPath || path.join(RPC_SOCKET_DIR, `crabpaw-master.sock`);
    this.transport = new RpcTransport(this.socketPath);
    this._terminals = new Map();
    this._agentConnMap = new Map();
    this._heartbeatInterval = config.heartbeatInterval || 30000;
    this._heartbeatTimer = null;

    this.transport.on('request', ({ connId, msg }) => this._handleRequest(connId, msg));
    this.transport.on('notification', ({ connId, msg }) => this._handleNotification(connId, msg));
    this.transport.on('connection', ({ connId }) => {
      this.emit('agent_connected', { connId, timestamp: Date.now() });
    });
    this.transport.on('disconnection', ({ connId }) => {
      const agentId = this._agentConnMap.get(connId);
      if (agentId) {
        this._agentConnMap.delete(connId);
        this.emit('agent_disconnected', { agentId, connId, timestamp: Date.now() });
      }
    });
  }

  async start() {
    await this.transport.startServer();
    this._startHeartbeat();
    console.log('[RPC] Sub-agent RPC bridge started');
  }

  async stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    for (const [agentId, terminal] of this._terminals) {
      terminal.stop();
      this.emit('terminal_stopped', { agentId });
    }
    this._terminals.clear();

    await this.transport.close();
    console.log('[RPC] Sub-agent RPC bridge stopped');
  }

  async _handleRequest(connId, msg) {
    try {
      let result;

      switch (msg.method) {
        case RPC_METHOD.PING:
          result = { pong: true, timestamp: Date.now() };
          break;

        case RPC_METHOD.EXECUTE_STEP:
          result = await this._executeStepForAgent(connId, msg.params);
          break;

        case RPC_METHOD.GET_STATUS:
          result = this._getAgentStatus(msg.params);
          break;

        case RPC_METHOD.CANCEL:
          result = this._cancelAgent(msg.params);
          break;

        case RPC_METHOD.PUSH_CONTEXT:
          result = this._pushContext(connId, msg.params);
          break;

        case RPC_METHOD.GET_RESULT:
          result = this._getAgentResult(msg.params);
          break;

        case RPC_METHOD.TERMINAL_INPUT:
          result = this._handleTerminalInput(msg.params);
          break;

        case RPC_METHOD.SPAWN_SUB_AGENT:
          result = await this._spawnSubAgent(connId, msg.params);
          break;

        case RPC_METHOD.LIST_SUB_AGENTS:
          result = this._listSubAgents();
          break;

        default:
          throw new Error(`未知 RPC 方法: ${msg.method}`);
      }

      this.transport.sendResponse(connId, msg.id, result);
    } catch (error) {
      this.transport.sendError(connId, msg.id, error);
    }
  }

  _handleNotification(connId, msg) {
    switch (msg.method) {
      case 'register_agent': {
        const agentId = msg.params.agentId;
        this._agentConnMap.set(connId, agentId);

        if (msg.params.needTerminal) {
          this._createTerminal(agentId, msg.params.terminalConfig);
        }

        this.emit('agent_registered', { agentId, connId, timestamp: Date.now() });
        break;
      }

      case 'terminal_output': {
        this.emit('terminal_output', {
          agentId: msg.params.agentId,
          stream: msg.params.stream,
          data: msg.params.data,
          timestamp: Date.now()
        });
        break;
      }
    }
  }

  async _executeStepForAgent(connId, params) {
    // eslint-disable-next-line no-unused-vars
    const { agentId, step, context } = params;

    if (this.orchestrator) {
      const agent = this.orchestrator._activeAgents.get(agentId);
      if (agent) {
        return { status: 'executing', step };
      }
    }

    return { status: 'agent_not_found', agentId };
  }

  _getAgentStatus(params) {
    const { agentId } = params;
    if (this.orchestrator) {
      return this.orchestrator.getAgentStatus(agentId);
    }
    return null;
  }

  _cancelAgent(params) {
    const { agentId } = params;
    if (this.orchestrator) {
      const agent = this.orchestrator._activeAgents.get(agentId);
      if (agent) {
        agent.status = 'cancelled';
        this.orchestrator._activeAgents.delete(agentId);
        this.orchestrator._cleanupTerminal(agentId);

        const terminal = this._terminals.get(agentId);
        if (terminal) {
          terminal.stop();
          this._terminals.delete(agentId);
        }

        return { cancelled: true, agentId };
      }
    }
    return { cancelled: false, agentId };
  }

  _pushContext(connId, params) {
    const { agentId, context } = params;
    if (this.orchestrator) {
      const agent = this.orchestrator._activeAgents.get(agentId);
      if (agent) {
        agent.context = { ...agent.context, ...context };
        return { pushed: true };
      }
    }
    return { pushed: false };
  }

  _getAgentResult(params) {
    const { agentId } = params;
    if (this.orchestrator) {
      const result = this.orchestrator._agentResults.get(agentId);
      return result ? { found: true, result } : { found: false };
    }
    return { found: false };
  }

  _handleTerminalInput(params) {
    const { agentId, input } = params;
    const terminal = this._terminals.get(agentId);
    if (terminal && terminal.isRunning()) {
      terminal.write(input);
      return { sent: true };
    }
    return { sent: false, error: 'Terminal not running' };
  }

  async _spawnSubAgent(connId, params) {
    if (!this.orchestrator) {
      return { spawned: false, error: 'Orchestrator 未初始化' };
    }

    const parentAgentId = this._agentConnMap.get(connId);
    const result = await this.orchestrator.spawnAgent({
      ...params,
      parentFlowId: params.parentFlowId || parentAgentId,
      depth: (params.depth || 0) + 1
    });

    return { spawned: true, ...result };
  }

  _listSubAgents() {
    if (!this.orchestrator) return [];
    return [...this.orchestrator._activeAgents.entries()].map(([id, agent]) => ({
      agentId: id,
      goal: agent.goal,
      status: agent.status,
      depth: agent.depth,
      startedAt: agent.startedAt
    }));
  }

  _createTerminal(agentId, config = {}) {
    const terminal = new IsolatedTerminal(agentId, config);

    terminal.on('output', ({ stream, data }) => {
      const connId = [...this._agentConnMap.entries()]
        .find(([, aid]) => aid === agentId)?.[0];

      if (connId) {
        this.transport.sendNotification(connId, RPC_METHOD.TERMINAL_OUTPUT, {
          agentId,
          stream,
          data
        });
      }
    });

    terminal.on('exit', ({ code }) => {
      this._terminals.delete(agentId);
      this.emit('terminal_exited', { agentId, code });
    });

    this._terminals.set(agentId, terminal);
    terminal.start();

    this.emit('terminal_created', { agentId });
    return terminal;
  }

  getTerminal(agentId) {
    return this._terminals.get(agentId) || null;
  }

  getTerminalOutput(agentId, lines) {
    const terminal = this._terminals.get(agentId);
    return terminal ? terminal.getRecentOutput(lines) : [];
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      this.transport.broadcast('heartbeat', { timestamp: Date.now() });
    }, this._heartbeatInterval);
  }

  getStats() {
    return {
      connections: this.transport.getConnectionCount(),
      activeTerminals: this._terminals.size,
      registeredAgents: this._agentConnMap.size
    };
  }
}

module.exports = {
  RpcMessage,
  RpcTransport,
  IsolatedTerminal,
  SubAgentRpcBridge,
  RPC_MESSAGE_TYPE,
  RPC_METHOD,
  RPC_SOCKET_DIR
};
