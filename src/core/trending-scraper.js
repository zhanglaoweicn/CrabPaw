/**
 * Trending Scraper - 热点数据抓取引擎
 *
 * 为 trending-monitor 技能提供多平台热点数据抓取。
 * 基于现有 WebSearch/WebFetch 基础设施构建。
 *
 * 数据源：
 *   - 微博热搜（公开 API）
 *   - 知乎热榜（公开 API）
 *   - 百度风云榜（页面抓取）
 *   - 抖音热点（页面抓取）
 */

const https = require('https');
const http = require('http');

const FETCH_TIMEOUT = 15000;

function _fetch(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        ...headers,
      },
      timeout: FETCH_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

// ============================================================
// 微博热搜
// ============================================================

async function fetchWeiboHotSearch() {
  try {
    const data = await _fetch('https://weibo.com/ajax/side/hotSearch', {
      'Referer': 'https://weibo.com/',
      'Cookie': '', // 无 Cookie 也能获取基础数据
    });
    const json = JSON.parse(data);
    const items = (json.data?.realtime || []).slice(0, 30).map((item, i) => ({
      rank: i + 1,
      title: item.word || item.note || '',
      hot: item.num || 0,
      url: item.url || `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word || '')}`,
      tag: item.label_name || '',
    }));
    return { platform: 'weibo', source: 'weibo', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'weibo', error: e.message, items: [] };
  }
}

// ============================================================
// 2026-08-13 数据源重构（参考参考实现的多源降级方案）
// 原直连源全部失效：知乎 401(需登录)、抖音空 body(反爬)、小红书验证页、
// 微信 hot.weixin.qq.com DNS 失效、雪球需登录 cookie(400016)。
// 改为免费聚合源降级链：hotdata(公共 key) / haotechs / xxapi / 东方财富。
// ============================================================

const HOTDATA_KEY = 'zIisgRZJLLXgqKCwBirNLegtNNRuL70eBsbHXPxEBWU='; // 公共 key（参考实现源码内置，开箱即用）

/** JSON 请求（复用 _fetch 的 UA/超时）+ 解析 */
async function _fetchJson(url, headers = {}) {
  const data = await _fetch(url, headers);
  return JSON.parse(data);
}

/** hotdata 聚合源——统一解析 {list: [...]}，空列表抛错供降级链捕获 */
async function _fetchHotdata(dataId, mapper) {
  const json = await _fetchJson('https://w-hotdata.aipromptnav.com/api/hot-data/' + dataId, {
    'X-API-Key': HOTDATA_KEY,
  });
  const raw = Array.isArray(json.list) ? json.list : [];
  const items = raw.slice(0, 20).map(mapper);
  if (items.length === 0) throw new Error(dataId + ' 返回空列表');
  return items;
}

/** 降级链：逐个尝试，第一个成功返回；全部失败抛聚合错误 */
async function _withFallback(name, providers) {
  // 2026-08-16 数据链审计 #4: 降级链总超时——每级最坏 FETCH_TIMEOUT(15s),
  // 三级降级最坏 45s, 前端 30s 轮询期间请求堆积。包一层 Promise.race 收敛到 20s。
  const FALLBACK_TOTAL_TIMEOUT_MS = 20000;
  const errors = [];
  const deadline = Date.now() + FALLBACK_TOTAL_TIMEOUT_MS;
  for (const p of providers) {
    if (Date.now() > deadline) throw new Error(name + ': 降级链总超时');
    try { return await Promise.race([
      p(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('单级超时')), Math.max(1000, deadline - Date.now()))),
    ]); } catch (e) { errors.push(e.message); }
  }
  throw new Error(name + ': ' + errors.join(' | '));
}

// ============================================================
// 知乎热榜——直连源 401(需登录),降级为 hotdata 综合网络热榜(nethot)
// ============================================================

async function fetchZhihuHot() {
  try {
    const items = await _fetchHotdata('nethot', (item, i) => ({
      rank: i + 1,
      title: item.keyword || item.word || '',
      hot: item.hot_num || item.hotwordnum || '',
      // 2026-08-16 数据链审计 #3: nethot 源无 url 字段(实测仅 keyword/brief/index)——
      // 原实现 url 恒空 → 面板条目点击无效。综合热榜无平台归属, 用百度搜索兜底。
      url: item.url || 'https://www.baidu.com/s?wd=' + encodeURIComponent(item.keyword || item.word || ''),
      tag: item.category || '',
      excerpt: item.brief || '',
    }));
    return { platform: 'zhihu', source: 'nethot', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'zhihu', error: e.message, items: [] };
  }
}

