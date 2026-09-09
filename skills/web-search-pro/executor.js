/**
 * web-search-pro executor — Query analysis + routing recommendation
 */
async function execute(input, options, params) {
  const q = typeof input === 'string' ? input : (input?.query || input?.keyword || '');
  const signals = {
    isChinese: /[一-鿿]/.test(q),
    isNews: /\b(?:新闻|news|最新|latest|today)\b/i.test(q),
    isAcademic: /\b(?:paper|arxiv|论文|研究|journal)\b/i.test(q),
    isCode: /\b(?:github|stackoverflow|npm|pip|api|sdk)\b/i.test(q),
  };
  let engine = 'tavily';
  if (signals.isNews) engine = 'tavily_news';
  else if (signals.isAcademic) engine = 'tavily_academic';
  else if (signals.isChinese) engine = 'bing_api';
  return { success: true, query: q, recommendation: { backend: engine }, signals };
}

const schema = {
  name: 'web-search-pro',
  description: '增强搜索：查询分析 + 多引擎路由推荐',
  capabilities: ['web_search', 'data_collection'],
  input: { query: { type: 'string', description: '搜索查询词' } },
  output: { recommendation: { type: 'object', description: '路由推荐' } },
};
module.exports = { execute, schema };
