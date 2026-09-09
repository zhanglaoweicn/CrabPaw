/**
 * Agent 循环行为锁定(characterization)——Loop 第五刀前置安全网(2026-09-04)
 *
 * 目的: 在把轮次骨架从 chat() 抽为 agent/loop-skeleton 的 runAgentLoop 之前,
 * 用"本地 mock LLM server + 注册 fake 工具"让 chat() 走完整循环, 锁定当前行为。
 * 第五刀动刀时本文件必须原样绿——它们描述的是"现在的行为"(无论好坏)。
 *
 * 方式: config.models.providers.custom.baseUrl 指向本地 mock(model-router 对
 * custom 优先用配置 baseUrl), chat() 的真实 fetch 打到 mock; registry 注册
 * FakeEcho fake 工具。DATA_DIR 隔离(同 evals 隔离机制)防落库污染。
 */

const http = require('http');
const { installIsolatedDataDir } = require('../../evals/isolated-data-dir');

installIsolatedDataDir();

const ai = require('../core/ai');
const { registry } = require('../tools/registry');
const { getModelRouter, createModelRouter } = require('../core/model-router');

jest.setTimeout(60000); // chat 全流程含网络回环与降级路径, 高于默认 5s

// ── mock LLM server ──────────────────────────────────────────
let server = null;
let port = null;
let llmRequests = [];
let llmScript = []; // 每轮返回值队列(耗尽后重复最后一项)

function startMockLlm() {
  llmRequests = [];
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (e) { /* ignore */ }
      llmRequests.push({
        url: req.url,
        messages: parsed.messages || [],
        toolChoice: parsed.tool_choice || null,
      });
      // 防自旋守卫: 降级/终答请求(无 tools 或 tool_choice none)必须返回纯 content——
      // 否则 mock 永远回 tool_calls 会让 chat 降级路径无限自旋
      const isFinalAnswerRequest = !Array.isArray(parsed.tools) || parsed.tools.length === 0
        || parsed.tool_choice === 'none';
      // 脚本索引用"每次 setScript 重置的本地计数"(llmRequests 跨场景累积, 不能做索引)
      const step = llmScript[Math.min(scriptIndex, llmScript.length - 1)];
      scriptIndex++;
      // 终答请求覆盖为纯 content(不 mutate 共享脚本条目)
      const message = isFinalAnswerRequest
        ? { role: 'assistant', content: '降级终答(mock 守卫)' }
        : step.message;
      // 防挂起: 每请求回 Connection close(fetch keep-alive 会让 server.close 永不完成)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
      res.end(JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
    });
  });
}

let scriptIndex = 0;

function setScript(steps) {
  llmScript = steps;
  scriptIndex = 0;
}

// ── fake 工具 ────────────────────────────────────────────────
const fakeEchoCalls = [];

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  startMockLlm();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  registry.register({
    name: 'FakeEcho',
    toolset: 'general',
    category: 'testing',
    description: '行为锁定测试用的回声工具',
    riskLevel: 'low',
    schema: {
      type: 'object',
      properties: { x: { type: 'string', description: '回声内容' } },
      required: ['x'],
    },
    handler: (params) => {
      fakeEchoCalls.push(params);
      return { content: `工具回声: x=${params && params.x}` };
    },
  });

  // mock provider(model-router 对 custom 优先用配置 baseUrl)
  // getModelRouter 单例可能尚未创建(null)——先 createModelRouter(makeConfig 形状)
  const mockConfig = makeConfig();
  const router = getModelRouter() || createModelRouter(mockConfig);
  router.models = mockConfig.models;
  router.providers = mockConfig.models.providers;
  router.currentProvider = 'custom';
  router.config = mockConfig;
});

afterAll(async () => {
  // keep-alive 连接强制断开——否则 server.close 等待 socket 永不完成(jest 挂起根因)
  if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // teardown(同 ai.smoke 模式, 防异步泄漏)
  try {
    const lifecycleManager = require('../core/lifecycle-manager');
    lifecycleManager.shutdown?.();
    ai.globalHeartbeatPatrol?.stop?.();
    const { contextCache } = require('../core/context-cache');
    contextCache?.destroy?.();
  } catch (e) { /* best-effort */ }
  jest.clearAllTimers();
});

function makeConfig(userId) {
  return {
    chatChannel: ['none'],
    models: {
      currentProvider: 'custom',
      providers: {
        custom: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'mock-model' },
      },
    },
  };
}

const msgOf = (i) => llmRequests[i] && llmRequests[i].messages;

