/**
 * multi-search-engine — 多引擎搜索聚合
 * 用法：execute({ query: '关键词', engines?: ['baidu','bing','duckduckgo'], num?: 10 })
 * 说明：底层 handleWebSearch 接收单值 engine（无 engines 数组字段），
 *       故 engines 数组取第一个元素映射到 engine；也兼容旧调用方传 { keyword, engine }。
 */
const { handleWebSearch } = require('../../src/tools/web-tools');

async function execute(params = {}) {
  const query = String(params.query || params.keyword || '').trim();
  if (!query) return { success: false, error: '缺少搜索关键词' };

  // handleWebSearch({ query, num, engine, backend, scenario }) —— 无 engines 字段
  let engine = params.engine;
  if (Array.isArray(params.engines) && params.engines.length > 0) {
    engine = params.engines[0];
  }
  const num = Math.max(1, Math.min(20, Number(params.num) || 10));

  try {
    const result = await handleWebSearch({ query, engine: typeof engine === 'string' && engine ? engine : undefined, num, scenario: params.scenario });
    // handleWebSearch 失败路径返回 { ok: false, results: [], error } 或 { success: false, error }
    const ok = result && (result.ok === true || result.success === true || (Array.isArray(result.results) && result.results.length > 0));
    if (!ok) {
      return { success: false, error: (result && (result.error || result.message)) || '搜索失败' };
    }
    const results = result.results || result.data || [];
    return {
      success: true,
      query,
      engine: result.engine || engine || '',
      results,
      content: result.content || results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url || r.link}`).join('\n'),
    };
  } catch (err) {
    console.error('[multi-search-engine] 搜索失败:', err);
    return { success: false, error: `搜索失败: ${err.message}` };
  }
}

const schema = {
  name: 'multi-search-engine', description: '多引擎搜索聚合（真实搜索）', capabilities: ['web_search', 'data_collection'],
  input: { query: { type: 'string' }, engines: { type: 'array' } },
  output: { results: { type: 'array' }, content: { type: 'string' } },
};

module.exports = { execute, schema };
