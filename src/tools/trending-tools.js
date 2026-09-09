/**
 * Trending Tools - 热点查询工具
 *
 * 为 trending-monitor 和 hot-now 技能提供工具注册。
 * 基于 trending-scraper.js 抓取引擎。
 */

const { registry } = require('./registry');
const {
  fetchWeiboHotSearch,
  fetchZhihuHot,
  fetchBaiduTrending,
  fetchToutiaoHot,
  fetchAllTrending,
  formatTrendingReport,
} = require('../core/trending-scraper');

registry.register({
  name: 'hot_search',
  toolset: 'trending',
  category: 'media',
  description: '查询当前各平台热搜/热点。支持微博、知乎、百度、头条。不指定平台时返回全部。',
  schema: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['weibo', 'zhihu', 'baidu', 'toutiao', 'all'],
        description: '平台：weibo(微博), zhihu(知乎), baidu(百度), toutiao(头条), all(全部)',
      },
      limit: { type: 'number', description: '返回条数，默认10' },
      format: { type: 'string', enum: ['list', 'report'], description: '输出格式：list(列表) 或 report(格式化报告)' },
    },
  },
  async handler(params) {
    const platform = params.platform || 'all';
    const limit = params.limit || 10;
    const wantReport = params.format === 'report';

    if (platform === 'all') {
      const results = await fetchAllTrending();
      if (wantReport) {
        return { success: true, content: formatTrendingReport(results) };
      }
      // Truncate items
      for (const key of Object.keys(results)) {
        if (results[key].items) {
          results[key].items = results[key].items.slice(0, limit);
        }
      }
      return { success: true, platforms: results };
    }

    const fetchers = {
      weibo: fetchWeiboHotSearch,
      zhihu: fetchZhihuHot,
      baidu: fetchBaiduTrending,
      toutiao: fetchToutiaoHot,
    };

    const fetcher = fetchers[platform];
    if (!fetcher) {
      return { success: false, error: `不支持的平台: ${platform}` };
    }

    const result = await fetcher();
    result.items = (result.items || []).slice(0, limit);

    if (wantReport) {
      const report = formatTrendingReport({ [platform]: result });
      return { success: true, content: report };
    }

    return { success: true, ...result };
  }
});

module.exports = {};
