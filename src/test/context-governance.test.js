/**
 * 会话上下文膨胀治理回归测试（2026-09-18 层0/2/3）
 *
 * 背景: voice_shell_user 会话实测 83612 tokens(超限 1022%),根因三层——
 *   层0: 生产模型 deepseek-flash 不在窗口表内 → 兜底 8K → 压缩器跟假阈值(5600)搏斗
 *   层2: 压缩器按条数压缩,一轮摘不完全进入预算,且"连续无效"熔断挡住追压
 *   层3: 尾部保护窗按条数强护(最少3条),巨消息落在尾部被无条件护住 → 每轮只省 2%
 * 本文件钉死三层修复行为。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-governance-'));
process.env.CRABPAW_DATA_DIR = TMP_ROOT;

const {
  resolveContextWindowInfo,
} = require('../core/context-window-guard');
const ContextCompressor = require('../core/context/compressor');
const { estimateMessagesTokens } = require('../core/context/compressor');
const { sanitizeMessagesForProvider } = require('../core/tool-call-id');

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function makeCompressor(opts = {}) {
  return new ContextCompressor({ quietMode: true, ...opts });
}

describe('层0: 模型窗口解析', () => {
  test('deepseek-flash 精确命中表(128K),不再落兜底', () => {
    const info = resolveContextWindowInfo({ provider: 'deepseek', modelId: 'deepseek-flash' });
    expect(info.tokens).toBe(128000);
    expect(info.source).toBe('modelMap');
  });

  test('deepseek 家族前缀兜底 128K(未知的具体型号)', () => {
    const info = resolveContextWindowInfo({ provider: 'deepseek', modelId: 'deepseek-whatever-new' });
    expect(info.tokens).toBe(128000);
    expect(info.source).toBe('prefix');
  });

  test('完全未识别模型兜底 32K(而非旧 8K)', () => {
    const info = resolveContextWindowInfo({ provider: 'unknown-provider', modelId: 'mystery-model' });
    expect(info.tokens).toBe(32768);
    expect(info.source).toBe('default');
  });

  test('显式 defaultTokens 仍优先于兜底常量', () => {
    const info = resolveContextWindowInfo({ provider: 'x', modelId: 'y', defaultTokens: 4096 });
    expect(info.tokens).toBe(4096);
  });
});

describe('层3: 尾部保护窗硬上限', () => {
  test('巨消息不再被条数下限强护——切割点压进尾部', () => {
    const c = makeCompressor({ maxTokens: 128000 });
    // 尾部硬上限 = min(19200*1.5, 8000) = 8000 tokens;9000 中文字 ≈ 13500 tokens 超限
    const giant = '巨'.repeat(9000);
    const small = '短';
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '旧消息一' },
      { role: 'user', content: giant },      // 索引2: 尾部巨消息
      { role: 'assistant', content: small }, // 索引3
      { role: 'user', content: '最新请求' }, // 索引4
    ];
    const cut = c._findTailCutByTokens(messages, 1);
    // 巨消息(索引2)必须落在保护窗之外(进入摘要范围)
    expect(cut).toBeGreaterThan(2);
  });

  test('最新消息始终受保护(即便自身巨大会撑破上限)', () => {
    const c = makeCompressor({ maxTokens: 128000 });
    const giant = '巨'.repeat(9000);
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '旧消息' },
      { role: 'user', content: giant },  // 最新一条即巨消息
    ];
    const cut = c._findTailCutByTokens(messages, 1);
    expect(cut).toBeLessThanOrEqual(2); // 切割点不超过最新消息 → 尾部至少含它
    expect(cut).toBeGreaterThan(0);
  });

  test('普通小消息仍按 token 预算正常扩保护窗', () => {
    const c = makeCompressor({ maxTokens: 128000 });
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: '最新请求' },
    ];
    const cut = c._findTailCutByTokens(messages, 1);
    // 小消息全在预算内 → 除头部保护区(索引0-1)外全部受保护(cut 不会越过索引2)
    expect(cut).toBeLessThanOrEqual(2);
  });
});

describe('层2: 预算化压缩', () => {
  test('压缩后进入预算(尾部上限+循环压缩协同)', async () => {
    const c = makeCompressor({ maxTokens: 8000 });
    // ASCII 内容 4 字符/token;20 条 × 2000 字符 = 每条约 510 tokens,总计 ~10.2K
    // 阈值 5600,尾部上限 min(1800, 8000)=1800 tokens → 中段 ~8.4K tokens 须摘要
    const messages = [{ role: 'system', content: 'system prompt' }];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `user request number ${i} ` + 'x'.repeat(2000) });
      messages.push({ role: 'assistant', content: `assistant reply ${i} ` + 'y'.repeat(500) });
    }
    const result = await c.compress(messages, { maxTokens: 8000 });

    expect(result.compressed).toBe(true);
    const total = estimateMessagesTokens(result.messages);
    expect(total).toBeLessThanOrEqual(5600);
    // 最新消息保留原文
    const last = result.messages[result.messages.length - 1];
    expect(last.content).toContain('assistant reply 19');
  });

  test('_forcePass 绕过"连续无效"熔断(内层预算化 pass 不被外层计数挡住)', async () => {
    const c = makeCompressor({ maxTokens: 8000 });
    c._ineffectiveCompressionCount = 5; // ≥ MAX_INEFFECTIVE_COMPRESSIONS,外层必跳过

    const messages = [{ role: 'system', content: 'system prompt' }];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'user', content: `msg ${i} ` + 'z'.repeat(2000) });
    }

    const outer = await c.compress(messages, { maxTokens: 8000 });
    expect(outer.skipped).toBe(true);

    const inner = await c.compress(messages, { maxTokens: 8000, _forcePass: true, _compressPass: 1 });
    expect(inner.compressed).toBe(true);
  });

  test('带 id 的消息压缩后 persist.removedIds 带回中段行 id(P2-1 写回复活)', async () => {
    const c = makeCompressor({ maxTokens: 8000 });
    // n=7 > minForCompress(6);中段 4 条 × 8000 ASCII 字符(≈2000 tokens/条)超阈值 5600
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', id: 101, content: '头部保护消息 ' + 'h'.repeat(200) },
      { role: 'user', id: 102, content: '中段消息A ' + 'a'.repeat(8000) },
      { role: 'assistant', id: 103, content: '中段回复B ' + 'b'.repeat(8000) },
      { role: 'user', id: 105, content: '中段消息C ' + 'c'.repeat(8000) },
      { role: 'assistant', id: 106, content: '中段回复D ' + 'd'.repeat(8000) },
      { role: 'user', id: 104, content: '最新请求' },
    ];
    const result = await c.compress(messages, { maxTokens: 8000 });

    expect(result.compressed).toBe(true);
    expect(result.persist).toBeTruthy();
    expect(Array.isArray(result.persist.removedIds)).toBe(true);
    expect(result.persist.removedIds).toContain(102);
    expect(result.persist.removedIds).toContain(103);
    // 头部保护行(101)与尾部锚定行(104)不应被删
    expect(result.persist.removedIds).not.toContain(101);
    expect(result.persist.removedIds).not.toContain(104);
  });
});

describe('API 边界: 内部字段剥离', () => {
  test('sanitizeMessagesForProvider 剥离消息级 id/isSummary,保留 tool_calls 内 tc.id', () => {
    const messages = [
      { role: 'user', id: 42, content: '你好' },
      { role: 'user', id: 43, isSummary: true, content: '[上下文压缩 — 仅供参考] 摘要' },
      {
        role: 'assistant',
        id: 44,
        content: '调用工具',
        tool_calls: [{ id: 'call_abc123', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      },
    ];
    const out = sanitizeMessagesForProvider(messages, 'deepseek');

    expect(out[0].id).toBeUndefined();
    expect(out[1].id).toBeUndefined();
    expect(out[1].isSummary).toBeUndefined();
    // tc.id 是协议必需字段——保留(strict 模式会清洗下划线等字符,属既有行为);
    // 本测试钉死的是:消息级 id 被剥,工具调用级 id 不被剥
    expect(out[2].tool_calls[0].id).toBe('callabc123');
    expect(out[2].content).toBe('调用工具');
  });
});

describe('层1b: 工具结果落档阈值', () => {
  test('DEFAULT_RESULT_SIZE_CHARS 收敛到 24K', () => {
    const { DEFAULT_RESULT_SIZE_CHARS } = require('../core/budget-config');
    expect(DEFAULT_RESULT_SIZE_CHARS).toBe(24_000);
  });
});
