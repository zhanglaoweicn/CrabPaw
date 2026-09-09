/* eslint-env browser */
const path = require('path');
const fs = require('fs');

let _cb = null;
// 与 browser-control 同款三级解析(详见其 _setCloakBrowserCacheDir 注释):
// CrabPaw-Data 副本 → resources 副本(-WithCloakBinary 自用构建) → 下载落 CrabPaw-Data;
// 无 CRABPAW_DATA_DIR(开发版)退回程序树 data/cloakbrowser(开发机预下载位)
function _setCloakCacheDir() {
  if (process.env.CLOAKBROWSER_CACHE_DIR) return;
  const dataCache = process.env.CRABPAW_DATA_DIR
    ? path.join(process.env.CRABPAW_DATA_DIR, 'cloakbrowser')
    : null;
  const resourcesCache = path.join(__dirname, '..', '..', 'data', 'cloakbrowser');
  if (dataCache && fs.existsSync(dataCache)) {
    process.env.CLOAKBROWSER_CACHE_DIR = dataCache;
  } else if (fs.existsSync(resourcesCache)) {
    process.env.CLOAKBROWSER_CACHE_DIR = resourcesCache;
  } else if (dataCache) {
    process.env.CLOAKBROWSER_CACHE_DIR = dataCache;
  }
}
async function _getCB() {
  if (_cb) return _cb;
  _setCloakCacheDir();
  _cb = await import('cloakbrowser');
  return _cb;
}

let browserInstance = null;
let lastUsedTime = 0;
const BROWSER_IDLE_TIMEOUT = 60000;
const MAX_RESULTS = 15;

// 经实际测试（2026-07-13）：
// 使用 CloakBrowser（C++ 源码级隐身补丁）：
// baidu.com → 通过 CloakBrowser 隐身绕过 ✅
// sogou.com → 通过 CloakBrowser 隐身绕过 ✅
// so.com (360搜索) → 正常可用 ✅
// cn.bing.com → 正常可用 ✅
const ENGINE_SELECTORS = {
  '必应': {
    url: 'https://cn.bing.com/search?q={keyword}&filters=ex1:"ez2"',
    resultSelector: '.b_algo, li.b_algo',
    titleSelector: 'h2 a',
    linkSelector: 'h2 a',
    descSelector: '.b_caption p, .b_algo .b_caption p',
    sourceSelector: 'cite',
    waitSelector: '.b_algo, #b_results',
    timeFilter: '一天内'
  },
  '360搜索': {
    url: 'https://www.so.com/s?q={keyword}&time=1',
    resultSelector: '.result, .res-list',
    titleSelector: 'h3 a',
    linkSelector: 'h3 a',
    descSelector: '.desc, .res-desc',
    sourceSelector: '.citeurl, .res-site',
    waitSelector: '.result, .res-list',
    timeFilter: '一天内'
  }
};

async function getBrowser() {
  const now = Date.now();
  
  if (browserInstance && (now - lastUsedTime) < BROWSER_IDLE_TIMEOUT) {
    lastUsedTime = now;
    return browserInstance;
  }
  
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) {
      console.warn('关闭浏览器实例失败:', e.message);
    }
  }
  
  const cb = await _getCB();
  // 2026-09-08 许可合规: 发行包不捆绑二进制(BINARY-LICENSE.md 禁止再分发)。
  // launch 在二进制缺失时会同步阻塞下载数分钟导致工具超时——改为后台预下载 + 明确报错重试。
  let cbCached = false;
  try {
    const info = cb.binaryInfo();
    cbCached = info && info.installed === true;
  } catch (e) { /* binaryInfo 不可用, 视为未缓存 */ }
  if (!cbCached) {
    const { ensureCloakBinary } = require('./cloak-installer');
    ensureCloakBinary(cb).then((channel) => {
      console.log(`[playwright-search] CloakBrowser 二进制就绪(渠道: ${channel}), 隐身搜索可用`);
    }).catch(e => console.warn('[playwright-search] CloakBrowser 后台下载失败:', e?.message));
    throw new Error('隐身搜索组件首次初始化中：正在后台下载 CloakBrowser（约500MB，仅一次，自动选择官方/国内镜像渠道），请 5-10 分钟后重试；期间可直接提问让助手换用其他检索方式');
  }
  browserInstance = await cb.launch({ headless: true });
  
  lastUsedTime = now;
  console.log('🚀 CloakBrowser 实例已创建');
  
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
      browserInstance = null;
      console.log('👋 CloakBrowser 实例已关闭');
    } catch (e) {
      console.warn('关闭浏览器失败:', e.message);
    }
  }
}

