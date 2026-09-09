'use strict';

/**
 * scene-protocol-v1.js — SCENE-PROTOCOL v1 信封/握手/能力协商
 *
 * 设计: 在现有 scene-server 上叠加 v1 协议层,保持向后兼容。
 *   - 信封: 所有出站消息自动加 v:1 字段
 *   - 握手: 客户端首帧必须是 {v:1, type:"hello"},否则回 scene:snapshot (legacy) 兼容
 *   - caps: hello 声明的 caps 决定下发格式(scene / scene.patch)
 *   - ping/pong: 双向,服务端 scene:ping,客户端 pong
 *   - 间隙检测: scene.patch 带 base,客户端发现 gap 时发 scene:resync (reason:"gap")
 *
 * 入站消息类型(必须识别):
 *   hello, resync, intent, ping, pong
 *
 * 出站消息类型:
 *   welcome, scene, scene.patch, scene:resync-ack, scene:error, scene:ping, scene:connected(legacy)
 *
 * 与 legacy 关系:
 *   - 客户端未发 hello → 走 legacy(scene:connected + scene:snapshot)
 *   - 客户端发 hello 但无 caps → scene:全量,无 patch
 *   - 客户端声明 caps:["scene","patch"] → scene 全量 + scene.patch 增量
 */

const PROTOCOL_VERSION = 1;

const HELLO_CAPS = {
  SCENE: 'scene',        // 接收全量快照(必备)
  PATCH: 'patch',        // 接收 scene.patch 增量
  MORPH: 'morph',        // 接收 data_rev 用于 morph 动画
  STAGE: 'stage',        // 未来扩展:分阶段推送
  AUDIO: 'audio',        // 未来扩展:音频流
  GESTURE: 'gesture',    // 未来扩展:手势
};

const DEFAULT_CAPS = [HELLO_CAPS.SCENE, HELLO_CAPS.PATCH, HELLO_CAPS.MORPH];

const INBOUND_TYPES = new Set(['hello', 'resync', 'intent', 'ping', 'pong']);
const LEGACY_INBOUND = new Set(['scene:resync', 'scene:intent', 'pong', 'scene:pong']);

// 旧→新 类型映射(用于回退兼容)
const LEGACY_TYPE_MAP = {
  'scene:resync': 'resync',
  'scene:intent': 'intent',
  'pong': 'pong',
  'scene:pong': 'pong',
};

/**
 * 给消息加 v:1 信封
 */
function envelope(type, payload = {}) {
  return {
    v: PROTOCOL_VERSION,
    type,
    ...payload,
  };
}

/**
 * 校验入站消息
 * @returns {{ ok: true, type: string, payload: object } | { ok: false, reason: string }}
 */
function validateInbound(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'message must be object' };
  }

  // v:1 信封(必备)
  if (raw.v !== PROTOCOL_VERSION) {
    // 尝试作为 legacy 消息处理
    if (raw.type && LEGACY_INBOUND.has(raw.type)) {
      return {
        ok: true,
        type: LEGACY_TYPE_MAP[raw.type] || raw.type.replace(/^scene:/, ''),
        payload: raw,
        legacy: true,
      };
    }
    return { ok: false, reason: `unsupported protocol version: ${raw.v}` };
  }

  if (!raw.type || typeof raw.type !== 'string') {
    return { ok: false, reason: 'missing type' };
  }

  if (!INBOUND_TYPES.has(raw.type)) {
    // 未知 type 必须忽略(前向兼容)
    return { ok: false, reason: `unknown type: ${raw.type}`, ignore: true };
  }

  return { ok: true, type: raw.type, payload: raw };
}

/**
 * 生成 welcome 消息
 */
function buildWelcome(rev, serverVersion = '2.3.0') {
  return envelope('welcome', {
    rev,
    serverVersion,
    protocol: 'crabpaw-scene-v1',
    supportedCaps: Object.values(HELLO_CAPS),
  });
}

/**
 * 生成全量 scene 消息
 */
function buildScene(rev, surfaces) {
  return envelope('scene', {
    rev,
    surfaces,
  });
}