// ============================================================
// 百度风云榜（原实现保留——实测可用）
// ============================================================

async function fetchBaiduTrending() {
  try {
    const data = await _fetch('https://top.baidu.com/board?tab=realtime', {
      'Accept': 'text/html',
    });
    const items = [];
    const cardRegex = /<!--s-data:\s*(\{[\s\S]*?\})\s*-->/g;
    let match;
    while ((match = cardRegex.exec(data)) !== null) {
      try {
        const cardData = JSON.parse(match[1]);
        const cards = cardData.data?.cards || [];
        for (const card of cards) {
          for (const item of (card.content || [])) {
            items.push({
              rank: item.index || items.length + 1,
              title: item.word || item.query || '',
              hot: item.hotScore || item.hotChange || '',
              desc: item.desc || '',
              url: item.url || item.rawUrl || '',
            });
          }
        }
      } catch (_) { console.warn('[trending-scraper] Failed to parse Baidu trending card'); }
    }
    return { platform: 'baidu', source: 'baidu', count: Math.min(items.length, 30), items: items.slice(0, 30), updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'baidu', error: e.message, items: [] };
  }
}

// ============================================================
// 头条热榜（原实现保留——实测可用）
// ============================================================

async function fetchToutiaoHot() {
  try {
    const data = await _fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc');
    const json = JSON.parse(data);
    const items = (json.data || []).slice(0, 20).map((item, i) => ({
      rank: i + 1,
      title: item.Title || item.title || '',
      hot: item.HotValue || item.hot || '',
      url: item.Url || item.url || '',
    }));
    return { platform: 'toutiao', source: 'toutiao', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'toutiao', error: e.message, items: [] };
  }
}

// ============================================================
// 抖音热点——haotechs → xxapi → hotdata 三级降级（全部实测可用）
// ============================================================

async function fetchDouyinHot() {
  try {
    const items = await _withFallback('抖音', [
      async () => {
        const json = await _fetchJson('https://www.haotechs.cn/ljh-wx/api/douyinHot');
        const list = json.result || [];
        if (!list.length) throw new Error('haotechs 返回空');
        return list.slice(0, 20).map((item, i) => ({
          rank: i + 1,
          title: item.word || '',
          hot: item.hot_value || '',
          url: 'https://www.douyin.com/search/' + encodeURIComponent(item.word || ''),
          tag: item.label !== undefined ? String(item.label) : '',
        }));
      },
      async () => {
        const json = await _fetchJson('https://v2.xxapi.cn/api/douyinhot');
        const list = json.data || [];
        if (!list.length) throw new Error('xxapi 返回空');
        return list.slice(0, 20).map((item, i) => ({
          rank: i + 1,
          title: item.word || '',
          hot: item.hot_value || item.hotValue || '',
          url: 'https://www.douyin.com/search/' + encodeURIComponent(item.word || ''),
          tag: item.label !== undefined ? String(item.label) : '',
        }));
      },
      () => _fetchHotdata('douyinhot', (item, i) => ({
        rank: i + 1,
        title: item.hotword || item.word || '',
        hot: item.hotwordnum || item.hot_value || '',
        url: 'https://www.douyin.com/search/' + encodeURIComponent(item.hotword || item.word || ''),
      })),
    ]);
    return { platform: 'douyin', source: 'multi', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'douyin', error: e.message, items: [] };
  }
}

// ============================================================
// 小红书热点——hotdata（免费公共 key）
// ============================================================

async function fetchXiaohongshuHot() {
  try {
    const items = await _fetchHotdata('xiaohongshu', (item, i) => ({
      rank: i + 1,
      title: item.hotword || item.word || '',
      hot: item.hotwordnum || item.hot || '',
      url: 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(item.hotword || item.word || ''),
      tag: item.hottag || '',
    }));
    return { platform: 'xiaohongshu', source: 'hotdata', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'xiaohongshu', error: e.message, items: [] };
  }
}

// ============================================================
// 微信热点——hotdata（原 hot.weixin.qq.com 域名 DNS 已失效）
// ============================================================

