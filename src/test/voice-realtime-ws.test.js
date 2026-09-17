/**
 * Voice Realtime WS 回归测试（2026-09-17）
 *
 * 覆盖 /voice/realtime 的关键契约（豆包 Seeduplex 全双工代理）：
 * - 升级门: 无 token 401 / 路径不匹配不劫持其它 upgrade
 * - 会话建立: config 帧 → 火山 session.create(model 1.2.6.1) → tools 走 session.update
 *   （PoC 实测: tools 放 session.create 被忽略——回归钉死）
 * - 上行节奏化: 二进制 PCM → 20ms/640B input_audio_buffer.append(base64)
 * - 任务委托: 转写 completed 命中 detectTaskMode → delegate 事件 + response.cancel
 * - FC token 解析: <|FunctionCallBegin|>[...] → delegate（PoC 实测模型以此形式吐调用）
 * - 回喂: speak → speech_text_buffer.commit
 * - 静音保活: 队列饥饿 → input_audio_mute.commit（AudioServerNoAudioInputTooLong 防线）
 *
 * 上游用注入的 mock 工厂（密封, 不连火山/不读真实 config.json）。
 */

const http = require('http');
const { WebSocket } = require('ws');

const { attachVoiceRealtimeWS, destroyVoiceRealtimeWS } = require('../handlers/voice-realtime-ws');

// ─── 测试基建 ──────────────────────────────────────────────

/** 可编程 mock 上游: 记录发出帧, 允许测试注入下行事件 */
function createMockUpstreamFactory() {
  const created = [];
  const factory = () => {
    const listeners = {};
    const sentFrames = [];
    const mock = {
      readyState: WebSocket.OPEN,
      sentFrames,
      on: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); return mock; },
      send: (data) => { sentFrames.push(String(data)); },
      close: () => { mock.readyState = WebSocket.CLOSED; (listeners.close || []).forEach(cb => cb(1000, '')); },
      // 测试驱动: 模拟火山下行
      emitUpstream: (obj) => { (listeners.message || []).forEach(cb => cb(Buffer.from(JSON.stringify(obj)))); },
      emitOpen: () => { (listeners.open || []).forEach(cb => cb()); },
    };
    created.push(mock);
    return mock;
  };
  factory.created = created;
  return factory;
}

