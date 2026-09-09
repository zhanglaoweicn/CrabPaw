/**
 * memory-write-gate.test.js — SP1 记忆写入门控（P0）
 *
 * 覆盖:
 * 1. AutoMemory._gateAdmit 纯函数: 空 / 过短 / 系统提示 / 配置类 / session 型 / 近重复 / 放行
 * 2. AutoMemory.addMemory 交汇点: 拒绝不新增不落盘、近重复 skip 不新增
 * 3. AutoDream._storeResults 源头: user message 不再以 session 直写 addMemory（只留 dream.json 通道）
 * 4. hotspot persistMentionedHotspot: 位置参数调用 memoryManager.addMemory
 */

// AutoDream 依赖的 services / archiver 用轻量 EventEmitter mock（避免真实磁盘/定时器）
jest.mock('../services', () => {
  const { EventEmitter } = require('events');
  const make = (extra = {}) => jest.fn().mockImplementation(function () {
    return Object.assign(new EventEmitter(), extra);
  });
  return {
    PromptFingerprint: make({ getCacheStats: () => ({}) }),
    ToolOptimizer: make({ getStats: () => ({}) }),
    TaskProgressTracker: make({ getStats: () => ({ totalMilestones: 0 }) }),
    SmartDreamScheduler: make({ getStats: () => ({}) }),
    DreamReplay: make({ getStats: () => ({}) }),
  };
});

jest.mock('../core/memory/memory-archiver', () => {
  const { EventEmitter } = require('events');
  return {
    MemoryArchiver: jest.fn().mockImplementation(function () {
      return new EventEmitter();
    }),
    MEMORY_LAYERS: {},
  };
});

jest.mock('../core/memory-system', () => ({
  memoryManager: { addMemory: jest.fn(async () => ({ id: 'm_hotspot' })) },
}));

jest.mock('../core/trending', () => ({
  getTrendingBlock: () => null,
}));

const fs = require('fs');
const { AutoMemory } = require('../core/memory/auto-memory');
const { AutoDream } = require('../core/memory/auto-dream');
const { persistMentionedHotspot } = require('../core/hotspot-intent');
const { memoryManager } = require('../core/memory-system');

/** 隔离实例: 补丁磁盘副作用(_ensureDir/save), 仅保留门控与内存态 */
function makeIsolatedAutoMemory() {
  const m = new AutoMemory();
  m._ensureDir = async () => {};
  m.save = async () => {};
  return m;
}

describe('AutoMemory._gateAdmit 纯函数门控', () => {
  const am = new AutoMemory();

  test('空标题空内容 → empty 拒', () => {
    expect(am._gateAdmit('note', '   ', '\n ')).toEqual({ ok: false, reason: 'empty' });
  });

  test('有效长度不足 4（去空白后）→ too_short 拒', () => {
    expect(am._gateAdmit('note', '你好', '')).toEqual({ ok: false, reason: 'too_short' });
    expect(am._gateAdmit('note', '  ', 'ok')).toEqual({ ok: false, reason: 'too_short' });
  });

  test('系统提示内容 → system_prompt 拒', () => {
    expect(am._gateAdmit('note', '会话记录', '这是一条[系统提示：请用户补充上下文]的消息内容'))
      .toEqual({ ok: false, reason: 'system_prompt' });
  });

  test('配置/错误信息类 → config_noise 拒（标题或内容命中）', () => {
    expect(am._gateAdmit('note', '环境信息', 'API 密钥未配置，服务启动失败')).toEqual({ ok: false, reason: 'config_noise' });
    expect(am._gateAdmit('note', '系统错误：连接超时', '重试后仍失败')).toEqual({ ok: false, reason: 'config_noise' });
    expect(am._gateAdmit('note', '环境变量', 'env: OPENAI_API_KEY 缺失')).toEqual({ ok: false, reason: 'config_noise' });
    expect(am._gateAdmit('note', '未配置的通知渠道', '需要用户提供渠道配置信息')).toEqual({ ok: false, reason: 'config_noise' });
  });

  test('session 型（有效内容）→ session_transcript 拒', () => {
    expect(am._gateAdmit('session', '用户询问天气', '请帮我查一下明天北京的天气怎么样呢'))
      .toEqual({ ok: false, reason: 'session_transcript' });
  });

  test('近重复（normalize 前 40 字符 hash 命中）→ dedup 标记', () => {
    const base = '报告输出统一使用HTML格式并保持简洁风格标题层级清晰段落短小引用规范图表明晰附上说明';
    const g = am._gateAdmit('preference', '输出格式', `用户偏好${base}配图适量`, [
      { id: 'm1', title: '输出格式', content: `用户希望${base}不要配图` },
    ]);
    expect(g).toEqual({ ok: true, dedup: true, matchedId: 'm1' });
  });

  test('合法记忆 → ok 放行', () => {
    expect(am._gateAdmit('note', '会议纪要', '讨论了部署方案与回滚策略')).toEqual({ ok: true });
  });
});