async function fetchWechatHot() {
  try {
    const items = await _fetchHotdata('wxhottopic', (item, i) => ({
      rank: i + 1,
      title: item.word || item.hotword || '',
      hot: item.hot_num || item.hotwordnum || '',
      // 2026-08-16 数据链审计 #3: wxhottopic 源无 url 字段(实测仅 word/index)——
      // 原实现 url 恒空 → 面板条目点击无效。微信热点用搜狗微信搜索兜底。
      url: item.url || 'https://weixin.sogou.com/weixin?type=2&query=' + encodeURIComponent(item.word || item.hotword || ''),
    }));
    return { platform: 'wechat', source: 'hotdata', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'wechat', error: e.message, items: [] };
  }
}

// ============================================================
// V2EX 热帖（原实现保留）
// ============================================================

async function fetchV2exHot() {
  try {
    const data = await _fetch('https://www.v2ex.com/api/topics/hot.json');
    const json = JSON.parse(data);
    const items = (Array.isArray(json) ? json : []).slice(0, 30).map((item, i) => ({
      rank: i + 1,
      title: item.title || '',
      hot: item.replies || 0,
      url: item.url || 'https://www.v2ex.com/t/' + (item.id || ''),
      tag: item.node?.title || '',
      excerpt: item.content ? item.content.replace(/<[^>]*>/g, '').slice(0, 100) : '',
    }));
    return { platform: 'v2ex', source: 'v2ex', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'v2ex', error: e.message, items: [] };
  }
}

// ============================================================
// 雪球热帖——原接口需登录 cookie(400016),降级为东方财富热门股票(涨幅榜)
// ============================================================

async function fetchXueqiuHot() {
  try {
    const json = await _fetchJson('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6&fields=f2,f3,f12,f14');
    const diff = json.data?.diff || [];
    if (!diff.length) throw new Error('东财返回空');
    const items = diff.map((d, i) => ({
      rank: i + 1,
      title: (d.f14 || '') + '（' + (d.f12 || '') + '）',
      hot: (d.f3 ?? '') + '%',
      url: 'https://quote.eastmoney.com/' + (d.f12 || '') + '.html',
      tag: '涨幅',
    }));
    return { platform: 'xueqiu', source: 'eastmoney', count: items.length, items, updatedAt: new Date().toISOString() };
  } catch (e) {
    return { source: 'xueqiu', error: e.message, items: [] };
  }
}

// ============================================================
// 聚合查询
// ============================================================

async function fetchAllTrending(platforms = ['weibo', 'zhihu', 'baidu', 'douyin', 'xiaohongshu', 'wechat', 'toutiao', 'v2ex', 'xueqiu']) {
  const fetchers = {
    weibo: fetchWeiboHotSearch,
    zhihu: fetchZhihuHot,
    baidu: fetchBaiduTrending,
    toutiao: fetchToutiaoHot,
    douyin: fetchDouyinHot,
    xiaohongshu: fetchXiaohongshuHot,
    wechat: fetchWechatHot,
    v2ex: fetchV2exHot,
    xueqiu: fetchXueqiuHot,
  };

  const results = {};
  const promises = platforms
    .filter(p => fetchers[p])
    .map(async (p) => {
      results[p] = await fetchers[p]();
    });

  await Promise.allSettled(promises);
  return results;
}

// ============================================================
// 格式化输出
// ============================================================

function formatTrendingReport(allResults) {
  const lines = [];
  lines.push('\u{1F4E1} 热点速报 | ' + new Date().toLocaleString('zh-CN'));
  lines.push('');

  for (const [platform, result] of Object.entries(allResults)) {
    const nameMap = { weibo: '\u{1F534} 微博热搜', zhihu: '\u{1F535} 知乎热榜', baidu: '\u{1F7E1} 百度风云榜', toutiao: '\u{1F7E2} 头条热榜', v2ex: '\u{1F4BB} V2EX 热帖', xueqiu: '\u{1F4B0} 雪球热帖' };
    lines.push(`### ${nameMap[platform] || platform}`);
    if (result.error) {
      lines.push(`  \u26A0\uFE0F 获取失败: ${result.error}`);
      continue;
    }
    for (const item of (result.items || []).slice(0, 10)) {
      const hotStr = item.hot ? ` [${typeof item.hot === 'number' ? Math.round(item.hot / 10000) + '\u4E07' : item.hot}]` : '';
      lines.push(`${item.rank}. ${item.title}${hotStr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  fetchWeiboHotSearch,
  fetchZhihuHot,
  fetchBaiduTrending,
  fetchDouyinHot,
  fetchXiaohongshuHot,
  fetchWechatHot,
  fetchToutiaoHot,
  fetchV2exHot,
  fetchXueqiuHot,
  fetchAllTrending,
  formatTrendingReport,
};