async function search(keyword, engineName = '必应', options = {}) {
  const engine = ENGINE_SELECTORS[engineName];
  if (!engine) {
    throw new Error(`不支持的搜索引擎: ${engineName}`);
  }
  
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    javaScriptEnabled: true
  });
  
  const page = await context.newPage();
  const results = [];
  
  try {
    const url = engine.url.replace('{keyword}', encodeURIComponent(keyword));
    console.log(`🔍 [CloakBrowser] 正在搜索: ${engineName} - ${keyword}`);
    
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeout || 30000
    });
    
    try {
      await page.waitForSelector(engine.waitSelector, { timeout: 10000 });
    } catch (e) {
      console.log(`⚠️ [CloakBrowser] 等待选择器超时，尝试直接提取`);
    }
    
    await page.waitForTimeout(1500);
    
    const extracted = await page.evaluate((config) => {
      const items = document.querySelectorAll(config.resultSelector);
      const data = [];
      
      for (const item of items) {
        try {
          const titleEl = item.querySelector(config.titleSelector);
          const linkEl = item.querySelector(config.linkSelector);
          const descEl = item.querySelector(config.descSelector);
          const sourceEl = item.querySelector(config.sourceSelector);
          
          const title = titleEl?.textContent?.trim() || '';
          let link = linkEl?.href || '';
          const desc = descEl?.textContent?.trim() || '';
          const source = sourceEl?.textContent?.trim() || '';
          
          let dateText = '';
          const dateSelectors = [
            '.c-color-gray', '.c-gap-left-small', '.news-time', '.time', '.date', 
            '.c-span-last', 'span[class*="time"]', 'span[class*="date"]',
            '.news-source', '.source-time'
          ];
          
          for (const sel of dateSelectors) {
            const dateEl = item.querySelector(sel);
            if (dateEl) {
              const t = dateEl.textContent?.trim();
              if (t && (
                t.includes('小时') || t.includes('分钟') || t.includes('天') || 
                t.includes('昨天') || t.includes('今天') || /\d{4}/.test(t) ||
                /\d+小时前/.test(t) || /\d+分钟前/.test(t)
              )) {
                dateText = t;
                break;
              }
            }
          }
          
          const fullText = item.textContent || '';
          const dateMatch = fullText.match(/(\d{1,2}小时前|\d{1,2}分钟前|昨天|今天|\d{4}[-年]\d{1,2}[-月]\d{1,2}|\d{1,2}月\d{1,2}日)/);
          if (!dateText && dateMatch) {
            dateText = dateMatch[1];
          }
          
          if (title.length < 3) continue;
          
          if (link.includes('baidu.php') || link.includes('ad.baidu.com') ||
              link.includes('pos.baidu.com') || link.includes('e.baidu.com') ||
              title.includes('广告') || title.includes('推广') || title.includes('为您推荐')) {
            continue;
          }
          
          if (!link || link === '' || link.startsWith('javascript:')) {
            continue;
          }
          
          data.push({ title, link, desc, source, date: dateText });
        } catch (e) {
          console.debug('[playwright-search] 解析搜索结果条目失败:', e.message);
        }
      }
      
      return data;
    }, engine);
    
    for (const item of extracted) {
      if (results.length >= MAX_RESULTS) break;
      
      const normalizedTitle = item.title.replace(/\s+/g, '').toLowerCase();
      if (!results.find(r => r.title.replace(/\s+/g, '').toLowerCase() === normalizedTitle)) {
        results.push({
          title: item.title,
          link: item.link,
          desc: item.desc.substring(0, 300),
          source: item.source || engineName,
          date: item.date || ''
        });
      }
    }
    
    console.log(`✅ [CloakBrowser] ${engineName} 返回 ${results.length} 条结果`);
    
  } catch (error) {
    console.error(`❌ [CloakBrowser] ${engineName} 搜索失败:`, error.message);
    throw error;
  } finally {
    await page.close();
    await context.close();
  }
  
  return results;
}

