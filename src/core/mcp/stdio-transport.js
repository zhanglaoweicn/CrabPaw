/**
 * MCP 传输层 — Stdio 传输
 *
 * 启动 MCP 服务器子进程，通过 stdin/stdout 通信
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const readline = require('readline');

class StdioTransport extends EventEmitter {
  constructor(config) {
    super();
    this.command = config.command;
    this.args = config.args || [];
    this.env = config.env || {};
    this.cwd = config.cwd || null;
    this.timeout = config.timeout || 30000;
    this.connectTimeout = config.connectTimeout || 10000;

    this._process = null;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._connected = false;
    this._buffer = '';
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const connectTimer = setTimeout(() => {
        reject(new Error(`MCP Stdio 连接超时: ${this.command}`));
      }, this.connectTimeout);

      try {
        // 构建安全环境变量：只传递显式配置的 + 安全基线
        const safeEnv = {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || '',
          USERPROFILE: process.env.USERPROFILE || '',
          TEMP: process.env.TEMP || '',
          TMP: process.env.TMP || '',
          SYSTEMROOT: process.env.SYSTEMROOT || '',
          LANG: process.env.LANG || '',
          ...this.env,
        };

        // 2026-08-01: 移除 shell:true（命令注入面）。command 为可执行文件路径
        // 或命令名，args 参数化传递；不再经过 shell 解析。
        this._process = spawn(this.command, this.args || [], {
          env: safeEnv,
          cwd: this.cwd || undefined,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });

        this._process.on('error', (err) => {
          clearTimeout(connectTimer);
          this._connected = false;
          this.emit('error', err);
          reject(err);
        });

        this._process.on('exit', (code, signal) => {
          this._connected = false;
          this.emit('disconnected', { code, signal });
        });

        // 读取 stderr 日志
        this._process.stderr.on('data', (data) => {
          this.emit('log', data.toString());
        });

        // 解析 stdout 的 JSON-RPC 消息
        const rl = readline.createInterface({
          input: this._process.stdout,
          crlfDelay: Infinity,
        });

        rl.on('line', (line) => {
          if (!line.trim()) return;
          try {
            const message = JSON.parse(line);
            this._handleMessage(message);
          } catch (e) {
            console.debug('[mcp-stdio] 非 JSON 行已忽略:', e?.message || e);
          }
        });

        this._connected = true;
        clearTimeout(connectTimer);
        this.emit('connected');
        resolve();
      } catch (e) {
        clearTimeout(connectTimer);
        reject(e);
      }
    });
  }

  async disconnect() {
    if (this._process) {
      const proc = this._process;
      try {
        proc.kill('SIGTERM');
        // 2026-08-01: SIGKILL race 修复——进程已退出时取消强杀定时器，
        // 避免对已不存在 PID 的 SIGKILL（ERSCH）噪音
        const killTimer = setTimeout(() => {
          try { if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL'); } catch (e) { console.debug('[mcp-stdio] SIGKILL 跳过(进程已退出):', e?.message || e); }
        }, 3000);
        proc.once('exit', () => clearTimeout(killTimer));
      } catch (e) { console.debug('[mcp-stdio] SIGTERM 失败(进程操作):', e?.message || e); }
      this._process = null;
    }
    this._connected = false;
    this._pendingRequests.clear();
    this.emit('disconnected');
  }

  async sendRequest(method, params = {}) {
    if (!this._connected || !this._process) {
      throw new Error('MCP Stdio 未连接');
    }

    const id = ++this._requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`MCP 请求超时: ${method} (id=${id})`));
      }, this.timeout);

      this._pendingRequests.set(id, { resolve, reject, timer });

      try {
        this._process.stdin.write(JSON.stringify(request) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this._pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  /**
   * 发送通知（不期望响应）
   */
  sendNotification(method, params = {}) {
    if (!this._connected || !this._process) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    try {
      this._process.stdin.write(JSON.stringify(notification) + '\n');
    } catch (e) { console.debug('[mcp-stdio] 通知发送失败:', e?.message || e); }
  }

  _handleMessage(message) {
    // 响应
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this._pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'MCP Error'));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    // 通知
    if (message.method) {
      this.emit('notification', message);
    }
  }

  get isConnected() {
    return this._connected && this._process !== null;
  }
}

module.exports = { StdioTransport };
