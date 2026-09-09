const crypto = require('crypto');
/**
 * 跨平台 IPC 桥接 *
 * 为 execute_code 提供脚本与主进程之间的通信通道
 * - Windows: TCP localhost（Named Pipe 需要特殊权限，TCP 更简单）
 * - Linux/macOS: TCP localhost（统一实现，后续可优化为 Unix Domain Socket）
 * 协议：JSON-RPC over TCP
 * - 请求: { jsonrpc: "2.0", id, method: "tool_call", params: { tool, input } }
 * - 响应: { jsonrpc: "2.0", id, result: { ... } } 或 { jsonrpc: "2.0", id, error: { code, message } }
 */

const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 0; // 0 = 随机可用端口
const RPC_VERSION = '2.0';

class IPCBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    this._host = config.host || '127.0.0.1';
    this._port = config.port || DEFAULT_PORT;
    this._server = null;
    this._actualPort = null;
    this._connections = new Map(); // id -> socket
    this._pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this._requestId = 0;
    this._toolDispatcher = config.toolDispatcher || null;
    this._maxToolCalls = config.maxToolCalls || 50;
    this._toolCallCount = 0;
    this._running = false;
  }

  /**
   * 启动 IPC 服务   * @returns {Promise<{ port: number, host: string }>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        const connId = `conn_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
        this._connections.set(connId, socket);

        let buffer = '';
        socket.on('data', (data) => {
          buffer += data.toString();
          // 按换行符分割 JSON-RPC 消息
          const lines = buffer.split('\n');
          buffer = lines.pop(); // 保留不完整的包
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              this._handleMessage(connId, msg);
            } catch (err) {
              this.emit('error', { type: 'parse_error', message: err.message, line });
            }
          }
        });

        socket.on('close', () => {
          this._connections.delete(connId);
          this.emit('connection:close', { connId });
        });

        socket.on('error', (err) => {
          // ECONNRESET 是正常断开，不需要抛出
          if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            this._connections.delete(connId);
            return;
          }
          this.emit('error', { type: 'socket_error', message: err.message, connId });
        });

        this.emit('connection:open', { connId });
      });

      this._server.listen(this._port, this._host, () => {
        const addr = this._server.address();
        this._actualPort = addr.port;
        this._running = true;
        this.emit('started', { port: addr.port, host: this._host });
        resolve({ port: addr.port, host: this._host });
      });

      this._server.on('error', (err) => {
        if (!this._running) {
          reject(err);
        } else {
          this.emit('error', { type: 'server_error', message: err.message });
        }
      });
    });
  }

  /**
   * 停止 IPC 服务   */
  async stop() {
    this._running = false;

    // 关闭所有连接
    // eslint-disable-next-line no-unused-vars
    for (const [id, socket] of this._connections) {
      socket.destroy();
    }
    this._connections.clear();

    // 拒绝所有待处理请求
    // eslint-disable-next-line no-unused-vars
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('IPC bridge shutting down'));
    }
    this._pendingRequests.clear();

    // 关闭服务
    if (this._server) {
      return new Promise((resolve) => {
        this._server.close(() => {
          this._server = null;
          resolve();
        });
      });
    }
  }

  /**
   * 处理收到的 JSON-RPC 消息
   */
  async _handleMessage(connId, msg) {
    // 响应消息（脚本返回工具调用结果）
    if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'RPC error'));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 请求消息（脚本发起工具调用）
    if (msg.method === 'tool_call' && msg.id) {
      await this._handleToolCall(connId, msg);
      return;
    }

    // 通知消息
    if (msg.method && !msg.id) {
      this.emit('notification', { connId, method: msg.method, params: msg.params });
    }
  }

  /**
   * 处理脚本发起的工具调用   */
  async _handleToolCall(connId, msg) {
    const { tool, input } = msg.params || {};

    // 工具调用次数限制
    this._toolCallCount++;
    if (this._toolCallCount > this._maxToolCalls) {
      this._sendResponse(connId, msg.id, null, {
        code: -32000,
        message: `工具调用次数已达上限 (${this._maxToolCalls})`,
      });
      return;
    }

    if (!this._toolDispatcher) {
      this._sendResponse(connId, msg.id, null, {
        code: -32601,
        message: '工具分发器未配置',
      });
      return;
    }

    try {
      const result = await this._toolDispatcher(tool, input);
      this._sendResponse(connId, msg.id, result, null);
      this.emit('tool:called', { tool, input, result, callCount: this._toolCallCount });
    } catch (err) {
      this._sendResponse(connId, msg.id, null, {
        code: -32603,
        message: err.message,
      });
      this.emit('tool:error', { tool, input, error: err.message });
    }
  }

  /**
   * 发送 JSON-RPC 响应
   */
  _sendResponse(connId, id, result, error) {
    const socket = this._connections.get(connId);
    if (!socket || socket.destroyed) return;

    const response = { jsonrpc: RPC_VERSION, id };
    if (error) {
      response.error = error;
    } else {
      response.result = result;
    }

    socket.write(JSON.stringify(response) + '\n');
  }

  /**
   * 重置工具调用计数
   */
  resetToolCallCount() {
    this._toolCallCount = 0;
  }

  get port() { return this._actualPort; }
  get running() { return this._running; }
  get toolCallCount() { return this._toolCallCount; }
}

/**
 * IPC 客户端（供 crabpaw_tools 模块使用）
 * 在子进程中运行，连接到主进程的 IPC 服务
 */
class IPCClient {
  constructor(config = {}) {
    this._host = config.host || '127.0.0.1';
    this._port = config.port;
    this._socket = null;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._connected = false;
    this._buffer = '';
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this._socket = net.createConnection({ host: this._host, port: this._port }, () => {
        this._connected = true;
        resolve();
      });

      this._socket.on('data', (data) => {
        this._buffer += data.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleResponse(msg);
          } catch { console.warn('[ipc-bridge] silent catch, error swallowed'); }
        }
      });

      this._socket.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        }
      });

      this._socket.on('close', () => {
        this._connected = false;
      });
    });
  }

  _handleResponse(msg) {
    const pending = this._pendingRequests.get(msg.id);
    if (!pending) return;

    this._pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error.message || 'RPC error'));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * 调用远程工具
   * @param {string} tool 工具名   * @param {object} input 工具输入
   * @param {number} timeout 超时毫秒
   * @returns {Promise<any>}
   */
  async callTool(tool, input = {}, timeout = 30000) {
    if (!this._connected) {
      throw new Error('IPC 客户端未连接');
    }

    const id = ++this._requestId;
    const request = {
      jsonrpc: RPC_VERSION,
      id,
      method: 'tool_call',
      params: { tool, input },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`工具调用超时: ${tool} (${timeout}ms)`));
      }, timeout);

      this._pendingRequests.set(id, { resolve, reject, timer });
      this._socket.write(JSON.stringify(request) + '\n');
    });
  }

  async disconnect() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
      this._connected = false;
    }
  }

  get connected() { return this._connected; }
}

module.exports = { IPCBridge, IPCClient };
