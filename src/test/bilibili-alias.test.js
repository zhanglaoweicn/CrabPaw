/**
 * BilibiliSearch query 别名修复测试（2026-08-22）
 *
 * 实机 bug：GUI 说「推荐一个关于DEEPSEE HARNESS的视频」→ LLM 调 BilibiliSearch
 * 两次（{"query":"DeepSeek Harness 智能体框架"} / {"query":"DeepSeek harness 框架"}）
 * 均收到「请提供搜索关键词」（5 行 109 字符）→ LLM 判定「B站搜索接口有问题」→
 * 换 WebSearch/BrowserControl 全部失败 → 无视频卡片，向用户道歉。
 *
 * 根因（与 2026-08-22 DocRead path 别名漂移同型）：
 *   - tool-contract.js 契约已放行 keyword+query 别名（properties 双声明，required 空）
 *   - 注册 schema required 只认 keyword
 *   - handler 只读 params.keyword → query 别名传入时 keyword 为空 → 返回错误
 *   - deepseek-v4-flash 参数名跟随差（从契约/知识包学到 query）→ 命中别名路径
 *
 * 修复：handler 双兼容 keyword ?? query ?? q；注册 schema properties 暴露 query 别名
 *       （与 document-tools 四工具同款修法，LLM 传哪个都通）。
 *
 * 说明：网络调用用 mock fetch（searchBilibili 用全局 fetch），断言别名分支/错误分支，
 *       不依赖 B站 API 在线状态。
 */

const { registry } = require('../tools/registry');

// 假 B站响应：1 个 video 分区结果
const FAKE_RESULT = {
  code: 0,
  data: {
    result: [{
      result_type: 'video',
      data: [{
        bvid: 'BV1xxTEST',
        title: '<b>DeepSeek Harness</b> 实测',
        author: '测试UP主',
        play: 1027000,
        duration: '10:00',
        pic: 'http://pic.test/1.jpg',
        description: '描述',
      }],
    }],
  },
};

let tools;

beforeAll(async () => {
  // 与其余工具测试一致：直接加载模块（模块顶层 registry.register 自注册）
  tools = require('../tools/bilibili-tools');
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => FAKE_RESULT,
  });
});

describe('BilibiliSearch query 别名（19:19 实机错位修复）', () => {
  test('query 别名传入：正常返回搜索结果（修复前返回「请提供搜索关键词」）', async () => {
    const r = await tools.handleBilibiliSearch({ query: 'DeepSeek Harness 智能体框架' });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(1);
    expect(r.results[0].bvid).toBe('BV1xxTEST');
    expect(r.results[0].title).toContain('DeepSeek Harness');
    // hint 引导 LLM 用 SceneMedia 应用内播放（发卡链路关键）
    expect(r.hint).toContain('SceneMedia');
    expect(r.hint).toContain('BV1xxTEST');
  });

  test('keyword 主名传入：仍正常（不破坏旧调用）', async () => {
    const r = await tools.handleBilibiliSearch({ keyword: 'deepseek' });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(1);
  });

  test('空参数：返回「请提供搜索关键词」', async () => {
    const r = await tools.handleBilibiliSearch({});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('请提供搜索关键词');
  });

  test('无匹配分区：返回未找到提示', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 0, data: { result: [{ result_type: 'bangumi', data: [] }] } }),
    });
    const r = await tools.handleBilibiliSearch({ keyword: 'nothing' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未找到相关视频/);
    global.fetch = originalFetch; // 恢复，防污染后续用例
  });
});

describe('BilibiliSearch 注册 schema 暴露别名（防双端再漂移）', () => {
  test('schema properties 含 keyword + query 别名', () => {
    const tool = registry.get('BilibiliSearch');
    expect(tool).toBeTruthy();
    const s = tool.schema.parameters || tool.schema;
    expect(s.properties.keyword).toBeTruthy();
    expect(s.properties.query).toBeTruthy();
  });

  test('registry.execute 走别名参数返回成功（端到端含契约层）', async () => {
    // 清工具结果缓存：registry.execute 会把 handler 返回值（含业务失败）写入
    // 缓存，前序失败用例可能污染同 key（15min TTL），必须隔离
    const { getToolResultCache } = require('../core/tool-result-cache');
    getToolResultCache().clear();
    const r = await registry.execute('BilibiliSearch', { query: 'deepseek' });
    expect(r.success).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.total).toBe(1);
  });
});

describe('BilibiliPlay 别名（bvid/videoId 双兼容防回归）', () => {
  test('schema properties 含 bvid 主名', () => {
    const tool = registry.get('BilibiliPlay');
    expect(tool).toBeTruthy();
    const s = tool.schema.parameters || tool.schema;
    expect(s.properties.bvid).toBeTruthy();
  });
});
