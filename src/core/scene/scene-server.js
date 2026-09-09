/**
 * SceneServer — WebSocket server for realtime UI scene synchronization
 *
 * Accepts WebSocket connections at the /scene path.
 * On connect: sends the full scene snapshot.
 * On scene changes: broadcasts incremental patches to all connected clients.
 * Handles resync requests and intent messages from UI clients.
 *
 * Also broadcasts scene changes via SSE for non-WebSocket consumers.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { getSceneStore } = require('./scene-store');
const v1 = require('./scene-protocol-v1');
const { verifyApiToken } = require('../http-middleware');

// ── WebSocket Message Types ──────────────────────────────────

const WS_TYPE = {
  SNAPSHOT: 'scene:snapshot',
  PATCH: 'scene:patch',
  RESYNC: 'scene:resync',
  INTENT: 'scene:intent',
  CONNECTED: 'scene:connected',
  ERROR: 'scene:error',
  PING: 'scene:ping',        // legacy ping
  PONG: 'pong',              // legacy pong
};

const PROTOCOL_MODES = {
  LEGACY: 'legacy',          // 仅 scene:SNAPSHOT 格式
  V1: 'v1',                  // 仅 SCENE-PROTOCOL v1
  AUTO: 'auto',              // 根据客户端 hello 自动协商(默认)
};

// ── Heartbeat ────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 30000;


// ── SceneServer ──────────────────────────────────────────────

class SceneServer extends EventEmitter {
  /**
   * @param {import('http').Server} server    Node.js HTTP server
   * @param {object} [options]
   * @param {string} [options.path='/scene']   WebSocket path
   * @param {SceneStore} [options.store]       SceneStore instance (default: global)
   * @param {boolean} [options.sseBroadcast=true]  Also emit via SSE broadcast
   * @param {string} [options.protocol='auto']  Protocol mode: 'legacy' | 'v1' | 'auto'
   * @param {string} [options.serverVersion='2.3.0']
   */
  constructor(server, options = {}) {
    super();

    this._path = options.path || '/scene';
    this._store = options.store || getSceneStore();
    this._sseEnabled = options.sseBroadcast !== false;
    this._protocolMode = options.protocol || PROTOCOL_MODES.AUTO;
    this._serverVersion = options.serverVersion || '2.3.0';
    this._apiKey = options.apiKey || '';

    /** @type {Map<string, {id:string,ws:WebSocket,isAlive:boolean,lastPing:number,handshake:v1.ClientHandshake|null,mode:string}>} */
    this._clients = new Map();

    this._heartbeatTimer = null;
    this._changeListener = null;
    this._destroyed = false;
    this._server = server;

    // Create WebSocket server
    this._wss = new WebSocket.Server({
      noServer: true,
      maxPayload: 1024 * 1024, // 1MB max message
    });

    this._upgradeHandler = (req, socket, head) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname !== this._path) return;
      if (!verifyApiToken(req, this._apiKey)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this._wss.handleUpgrade(req, socket, head, (ws) => {
        this._wss.emit('connection', ws, req);
      });
    };
    server.on('upgrade', this._upgradeHandler);

    this._setupListeners();
    this._startHeartbeat();

    console.log(`[scene-server] Scene WebSocket server listening on ${this._path} (protocol=${this._protocolMode})`);
  }

  // ── Setup ──────────────────────────────────────────────────

  _setupListeners() {
    this._wss.on('connection', (ws, req) => this._handleConnection(ws, req));

    this._wss.on('error', (err) => {
      console.error('[scene-server] WebSocket server error:', err.message);
      this.emit('error', err);
    });

    // Listen for scene store changes
    this._changeListener = (change) => this._onSceneChange(change);
    this._store.on('change', this._changeListener);
  }

  // ── Connection Handling ────────────────────────────────────

  _handleConnection(ws, _req) {
    const clientId = `scene_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clientInfo = {
      id: clientId,
      ws,
      isAlive: true,
      lastPing: Date.now(),
      handshake: null,
      mode: null,           // 'legacy' | 'v1' — 握手前为 null
      lastRev: 0,           // v1: 本地已应用的 rev
    };

    this._clients.set(clientId, clientInfo);

    console.log(`[scene-server] Client connected: ${clientId} (total: ${this._clients.size})`);

    // 强制 v1 模式: 等 hello
    // auto 模式: 给客户端 5s 宽限期发 hello,超时回退 legacy
    // legacy 模式: 立即发 scene:connected + scene:snapshot
    if (this._protocolMode === PROTOCOL_MODES.LEGACY) {
      this._sendLegacyConnected(clientId);
      this._sendLegacySnapshot(clientId);
    } else if (this._protocolMode === PROTOCOL_MODES.V1) {
      // 等客户端 hello,先不发任何消息
      this._sendV1Ping(clientId);  // 可选: 触发客户端回 hello
    } else {
      // AUTO: 立即发 scene:connected(legacy) + scene:snapshot(legacy)
      // 若客户端发 hello,升级为 v1
      clientInfo.mode = 'legacy';
      this._sendLegacyConnected(clientId);
      this._sendLegacySnapshot(clientId);
    }

    // Message handler
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleMessage(clientId, msg);
      } catch (e) {
        this._send(clientId, {
          type: WS_TYPE.ERROR,
          error: 'Invalid JSON message',
          timestamp: Date.now(),
        });
      }
    });

    // Close handler
    ws.on('close', () => {
      this._clients.delete(clientId);
      console.log(`[scene-server] Client disconnected: ${clientId} (total: ${this._clients.size})`);
      this.emit('disconnect', { clientId });
    });

    // Error handler
    ws.on('error', (err) => {
      console.error(`[scene-server] WebSocket error (${clientId}):`, err.message);
      this._clients.delete(clientId);
    });

    this.emit('connect', { clientId });
  }

  // ── Message Handling ───────────────────────────────────────

  _handleMessage(clientId, msg) {
    const client = this._clients.get(clientId);
    if (!client) return;

    // ── v1 信封识别 ──
    if (msg && msg.v === v1.PROTOCOL_VERSION) {
      this._handleV1Message(clientId, client, msg);
      return;
    }

    // ── legacy 兼容 ──
    switch (msg.type) {
      case 'pong':
      case 'scene:pong':
        this._handlePong(clientId);
        break;

      case WS_TYPE.RESYNC:
        this._handleResync(clientId, msg);
        break;

      case WS_TYPE.INTENT:
        this._handleIntent(clientId, msg);
        break;

      // v1 类型被误发但无 v 字段,降级为 hello(让客户端走 legacy)
      case 'hello':
        this._upgradeToV1(clientId, client, msg);
        break;

      default:
        // Unknown message type — echo back as error
        this._send(clientId, {
          type: WS_TYPE.ERROR,
          error: `Unknown message type: ${msg.type}`,
          originalType: msg.type,
          timestamp: Date.now(),
        });
    }
  }

  /**
   * v1 协议消息处理
   */
  _handleV1Message(clientId, client, msg) {
    if (msg.type === 'hello') {
      this._upgradeToV1(clientId, client, msg);
      return;
    }

    // hello 之后才能发其他消息
    if (!client.handshake) {
      this._send(clientId, v1.buildError('hello required first', 'NO_HELLO'));
      return;
    }

    switch (msg.type) {
      case 'ping':
        this._send(clientId, v1.buildPong());
        // 2026-08-17: v1 ping 即探活信号——此前只回 pong 不设 isAlive，
        // GUI 每 25s 发 ping 仍被 30s 心跳置 false、60s 判死断开重连循环，
        // 断连窗口内 upsert 的 scene patch 全部丢失（实机：股票卡不上线）。
        this._handlePong(clientId);
        break;

      case 'pong':
        this._handlePong(clientId);
        break;

      case 'resync':
        this._handleV1Resync(clientId, client, msg);
        break;

      case 'intent':
        this._handleV1Intent(clientId, client, msg);
        break;

      default:
        // 未知 type 必须忽略(前向兼容)
        console.log(`[scene-server] Ignoring unknown v1 type from ${clientId}: ${msg.type}`);
    }
  }

  /**
   * 升级连接到 v1 协议
   */
  _upgradeToV1(clientId, client, msg) {
    const result = v1.handleHello(msg);
    if (!result.ok) {
      this._send(clientId, v1.buildError(result.error, 'INVALID_HELLO'));
      return;
    }

    client.handshake = result.handshake;
    client.mode = 'v1';

    const snapshot = this._store.getSnapshot();
    client.lastRev = snapshot.rev;  // 初始化为当前快照 rev

    // 1. 发 welcome
    this._send(clientId, v1.buildWelcome(snapshot.rev, this._serverVersion));

    // 2. 发全量 scene
    this._send(clientId, v1.buildScene(snapshot.rev, snapshot.surfaces));

    console.log(`[scene-server] Client ${clientId} upgraded to v1 (shell=${result.handshake.shell}, caps=${result.handshake.caps.join(',')})`);
  }

  /**
   * v1 resync
   */
  _handleV1Resync(clientId, client, msg) {
    const result = v1.handleResync(msg);
    if (!result.ok) {
      this._send(clientId, v1.buildError(result.error, 'INVALID_RESYNC'));
      return;
    }
    const snapshot = this._store.getSnapshot();
    client.lastRev = snapshot.rev;
    this._send(clientId, v1.buildScene(snapshot.rev, snapshot.surfaces));
    this._send(clientId, v1.buildResyncAck(snapshot.rev, result.reason));
    console.log(`[scene-server] v1 resync sent to ${clientId} (reason=${result.reason})`);
  }

  /**
   * v1 intent
   */
  _handleV1Intent(clientId, client, msg) {
    const result = v1.handleIntent(msg);
    if (!result.ok) {
      this._send(clientId, v1.buildError(result.error, 'INVALID_INTENT'));
      return;
    }
    const { intent } = result;
    this.emit('intent', { clientId, ...intent });
    try {
      this._store.pushIntent(intent.surface, intent.name, intent.data);
    } catch (e) {
      /* ignore */
      console.warn('[scene-server.js] 空 catch 补日志:', e && e.message);
    }

    console.log(`[scene-server] v1 intent from ${clientId}: ${intent.surface} -> ${intent.name}`);
  }

  _handlePong(clientId) {
    const client = this._clients.get(clientId);
    if (client) {
      client.isAlive = true;
      client.lastPing = Date.now();
    }
  }

  _handleResync(clientId, msg) {
    const snapshot = this._store.getSnapshot();
    this._send(clientId, {
      type: WS_TYPE.SNAPSHOT,
      rev: snapshot.rev,
      surfaces: snapshot.surfaces,
      requestedAt: msg && msg.timestamp ? msg.timestamp : Date.now(),
      timestamp: Date.now(),
    });
    console.log(`[scene-server] Resync sent to ${clientId}`);
  }

  _handleIntent(clientId, msg) {
    // Forward intent messages from the UI client (e.g. user clicks, focus changes)
    if (!msg.intent || !msg.surfaceId) {
      this._send(clientId, {
        type: WS_TYPE.ERROR,
        error: 'Intent message requires surfaceId and intent fields',
        timestamp: Date.now(),
      });
      return;
    }

    const intentEvent = {
      clientId,
      surfaceId: msg.surfaceId,
      intent: msg.intent,
      payload: msg.payload || {},
      timestamp: msg.timestamp || Date.now(),
    };

    this.emit('intent', intentEvent);
    // 将 intent 推入 SceneStore 队列，供下一轮 Agent 上下文注入
    try {
      this._store.pushIntent(msg.surfaceId, msg.intent, msg.payload);
    } catch (e) {
      /* noop */
      console.warn('[scene-server.js] 空 catch 补日志:', e && e.message);
    }

    console.log(`[scene-server] Intent from ${clientId}: ${msg.surfaceId} -> ${msg.intent}`);
  }

  // ── Scene Change Broadcasting ───────────────────────────────

  _onSceneChange(change) {
    if (this._destroyed) return;

    const legacyMsg = {
      type: WS_TYPE.PATCH,
      rev: change.rev,
      ops: change.ops,
      timestamp: Date.now(),
    };

    this._broadcast(legacyMsg, change);

    // Also emit via SSE if enabled
    if (this._sseEnabled) {
      this._emitSSE(change);
    }
  }

  _broadcast(message, change = null) {
    let v1Sent = 0, legacySent = 0;

    for (const [clientId, client] of this._clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;

      try {
        if (client.mode === 'v1' && client.handshake && change) {
          // 间隙检测: change.rev > client.lastRev + 1 表示漏帧
          if (client.lastRev !== null && client.lastRev !== undefined && change.rev > client.lastRev + 1) {
            // 漏帧: 发 resync 全量 + ack
            const fullSnapshot = this._store.getSnapshot();
            this._send(clientId, v1.buildScene(fullSnapshot.rev, fullSnapshot.surfaces));
            this._send(clientId, v1.buildResyncAck(fullSnapshot.rev, 'gap'));
            client.lastRev = fullSnapshot.rev;
            v1Sent++;
            continue;
          }
          // v1 patch
          this._send(clientId, v1.buildScenePatch(change.rev, client.lastRev, change.ops));
          client.lastRev = change.rev;
          v1Sent++;
        } else {
          // legacy
          client.ws.send(JSON.stringify(message));
          legacySent++;
        }
      } catch (e) {
        console.error(`[scene-server] Send to ${clientId} failed:`, e.message);
        this._clients.delete(clientId);
      }
    }

    if (v1Sent + legacySent > 0) {
      console.log(`[scene-server] Broadcast: rev ${message.rev} (v1=${v1Sent}, legacy=${legacySent})`);
    }
  }

  _emitSSE(change) {
    try {
      const { broadcastEvent } = require('../sse-broadcast');
      broadcastEvent('scene:change', {
        rev: change.rev,
        ops: change.ops,
      });
    } catch (e) {
      // SSE broadcast unavailable — this is non-critical
      if (process.env.NODE_ENV === 'development') {
        console.warn('[scene-server] SSE broadcast unavailable:', e.message);
      }
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const deadClients = [];

      for (const [clientId, client] of this._clients) {
        if (!client.isAlive) {
          deadClients.push(clientId);
          continue;
        }

        client.isAlive = false;
        try {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'scene:ping', timestamp: now }));
          }
        } catch (e) {
          deadClients.push(clientId);
        }
      }

      for (const clientId of deadClients) {
        const client = this._clients.get(clientId);
        if (client) {
          console.log(`[scene-server] Heartbeat timeout, terminating: ${clientId}`);
          try { client.ws.terminate(); } catch (e) {
            /* ignore */
            console.warn('[scene-server.js] 空 catch 补日志:', e && e.message);
          }

          this._clients.delete(clientId);
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  _send(clientId, message) {
    const client = this._clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error(`[scene-server] Send to ${clientId} failed:`, e.message);
      return false;
    }
  }

  _sendLegacyConnected(clientId) {
    this._send(clientId, {
      type: WS_TYPE.CONNECTED,
      clientId,
      timestamp: Date.now(),
    });
  }

  _sendLegacySnapshot(clientId) {
    const snapshot = this._store.getSnapshot();
    this._send(clientId, {
      type: WS_TYPE.SNAPSHOT,
      rev: snapshot.rev,
      surfaces: snapshot.surfaces,
      timestamp: Date.now(),
    });
  }

  _sendV1Ping(clientId) {
    this._send(clientId, v1.buildPing());
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * 获取协议模式
   */
  getProtocolMode() {
    return this._protocolMode;
  }

  /**
   * 获取客户端协议分布
   */
  getClientProtocols() {
    const stats = { v1: 0, legacy: 0, pending: 0 };
    for (const c of this._clients.values()) {
      if (c.mode === 'v1') stats.v1++;
      else if (c.mode === 'legacy') stats.legacy++;
      else stats.pending++;
    }
    return stats;
  }

  /**
   * 设置协议模式(限运行前)
   */
  setProtocolMode(mode) {
    if (!Object.values(PROTOCOL_MODES).includes(mode)) {
      throw new Error(`unknown protocol mode: ${mode}`);
    }
    this._protocolMode = mode;
  }

  // ── Stats & Lifecycle ──────────────────────────────────────

  /**
   * Get connection statistics.
   * @returns {{ clients: number, path: string, rev: number, surfaceCount: number }}
   */
  getStats() {
    return {
      clients: this._clients.size,
      path: this._path,
      rev: this._store.revision,
      surfaceCount: this._store.size,
    };
  }

  /**
   * Destroy the server: close all connections and stop timers.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._stopHeartbeat();

    if (this._server && this._upgradeHandler) {
      this._server.removeListener('upgrade', this._upgradeHandler);
    }

    // Remove store listener
    if (this._changeListener) {
      this._store.removeListener('change', this._changeListener);
      this._changeListener = null;
    }

    // Close all client connections
    // eslint-disable-next-line no-unused-vars
    for (const [clientId, client] of this._clients) {
      try { client.ws.close(); } catch (e) {
        /* ignore */
        console.warn('[scene-server.js] 空 catch 补日志:', e && e.message);
      }

    }
    this._clients.clear();

    // Close the WebSocket server
    try {
      this._wss.close();
    } catch (e) {

      // Already closed

      console.warn('[scene-server.js] 空 catch 补日志:', e && e.message);
    }


    console.log('[scene-server] Destroyed');
    this.emit('destroyed');
  }
}

// ── Factory ──────────────────────────────────────────────────

let _instance = null;

/**
 * Create (or get existing) SceneServer attached to an HTTP server.
 * @param {import('http').Server} server
 * @param {object} [options]
 * @returns {SceneServer}
 */
function createSceneServer(server, options) {
  if (_instance && !_instance._destroyed) {
    return _instance;
  }
  _instance = new SceneServer(server, options);
  return _instance;
}

/**
 * Get the active SceneServer instance (null if not created yet).
 * @returns {SceneServer|null}
 */
function getSceneServer() {
  return _instance && !_instance._destroyed ? _instance : null;
}

module.exports = {
  SceneServer,
  createSceneServer,
  getSceneServer,
  PROTOCOL_MODES,
};