/**
 * 生成 scene.patch 增量
 */
function buildScenePatch(rev, base, ops) {
  return envelope('scene.patch', {
    rev,
    base,
    ops,
  });
}

/**
 * 生成 ping
 */
function buildPing() {
  return envelope('ping', { ts: Date.now() });
}

/**
 * 生成 pong
 */
function buildPong() {
  return envelope('pong', { ts: Date.now() });
}

/**
 * 生成 scene:resync-ack
 */
function buildResyncAck(rev, reason = 'requested') {
  return envelope('scene:resync-ack', { rev, reason });
}

/**
 * 生成 scene:error
 */
function buildError(message, code = 'PROTOCOL_ERROR', extra = {}) {
  return envelope('scene:error', {
    error: message,
    code,
    ...extra,
  });
}

/**
 * 客户端握手信息
 */
class ClientHandshake {
  /**
   * @param {string} shell        客户端标识
   * @param {string} shellVersion
   * @param {string[]} caps
   * @param {number} ackRev
   */
  constructor(shell, shellVersion, caps, ackRev) {
    this.shell = shell || 'unknown';
    this.shellVersion = shellVersion || '0.0.0';
    this.caps = Array.isArray(caps) ? caps.filter(c => typeof c === 'string') : [];
    this.ackRev = Number.isFinite(ackRev) ? ackRev : 0;
    this.handshakedAt = Date.now();
  }

  has(cap) {
    return this.caps.includes(cap);
  }

  /**
   * 协商后确定的能力配置
   */
  negotiated() {
    return {
      sendScene: this.has(HELLO_CAPS.SCENE),                    // 必为 true
      sendPatch: this.has(HELLO_CAPS.PATCH),
      sendDataRev: this.has(HELLO_CAPS.MORPH),
    };
  }
}

/**
 * 处理 hello 握手
 * @param {object} msg
 * @returns {{ ok: true, handshake: ClientHandshake } | { ok: false, error: string }}
 */
function handleHello(msg) {
  if (!msg || msg.v !== PROTOCOL_VERSION || msg.type !== 'hello') {
    return { ok: false, error: 'invalid hello message' };
  }
  const handshake = new ClientHandshake(
    msg.shell,
    msg.shellVersion,
    Array.isArray(msg.caps) ? msg.caps : DEFAULT_CAPS,
    msg.rev
  );
  // 强制 scene 能力(必备)
  if (!handshake.has(HELLO_CAPS.SCENE)) {
    handshake.caps.unshift(HELLO_CAPS.SCENE);
  }
  return { ok: true, handshake };
}

/**
 * 处理 resync 请求
 * @param {object} msg
 * @returns {{ ok: true, reason: string } | { ok: false, error: string }}
 */
function handleResync(msg) {
  if (!msg || msg.v !== PROTOCOL_VERSION || msg.type !== 'resync') {
    return { ok: false, error: 'invalid resync message' };
  }
  const reason = ['gap', 'init', 'error'].includes(msg.reason) ? msg.reason : 'init';
  return { ok: true, reason };
}

/**
 * 处理 intent 消息(标准化)
 * @param {object} msg
 * @returns {{ ok: true, intent: object } | { ok: false, error: string }}
 */
function handleIntent(msg) {
  if (!msg || msg.v !== PROTOCOL_VERSION || msg.type !== 'intent') {
    return { ok: false, error: 'invalid intent message' };
  }
  return {
    ok: true,
    intent: {
      surface: msg.surface || null,
      name: msg.name || 'unknown',
      data: msg.data || {},
      ts: Number.isFinite(msg.ts) ? msg.ts : Date.now(),
    },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  HELLO_CAPS,
  DEFAULT_CAPS,
  INBOUND_TYPES,
  envelope,
  validateInbound,
  buildWelcome,
  buildScene,
  buildScenePatch,
  buildPing,
  buildPong,
  buildResyncAck,
  buildError,
  ClientHandshake,
  handleHello,
  handleResync,
  handleIntent,
};
