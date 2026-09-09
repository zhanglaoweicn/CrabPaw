/**
 * hot-now — 实时热搜查询
 * 用法：execute({ platform: 'weibo'|'zhihu'|'baidu'|'toutiao'|'all', limit: 10 })
 */
const { fetchAllTrending, fetchWeiboHotSearch, fetchZhihuHot, fetchBaiduTrending, fetchToutiaoHot, formatTrendingReport } = require('../../src/core/trending-scraper');

async function execute(params = {}) {
  const platform = params.platform || 'all';
  const limit = Math.max(1, Math.min(30, Number(params.limit) || 10));
  try {
    if (platform === 'all') {
      const results = await fetchAllTrending();
      const trimmed = {};
      for (const key of Object.keys(results)) {
        trimmed[key] = { ...results[key], items: (results[key].items || []).slice(0, limit) };
      }
      return { success: true, platforms: trimmed, content: formatTrendingReport(trimmed) };
    }
    const fetchers = { weibo: fetchWeiboHotSearch, zhihu: fetchZhihuHot, baidu: fetchBaiduTrending, toutiao: fetchToutiaoHot };
    const fetcher = fetchers[platform];
    if (!fetcher) return { success: false, error: `不支持的平台: ${platform}` };
    const result = await fetcher();
    result.items = (result.items || []).slice(0, limit);
    return { success: true, platform, content: formatTrendingReport({ [platform]: result }) };
  } catch (err) {
    console.error('[hot-now] 热搜获取失败:', err);
    return { success: false, error: `热搜获取失败: ${err.message}` };
  }
}

module.exports = { execute };