describe('Agent 循环行为锁定(characterization)', () => {
  test('C1 单轮直答: 无 tool_calls → 直接返回 content, LLM 调用 1 次', async () => {
    const base = llmRequests.length;
    setScript([{ message: { role: 'assistant', content: '最终答案A' } }]);
    const reply = await ai.chat(makeConfig(), [], 'char_c1', '测试问题C1');
    expect(reply).toContain('最终答案A');
    expect(llmRequests.length - base).toBe(1);
    const last = msgOf(0)[msgOf(0).length - 1];
    expect(last.role).toBe('user');
    // 2026-09-04 实测: prompt-cache 优化会把 user content 转成 cache_control 块数组
    const contentStr = JSON.stringify(last.content);
    expect(contentStr).toContain('测试问题C1');
  });

  test('C2 一轮工具+二轮终答: FakeEcho 真实执行, tool 消息回填 tool_call_id 与结果', async () => {
    setScript([
      { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'FakeEcho', arguments: JSON.stringify({ x: 'hello' }) } }] } },
      { message: { role: 'assistant', content: '最终答案B' } },
    ]);
    const base2 = llmRequests.length;
    const reply = await ai.chat(makeConfig(), [], 'char_c2', '请回声 hello');
    expect(reply).toContain('最终答案B');
    expect(fakeEchoCalls.some((p) => p && p.x === 'hello')).toBe(true);
    // 第 2 次请求应包含 role:'tool' 回填
    expect(llmRequests.length - base2).toBe(2);
    const toolMsgs = msgOf(base2 + 1).filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
    expect(toolMsgs[0].tool_call_id).toBe('call_1');
    expect(JSON.stringify(toolMsgs[0].content)).toContain('工具回声');
  });

  test('C3 needsConfirmation: checkPermissions 返回 ask 时 chat 提前返回确认话术', async () => {
    // 2026-09-04 实测: needsConfirmation 来自工具的 checkPermissions(behavior:'ask')——
    // executeToolCall 成功返回只带 {success,content}, handler 返回的其他字段会被剥掉
    registry.register({
      name: 'FakeConfirm',
      toolset: 'general',
      category: 'testing',
      description: '要求确认的假工具',
      riskLevel: 'medium',
      schema: { type: 'object', properties: {} },
      checkPermissions: async () => ({ behavior: 'ask', message: '要删除重要文件', suggestions: [] }),
      handler: () => ({ content: '不应执行到' }),
    });
    setScript([
      { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_c3', type: 'function', function: { name: 'FakeConfirm', arguments: '{}' } }] } },
      { message: { role: 'assistant', content: '不应到达' } },
    ]);
    const base3 = llmRequests.length;
    const reply = await ai.chat(makeConfig(), [], 'char_c3', '删除文件');
    // 2026-09-04 诊断: 第一请求是否带 FakeConfirm / chat 是否真走了执行
    console.log('DIAG-C3 llmRequests 总数:', llmRequests.length, '| reply 头 60:', String(reply).slice(0, 60).replace(/\n/g, ' '));
    expect(reply).toContain('需要确认');
    expect(llmRequests.length - base3).toBe(1); // 提前返回, 第二轮不发生
  });

  test('C4 8 轮上限: mock 永远返回 tool_calls → 预算强制终答(降级产物非空)', async () => {
    setScript(Array.from({ length: 12 }, (_, i) => ({
      message: { role: 'assistant', content: '', tool_calls: [{ id: `call_inf_${i}`, type: 'function', function: { name: 'FakeEcho', arguments: JSON.stringify({ x: `v${i}` }) } }] },
    })));
    const reply = await ai.chat(makeConfig(), [], 'char_c4', '无限工具循环测试');
    expect(typeof reply).toBe('string');
    expect(reply.length).toBeGreaterThan(0);
    // 轮次上限 8: LLM 调用次数应有界。2026-09-07 finalAnswerRound 3→6(loop-contract
    // 契约单源)——收答前可用工具轮从 3 扩到 6, "永远回工具调用"的 mock 在预算强制
    // 收口前消耗更多请求, 上界随契约放宽到 8 轮 + 降级终答容差 4。
    expect(llmRequests.length).toBeLessThanOrEqual(12);
  });

  test('C5 循环防护硬限: 同参数重复调用 → FakeEcho 执行次数有界(第四刀修复验证)', async () => {
    fakeEchoCalls.length = 0; // 本场景独立计数(前序场景已消耗 FakeEcho 次数)
    setScript(Array.from({ length: 12 }, () => ({
      message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_rep', type: 'function', function: { name: 'FakeEcho', arguments: JSON.stringify({ x: 'repeat' }) } }] },
    })));
    const reply = await ai.chat(makeConfig(), [], 'char_c5', '重复调用测试');
    expect(typeof reply).toBe('string');
    const executed = fakeEchoCalls.filter((p) => p && p.x === 'repeat').length;
    // 第四刀修复: 被硬限的调用不再真实执行 → 执行次数应显著小于轮次(12)
    expect(executed).toBeLessThan(10);
  });
});