function startServer(apiKey, factory, configOverride) {
  const server = http.createServer(() => {});
  attachVoiceRealtimeWS(server, { apiKey, upstreamFactory: factory, configOverride });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function connectWs(port, token, path = '/voice/realtime') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`);
    const messages = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const w = waiters.findIndex((fn) => fn(msg));
      if (w >= 0) { waiters.splice(w, 1)[0](msg); return; }
      messages.push(msg);
    });
    const wait = (pred, timeoutMs = 3000) => new Promise((res, rej) => {
      const found = messages.find(pred);
      if (found) return res(found);
      const timer = setTimeout(() => rej(new Error('wait 超时: ' + (pred.toString().slice(0, 60)))), timeoutMs);
      waiters.push((msg) => { if (pred(msg)) { clearTimeout(timer); res(msg); return true; } return false; });
    });
    ws.on('open', () => resolve({ ws, messages, wait }));
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { statusCode: res.statusCode })));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST_CONFIG = { apiKey: 'test-volc-key', appId: '', accessKey: '', voice: 'zh_female_vv_jupiter_bigtts', instructions: 'test instructions' };

/** 建立到 mock 上游的完整会话: config 帧 → 上游 open → 火山 session.created → ready */
async function openRealtimeSession(port, factory, sessionId) {
  const client = await connectWs(port, 'tok');
  client.ws.send(JSON.stringify({ type: 'config', sessionId }));
  // 等 mock 上游被创建（config 帧处理是异步的）
  for (let i = 0; i < 50 && !factory.created[0]; i++) await sleep(10);
  const mock = factory.created[0];
  if (!mock) throw new Error('config 帧未创建 mock 上游');
  mock.emitOpen();
  mock.emitUpstream({ type: 'session.created', event_id: 'e1', session: { id: sessionId || 'volc-1' } });
  await client.wait((m) => m.type === 'ready');
  return { client, mock };
}

// ─── 用例 ──────────────────────────────────────────────

describe('voice-realtime-ws /voice/realtime', () => {
  let ctx;

  afterEach(() => {
    if (ctx) { ctx.server.close(); ctx = null; }
    destroyVoiceRealtimeWS();
  });

  test('无 token 连接被 401 拒绝（入口守卫回归）', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('secret-token', factory, TEST_CONFIG);
    ctx = { server };
    await expect(connectWs(port, 'wrong-token')).rejects.toMatchObject({ statusCode: 401 });
  });

  test('config 帧 → 火山 session.create + tools 走 session.update + ready 通知', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's1');

    const create = mock.sentFrames.map((f) => JSON.parse(f)).find((f) => f.type === 'session.create');
    expect(create.session.model).toBe('1.2.6.1');
    expect(create.session.audio.input.format.rate).toBe(16000);
    // PoC 实测: session.create 里的 tools 被服务端忽略 → 回归钉死"不在 create 里带 tools"
    expect(create.session.tools).toBeUndefined();

    const update = mock.sentFrames.map((f) => JSON.parse(f)).find((f) => f.type === 'session.update');
    expect(update).toBeTruthy();
    expect(update.session.tools[0].name).toBe('delegate_task');
    client.ws.close();
  });

  test('二进制 PCM → 20ms/640B 节奏化 append（base64）', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's2');

    // 送 20ms 恰好一包(640B) + 等 3 个 pacing tick
    const pcm = Buffer.alloc(640, 0);
    pcm.writeInt16LE(1000, 0);
    client.ws.send(pcm);
    await sleep(120);

    const appends = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'input_audio_buffer.append');
    expect(appends.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(appends[0].audio, 'base64').length).toBe(640);
    client.ws.close();
  });

  test('任务转写 → delegate 事件 + response.cancel（任务检测路径）', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's3');

    mock.emitUpstream({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1', content_index: 0,
      text: '帮我写一篇关于OPC的文章',
    });

    const delegated = await client.wait((m) => m.type === 'delegate', 3000);
    expect(delegated.utterance).toContain('OPC');
    expect(delegated.source).toBe('detector');
    const cancels = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'response.cancel');
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    client.ws.close();
  });

  test('闲聊转写不委托（检测器负样本回归）', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's4');

    mock.emitUpstream({ type: 'conversation.item.input_audio_transcription.completed', text: '你好呀，最近怎么样？' });
    const asr = await client.wait((m) => m.type === 'asr' && m.final, 3000);
    expect(asr.text).toContain('你好');
    await sleep(150);
    expect(client.messages.filter((m) => m.type === 'delegate')).toHaveLength(0);
    client.ws.close();
  });

  test('模型 FC token（<|FunctionCallBegin|>）解析为委托', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's5');

    mock.emitUpstream({ type: 'response.output_text.delta', delta: '<|FunctionCallBegin|>[{"name":"delegate_task"' });
    mock.emitUpstream({ type: 'response.output_text.delta', delta: ',"arguments":{"utterance":"查询明天北京天气"}}]<|FunctionCallEnd|>' });
    mock.emitUpstream({ type: 'response.output_text.done', text: '<|FunctionCallBegin|>[{"name":"delegate_task","arguments":{"utterance":"查询明天北京天气"}}]<|FunctionCallEnd|>' });

    const delegated = await client.wait((m) => m.type === 'delegate', 3000);
    expect(delegated.utterance).toBe('查询明天北京天气');
    expect(delegated.source).toBe('model-fc');
    client.ws.close();
  });

  test('speak 回喂 → speech_text_buffer.commit', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's6');

    client.ws.send(JSON.stringify({ type: 'speak', text: '任务已受理，卡片在屏幕上' }));
    await sleep(80);
    const speaks = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'speech_text_buffer.commit');
    expect(speaks).toHaveLength(1);
    expect(speaks[0].text).toBe('任务已受理，卡片在屏幕上');
    client.ws.close();
  });

  test('上行断流 → input_audio_mute.commit 保活（防 AudioServerNoAudioInputTooLong）', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's7');

    // 不送任何音频, 等 300ms 节奏化饥饿门槛(STARVE_MUTE_TICKS=15×20ms)
    await sleep(700);
    const mutes = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'input_audio_mute.commit');
    expect(mutes.length).toBeGreaterThanOrEqual(1);
    client.ws.close();
  });

  test('interrupt 控制帧 → response.cancel 透传 + cancelled 确认', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's8');

    client.ws.send(JSON.stringify({ type: 'interrupt' }));
    const cancelled = await client.wait((m) => m.type === 'cancelled', 3000);
    expect(cancelled).toBeTruthy();
    const cancels = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'response.cancel');
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    client.ws.close();
  });

  test('查询类话题(台风/天气)即时委托 + 委托语音回执', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's12');

    mock.emitUpstream({ type: 'conversation.item.input_audio_transcription.completed', text: '最近有台风吗' });
    const delegated = await client.wait((m) => m.type === 'delegate', 3000);
    expect(delegated.source).toBe('lookup');
    // 委托回执: 消除无声真空期 + 话题化话术(回归"统一回复生硬"反馈)
    const acks = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'speech_text_buffer.commit');
    expect(acks).toHaveLength(1);
    expect(acks[0].text).toContain('台风');
    client.ws.close();
  });

  test('静音尾窗音频缓冲, 解除静音后按序补播(快接话不丢字回归)', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's13');

    // 模型播报中(GUI 发 mute) → 用户开口(尾窗音频) → 播完(GUI 发 unmute)
    client.ws.send(JSON.stringify({ type: 'mute' }));
    client.ws.send(Buffer.alloc(640, 1));
    client.ws.send(JSON.stringify({ type: 'unmute' }));
    await sleep(200);
    const appends = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'input_audio_buffer.append');
    expect(appends.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(appends[0].audio, 'base64').equals(Buffer.alloc(640, 1))).toBe(true);
    client.ws.close();
  });

  test('媒体播放类即时委托(回归: 实时模型自己开唱)', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's14');

    mock.emitUpstream({ type: 'conversation.item.input_audio_transcription.completed', text: '播放周杰伦的歌' });
    const delegated = await client.wait((m) => m.type === 'delegate', 3000);
    expect(delegated.source).toBe('media');
    // 回执: 媒体类话术
    const acks = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'speech_text_buffer.commit');
    expect(acks).toHaveLength(1);
    expect(acks[0].text).toContain('安排');
    client.ws.close();
  });

  test('面板/卡片指令 → 委托（实时模型无面板工具, 回归：打开天气卡片）', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's9');

    mock.emitUpstream({ type: 'conversation.item.input_audio_transcription.completed', text: '打开天气卡片' });
    const delegated = await client.wait((m) => m.type === 'delegate', 3000);
    expect(delegated.utterance).toContain('天气');
    expect(delegated.source).toBe('panel-cmd');
    const cancels = mock.sentFrames.map((f) => JSON.parse(f)).filter((f) => f.type === 'response.cancel');
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    client.ws.close();
  });

  test('模型沉默兜底: 非任务转写后 4s 无输出 → 委托主链路', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's10');

    mock.emitUpstream({ type: 'conversation.item.input_audio_transcription.completed', text: '给我讲个笑话吧' });
    // 正常输出活动会取消兜底: 无任何 delta/音频 → 4s(SILENCE_FALLBACK_MS)+余量后应委托
    const delegated = await client.wait((m) => m.type === 'delegate', 6000);
    expect(delegated.utterance).toContain('笑话');
    expect(delegated.source).toBe('fallback');
    client.ws.close();
  });

  test('模型有输出活动则沉默兜底不触发', async () => {
    const factory = createMockUpstreamFactory();
    const { server, port } = await startServer('tok', factory, TEST_CONFIG);
    ctx = { server };
    const { client, mock } = await openRealtimeSession(port, factory, 's11');

    mock.emitUpstream({ type: 'conversation.item.input_audio_transcription.completed', text: '你好呀，最近怎么样？' });
    mock.emitUpstream({ type: 'response.output_text.delta', delta: '我挺好的呀。' });
    mock.emitUpstream({ type: 'response.output_audio.started' });
    mock.emitUpstream({ type: 'response.output_audio.done' });
    await sleep(4600);
    expect(client.messages.filter((m) => m.type === 'delegate')).toHaveLength(0);
    client.ws.close();
  });
});