async function multiSearch(keyword, preferredEngine = null) {
  const engineOrder = preferredEngine
    ? [preferredEngine, ...Object.keys(ENGINE_SELECTORS).filter(e => e !== preferredEngine)]
    : ['必应', '360搜索'];
  
  let allResults = [];
  let successfulEngines = [];
  let lastError = null;
  
  const maxEngines = preferredEngine ? 1 : 3;
  const enginesToUse = engineOrder.slice(0, maxEngines);
  
  for (const engineName of enginesToUse) {
    try {
      const results = await search(keyword, engineName);
      
      if (results.length > 0) {
        allResults.push(...results);
        successfulEngines.push(engineName);
        console.log(`✅ [CloakBrowser] ${engineName} 返回 ${results.length} 条结果`);
      }
    } catch (error) {
      lastError = error;
      console.log(`⚠️ [CloakBrowser] ${engineName} 失败: ${error.message}`);
      continue;
    }
  }
  
  const uniqueResults = [];
  const seenTitles = new Set();
  for (const r of allResults) {
    const normalizedTitle = r.title.replace(/\s+/g, '').toLowerCase();
    if (!seenTitles.has(normalizedTitle) && r.title.length >= 3) {
      seenTitles.add(normalizedTitle);
      uniqueResults.push(r);
    }
  }
  
  const today = new Date();
  
  const getFreshnessScore = (item) => {
    const date = item.date || '';
    if (date.includes('分钟前')) return 10000;
    if (date.includes('小时前')) return 5000;
    if (date.includes('今天')) return 3000;
    if (date.includes('昨天')) return 1000;
    if (date.includes('天前')) {
      const match = date.match(/(\d+)天前/);
      if (match) return 1000 - parseInt(match[1]) * 100;
    }
    const dateMatch = date.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/);
    if (dateMatch) {
      const newsDate = new Date(dateMatch[1], parseInt(dateMatch[2]) - 1, dateMatch[3]);
      const diffDays = Math.floor((today - newsDate) / (1000 * 60 * 60 * 24));
      return Math.max(0, 1000 - diffDays * 100);
    }
    return 0;
  };
  
  const getQualityScore = (item) => {
    let score = 0;
    
    if (item.title.length > 10 && item.title.length < 50) score += 100;
    if (item.desc.length > 50) score += 50;
    if (item.link && !item.link.includes('click')) score += 30;
    if (item.source && item.source.length > 0) score += 20;
    
    return score;
  };
  
  uniqueResults.sort((a, b) => {
    const freshnessDiff = getFreshnessScore(b) - getFreshnessScore(a);
    if (freshnessDiff !== 0) return freshnessDiff;
    return getQualityScore(b) - getQualityScore(a);
  });
  
  const finalResults = uniqueResults.slice(0, MAX_RESULTS);
  
  const todayCount = finalResults.filter(r => {
    const score = getFreshnessScore(r);
    return score >= 3000;
  }).length;
  
  console.log(`📅 排序完成: 前${finalResults.length}条中今日新闻 ${todayCount} 条`);
  
  return {
    results: finalResults,
    engine: successfulEngines.join(' + '),
    error: lastError?.message,
    stats: {
      total: uniqueResults.length,
      today: todayCount,
      filtered: finalResults.length
    }
  };
}

const browserIdleTimer = setInterval(async () => {
  const now = Date.now();
  if (browserInstance && (now - lastUsedTime) > BROWSER_IDLE_TIMEOUT) {
    await closeBrowser();
  }
}, 30000);
if (browserIdleTimer.unref) {
  browserIdleTimer.unref();
}

process.on('beforeExit', closeBrowser);
process.on('SIGINT', closeBrowser);
process.on('SIGTERM', closeBrowser);

module.exports = {
  search,
  multiSearch,
  getBrowser,
  closeBrowser,
  ENGINE_SELECTORS
};
