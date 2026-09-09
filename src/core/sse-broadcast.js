// AG-UI 双名映射适配层(2026-08-14, GUI 全量修复 P1)——旧事件名原样保留, 新 AG-UI 名追加广播
try { const { mapToAgui } = require('./agui-adapter'); global.__aguiMap = mapToAgui; } catch (e) { console.error('[sse-broadcast] agui-adapter 加载失败(降级旧协议):', e.message); }
try { const { feed: turnTrackerFeed } = require('./turn-tracker'); global.__turnTracker = turnTrackerFeed; } catch (e) { console.error('[sse-broadcast] turn-tracker 加载失败(step 边界不派生):', e.message); }
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./config');
const sseClients = new Set();
// 2026-08-18 AG-UI 协议化: 每帧 seq + 环形重放缓冲(参考 deepseek-harness
// "断线重开流 + lastSeq 回填"形状)
// C3(Runtime差距分析): 事件流持久化——此前注释自认"无持久会话日志, 内存缓冲兜底",
// 重启后 seq 归零、重放环清空,断线补发跨重启失效。现在每帧追加 JSONL 落盘
// (DATA_DIR/events/stream.jsonl, 异步队列不阻塞广播),启动时读尾部恢复
// replayRing 与 seq 连续性——重启后 since=旧值 仍能补拉遗漏帧。
const REPLAY_MAX = 500;
let nextSeq = 0;
const replayRing = []; // { seq, event, data }
let heartbeatInterval = null;

// ── C3: 事件日志持久化 ─────────────────────────────────────────────
const EVENT_LOG_DIR = path.join(DATA_DIR, 'events');
const EVENT_LOG_FILE = path.join(EVENT_LOG_DIR, 'stream.jsonl');
const EVENT_LOG_MAX_BYTES = 20 * 1024 * 1024;      // 单文件 20MB 上限,超过轮转为 .1
const EVENT_LOG_TAIL_BYTES = 512 * 1024;           // 启动恢复只读尾部 512KB
let eventLogEnabled = process.env.JEST_WORKER === undefined
  && process.env.CRABPAW_DISABLE_EVENT_LOG !== '1';
let _eventLogChain = Promise.resolve();             // 串行追加链,保帧序
let _writesSinceRotationCheck = 0;

function _persistEvent(seq, event, data) {
  if (!eventLogEnabled) return;
  try {
    // 目录懒创建——appendFile 只建文件不建父目录
    if (!fs.existsSync(EVENT_LOG_DIR)) fs.mkdirSync(EVENT_LOG_DIR, { recursive: true });
    const line = JSON.stringify({ seq, event, data, ts: Date.now() }) + '\n';
    _eventLogChain = _eventLogChain.then(() => new Promise((resolve) => {
      try {
        fs.appendFile(EVENT_LOG_FILE, line, () => resolve());
      } catch (e) { resolve(); }
    })).catch(() => {
      // 持久化是可观测性旁路——失败即禁用,绝不影响广播主流程
      eventLogEnabled = false;
      console.warn('[sse-broadcast] 事件日志写入失败,持久化已禁用');
    });
    if (++_writesSinceRotationCheck >= 1000) {
      _writesSinceRotationCheck = 0;
      _rotateEventLogIfNeeded();
    }
  } catch (e) { /* 不影响广播 */ }
}

function _rotateEventLogIfNeeded() {
  try {
    if (!fs.existsSync(EVENT_LOG_FILE)) return;
    if (fs.statSync(EVENT_LOG_FILE).size < EVENT_LOG_MAX_BYTES) return;
    const backup = EVENT_LOG_FILE + '.1';
    try { fs.unlinkSync(backup); } catch (e) { /* 首次无备份 */ }
    fs.renameSync(EVENT_LOG_FILE, backup);
  } catch (e) { console.warn('[sse-broadcast] 事件日志轮转失败(忽略):', e.message); }
}

function _restoreFromEventLog() {
  if (!eventLogEnabled) return;
  try {
    if (!fs.existsSync(EVENT_LOG_FILE)) return;
    const st = fs.statSync(EVENT_LOG_FILE);
    const readBytes = Math.min(st.size, EVENT_LOG_TAIL_BYTES);
    const start = st.size - readBytes;
    const fd = fs.openSync(EVENT_LOG_FILE, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0 && lines.length > 0) lines.shift(); // 丢弃截断的首行
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (typeof rec.seq !== 'number' || typeof rec.event !== 'string') continue;
        nextSeq = Math.max(nextSeq, rec.seq);
        replayRing.push({ seq: rec.seq, event: rec.event, data: rec.data });
      } catch (e) { /* 坏行跳过 */ }
    }
    while (replayRing.length > REPLAY_MAX) replayRing.shift();
    if (nextSeq > 0) console.log(`[sse-broadcast] 事件日志恢复: 重放环 ${replayRing.length} 帧, seq 续至 ${nextSeq}`);
  } catch (e) {
    console.warn('[sse-broadcast] 事件日志恢复失败(忽略):', e.message);
  }
}
_restoreFromEventLog();
// ── C3 结束 ────────────────────────────────────────────────────────

function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    const ping = `:heartbeat\n\n`;
    for (const client of sseClients) {
      try {
        client.write(ping);
      } catch (e) {
        sseClients.delete(client);
      }
    }
  }, 15000);
}