describe('AutoMemory.addMemory 交汇点准入', () => {
  let writeSpy;
  beforeEach(() => {
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });
  afterEach(() => {
    writeSpy.mockRestore();
  });

  test('空内容 → 拒绝且不新增（不再产生 Untitled 记忆）', async () => {
    const m = makeIsolatedAutoMemory();
    const before = m.memories.size;
    const res = await m.addMemory({ type: 'note', title: '', content: '   ' });
    expect(res.rejected).toBe(true);
    expect(res.reason).toBe('empty');
    expect(m.memories.size).toBe(before);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('系统提示内容 → 拒绝且不新增', async () => {
    const m = makeIsolatedAutoMemory();
    const before = m.memories.size;
    const res = await m.addMemory({ type: 'note', title: '会话记录', content: '[系统提示：请用户补充上下文]的消息' });
    expect(res.rejected).toBe(true);
    expect(res.reason).toBe('system_prompt');
    expect(m.memories.size).toBe(before);
  });

  test('session 型直写 → 拒绝且不新增', async () => {
    const m = makeIsolatedAutoMemory();
    const before = m.memories.size;
    const res = await m.addMemory({ type: 'session', title: '用户询问天气', content: '请帮我查一下明天北京的天气怎么样呢' });
    expect(res.rejected).toBe(true);
    expect(res.reason).toBe('session_transcript');
    expect(m.memories.size).toBe(before);
  });

  test('近重复 → skip 不新增不写盘', async () => {
    const m = makeIsolatedAutoMemory();
    const base = '报告输出统一使用HTML格式并保持简洁风格标题层级清晰段落短小引用规范图表明晰附上说明';
    m.memories.set('m1', { id: 'm1', title: '输出格式', content: `用户希望${base}不要配图`, updated: Date.now() });
    const res = await m.addMemory({ type: 'preference', title: '输出格式', content: `用户偏好${base}配图适量` });
    expect(res.skip).toBe(true);
    expect(res.dedup).toBe(true);
    expect(res.matchedId).toBe('m1');
    expect(m.memories.size).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('合法记忆 → 正常新增', async () => {
    const m = makeIsolatedAutoMemory();
    const before = m.memories.size;
    const res = await m.addMemory({ type: 'note', title: '会议纪要', content: '讨论了部署方案与回滚策略' });
    expect(res.rejected).toBeUndefined();
    expect(res.id).toBeTruthy();
    expect(m.memories.size).toBe(before + 1);
  });
});

describe('AutoDream 源头门控', () => {
  test('user message 不再以 session 直写 addMemory（只留 dream.json 通道）', async () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const addMemorySpy = jest.fn(async () => ({ id: 'm_new' }));
    const fakeAutoMemory = {
      memories: new Map(),
      _ensureDir: jest.fn(async () => {}),
      addMemory: addMemorySpy,
    };
    const dream = new AutoDream(fakeAutoMemory);
    await dream._storeResults(
      { insights: [] },
      [{ type: 'user_message', content: '请帮我查一下明天北京的天气怎么样呢', timestamp: 1 }],
    );
    expect(addMemorySpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled(); // dream.json 通道保留
    writeSpy.mockRestore();
  });
});

describe('MemoryManager.addMemory 门控短路 fan-out (SP1)', () => {
  // 轻量夹具: Object.create 跳过构造器(避免真实 AutoMemory/AutoDream/会话持久化/SQLite),
  // 预置懒加载字段(_ftsSearch/_unifiedStore), 仅验证门控短路语义。
  const { MemoryManager } = require('../core/memory/memory-manager');

  function makeManagerWithGateResult(gateResult) {
    const mm = Object.create(MemoryManager.prototype);
    mm._stabilityDetector = null;
    mm.autoMemory = {
      memories: new Map(),
      addMemory: jest.fn(async () => gateResult),
    };
    mm._ftsSearch = { indexMemory: jest.fn(async () => {}) };
    mm._unifiedStore = { addMemory: jest.fn(async () => {}) };
    return mm;
  }

  test('rejected → 直通返回, 不调 ftsSearch.indexMemory / unifiedStore.addMemory', async () => {
    const mm = makeManagerWithGateResult({ rejected: true, reason: 'empty' });
    const res = await mm.addMemory('note', '标题', '内容');
    expect(res).toEqual({ rejected: true, reason: 'empty' });
    expect(mm.autoMemory.addMemory).toHaveBeenCalledTimes(1);
    expect(mm._ftsSearch.indexMemory).not.toHaveBeenCalled();
    expect(mm._unifiedStore.addMemory).not.toHaveBeenCalled();
  });

  test('skip(近重复) → 直通返回, 不调 ftsSearch / unifiedStore fan-out', async () => {
    const mm = makeManagerWithGateResult({ skip: true, dedup: true, matchedId: 'm1' });
    const res = await mm.addMemory('preference', '标题', '内容');
    expect(res).toEqual({ skip: true, dedup: true, matchedId: 'm1' });
    expect(mm._ftsSearch.indexMemory).not.toHaveBeenCalled();
    expect(mm._unifiedStore.addMemory).not.toHaveBeenCalled();
  });
});

describe('hotspot persistMentionedHotspot 签名', () => {
  test('位置参数调用 memoryManager.addMemory(type, title, content, tags, scope)', async () => {
    memoryManager.addMemory.mockClear();
    memoryManager.addMemory.mockResolvedValue({ id: 'm_hotspot' });
    const match = {
      item: { title: '台风摩羯登陆', rank: 1, hot: 999, url: 'https://example.com/x' },
      source: '微博热搜',
      matchType: 'direct',
      score: 1,
    };
    await persistMentionedHotspot(match, '台风摩羯登陆了吗');
    expect(memoryManager.addMemory).toHaveBeenCalledTimes(1);
    const [type, title, content, tags, scope] = memoryManager.addMemory.mock.calls[0];
    expect(type).toBe('hotspot_event');
    expect(typeof title).toBe('string');
    expect(title).toContain('台风摩羯登陆');
    expect(content).toContain('微博热搜');
    expect(tags).toEqual(['hotspot', '微博热搜']);
    expect(scope).toBe('private');
  });
});