function broadcastEvent(eventType, data) {
  let sent = 0;
  // Task 3 接线 turn-tracker: 派生 step 边界事件先广播(递归由 tracker 忽略 step:* 输入防环)
  const derived = (typeof global.__turnTracker === 'function') ? global.__turnTracker(eventType, data) : [];
  for (const d of derived) sent += broadcastEvent(d.type, d);
  // 决策溯源旁路（2026-08-20）：旁路折叠 run 级决策 → 哈希链落库；失败只记日志不阻断主流
  if (typeof global.__decisionFeed === 'function') {
    try { global.__decisionFeed(eventType, data); } catch (e) { console.error('[sse-broadcast] 决策旁路异常:', e && e.message); }
  }
  const seq = ++nextSeq;
  const message = `id: ${seq}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  // 仅非 heartbeat 事件打印日志，避免高频日志输出
  if (eventType !== 'heartbeat') {
    console.log(`📡 SSE 广播 [${eventType}], 客户端数: ${sseClients.size}`);
  }
  // 2026-08-18 终审 I1: 主帧必须先于 AG-UI 双名帧入环——直播序为主帧(n)后双名帧(n+1),
  // 重放按环序回放; 若先入 AG-UI 帧, 客户端按 seq 去重(seq<=lastSeq)时 AG-UI 帧已把
  // lastSeq 抬到 n+1, 旧名主帧 n 会被当重复帧吞掉(重放不得反转直播序)。派生的 step
  // 帧在递归内同样先推自己的主帧, 环序 = [step:start(n), primary(n+1), AG-UI(n+2)]。
  replayRing.push({ seq, event: eventType, data });
  if (replayRing.length > REPLAY_MAX) replayRing.shift();
  _persistEvent(seq, eventType, data);
  for (const client of sseClients) {
    try {
      client.write(message);
      sent++;
    } catch (e) {
      sseClients.delete(client);
    }
  }
  // AG-UI 双名广播(参考 D:/Down/ag-ui-main): 旧名零改动, 追加标准事件帧
  const aguiFrames = (typeof global.__aguiMap === 'function') ? global.__aguiMap(eventType, data) : [];
  if (aguiFrames.length > 0) {
    for (const frame of aguiFrames) {
      const frameSeq = ++nextSeq;
      const aguiMessage = 'id: ' + frameSeq + '\nevent: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n';
      for (const client of sseClients) {
        try { client.write(aguiMessage); } catch (e) { sseClients.delete(client); }
      }
      replayRing.push({ seq: frameSeq, event: frame.type, data: frame });
      if (replayRing.length > REPLAY_MAX) replayRing.shift();
      _persistEvent(frameSeq, frame.type, frame);
    }
  }
  return sent;
}

function handleSSE(req, res) {
  console.log('🔌 SSE 客户端连接, 当前客户端数:', sseClients.size + 1);

  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const origin = req.headers.origin || '';
  let corsOrigin = '';
  if (allowedOrigin && allowedOrigin !== '*') {
    corsOrigin = allowedOrigin;
  } else if (origin) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
        corsOrigin = origin;
      }
    } catch (e) {
      /* 忽略错误 */
      console.warn('[sse-broadcast.js] 空 catch 补日志:', e && e.message);
    }

  }

  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
  }

  res.writeHead(200, headers);

  // 2026-08-18 AG-UI 协议化: 断线补拉——EventSource 自动带 Last-Event-ID 头,
  // IPC/手动重连带 ?since=; 重放缓冲内 seq > since 的帧先发, 再进入直播
  let since = null;
  const lastEventId = req.headers && req.headers['last-event-id'];
  if (lastEventId && /^\d+$/.test(lastEventId)) since = Number(lastEventId);
  if (since == null && req.url) {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams.get('since');
      if (q && /^\d+$/.test(q)) since = Number(q);
    } catch (e) { console.error('[sse-broadcast] since 解析失败:', e && e.message); }
  }
  if (since != null) {
    for (const item of replayRing) {
      if (item.seq > since) {
        try { res.write(`id: ${item.seq}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`); } catch (e) { console.error('[sse-broadcast] 重放帧写入失败:', e && e.message); break; }
      }
    }
  }

  // 2026-08-18 终审 I2: connected 帧携带当前 seq——C3 持久化后重启亦保持连续
  // (此前归零重计, 客户端须作废旧 lastSeq, 否则重放 since=旧值拉不到任何帧→静默黑障)。
  // 此帧不带 id: 行——不参与客户端 seq 去重, 仅作对账信号。
  res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', timestamp: Date.now(), seq: nextSeq })}\n\n`);

  sseClients.add(res);
  startHeartbeat();

  req.on('close', () => {
    sseClients.delete(res);
    console.log('🔌 SSE 客户端断开, 当前客户端数:', sseClients.size);
  });
}

function getSSEClientCount() {
  return sseClients.size;
}

// 2026-08-15(T7): 测试注入用——订阅/注销假客户端以捕获广播帧（evals expert-collaboration）。
function addSSEClient(res) {
  if (res && typeof res.write === 'function') sseClients.add(res);
}
function removeSSEClient(res) {
  sseClients.delete(res);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

module.exports = {
  broadcastEvent,
  handleSSE,
  getSSEClientCount,
  stopHeartbeat,
  addSSEClient,
  removeSSEClient,
  _resetStreamState: () => { nextSeq = 0; replayRing.length = 0; },
};
