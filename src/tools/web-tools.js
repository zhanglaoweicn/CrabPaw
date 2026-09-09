/* eslint-env browser */
/**
 * Web Tools - 网络操作工具集
 * 自动注册到中心注册表
 *
 * v2: 集成多后端搜索架构 + 正文提取
 */



const { registry } = require('./registry');
const { SearchBackendManager, ContentExtractor } = require('../core/search');

const WEB_TIMEOUT = 30000;

// 全局搜索后端管理器（延迟初始化）
let _searchManager = null;
function getSearchManager() {
  if (!_searchManager) {
    // 2026-08-31 修复: 构造时合并 config.search 密钥——此前只认 env, 用户在配置页
    // 填的淘宝/Tavily/Bing 密钥从未进入搜索管理器(网络工具恒无可用 API 后端)。
    let cfgKeys = null
    try {
      const { loadConfig } = require('../core/config')
      const s = loadConfig().search || {}
      cfgKeys = {
        baiduApiKey: s.baiduApiKey || process.env.BAIDU_API_KEY || '',
        tavilyApiKey: s.tavilyApiKey || process.env.TAVILY_API_KEY || '',
        bingApiKey: s.bingApiKey || process.env.BING_API_KEY || '',
        braveApiKey: s.braveApiKey || process.env.BRAVE_API_KEY || '',
        exaApiKey: s.exaApiKey || process.env.EXA_API_KEY || '',
      }
    } catch (e) { console.warn('[web-tools] 读取搜索配置失败:', e && e.message) }
    _searchManager = new SearchBackendManager(cfgKeys || {});
    // 同步运行时凭据
    _syncSearchCredentials(_searchManager);
  }
  // 动态注册 API 后端（支持运行时通过配置页面添加 Key）
  _ensureApiBackends(_searchManager);
  return _searchManager;
}

/**
 * 2026-08-31: 内部访问器——仅取已构造实例, 不再触发 _ensureApiBackends。
 * syncCredentials 经此获取实例, 否则 getSearchManager → _ensureApiBackends →
 * syncCredentials → getSearchManager 无限循环(栈溢出)。
 */
function __getManagerInstance() {
  return _searchManager;
}

function _syncSearchCredentials(_manager) {
  const { SearchBackendManager } = require('../core/search');
  SearchBackendManager.syncCredentials({
    jinaKey: process.env.JINA_API_KEY || '',
    braveKey: process.env.BRAVE_API_KEY || '',
    tavilyKey: process.env.TAVILY_API_KEY || '',
    baiduKey: process.env.BAIDU_API_KEY || '',
  });
}

function _ensureApiBackends(manager) {
  const { BaiduApiBackend, TavilyBackend, BingApiBackend, BraveBackend, SearchBackendManager } = require('../core/search');
  // 检查百度千帆 AI 搜索 Key（免费 1500 次/月，中文检索最优）
  if (process.env.BAIDU_API_KEY && !manager.getBackend('baidu_api')) {
    manager.register(new BaiduApiBackend({ apiKey: process.env.BAIDU_API_KEY }));
    console.log('[search] 动态注册百度千帆 AI 搜索后端');
  }
  // 检查 Tavily API Key
  if (process.env.TAVILY_API_KEY && !manager.getBackend('tavily')) {
    manager.register(new TavilyBackend({ apiKey: process.env.TAVILY_API_KEY }));
    console.log('[search] 动态注册 Tavily API 后端');
  }
  // 检查 Bing API Key
  if (process.env.BING_API_KEY && !manager.getBackend('bing_api')) {
    manager.register(new BingApiBackend({ apiKey: process.env.BING_API_KEY }));
    console.log('[search] 动态注册 Bing API 后端');
  }
  // 检查 Brave API Key
  if (process.env.BRAVE_API_KEY && !manager.getBackend('brave')) {
    manager.register(new BraveBackend({ apiKey: process.env.BRAVE_API_KEY }));
    console.log('[search] 动态注册 Brave API 后端');
  }
  // 同步凭据到静态变量
  SearchBackendManager.syncCredentials({
    jinaKey: process.env.JINA_API_KEY || '',
    braveKey: process.env.BRAVE_API_KEY || '',
    tavilyKey: process.env.TAVILY_API_KEY || '',
    baiduKey: process.env.BAIDU_API_KEY || '',
  });
}

// 全局正文提取器
let _contentExtractor = null;
function getContentExtractor() {
  if (!_contentExtractor) {
    _contentExtractor = new ContentExtractor();
  }
  return _contentExtractor;
}

const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.azure.com',
  '[::1]',          // IPv6 环回
  '[fe80::1]',      // IPv6 链路本地示例
];

const BLOCKED_IP_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^224\./,
  /^240\./,
];

// IPv6 私有/保留地址正则
const BLOCKED_IPV6_RANGES = [
  /^::1$/,                                          // 环回
  /^fe80:/i,                                        // 链路本地
  /^fc[0-9a-f]{2}:/i,                               // 唯一本地 (fc00::/7)
  /^fd[0-9a-f]{2}:/i,                               // 唯一本地 (fc00::/7)
  /^::ffff:(0|127|10|169\.254|172\.(1[6-9]|2[0-9]|3[0-1])|192\.168)\./i, // IPv4-mapped
];

function isBlockedUrl(urlString) {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();

    if (BLOCKED_HOSTS.includes(host)) {
      return { blocked: true, reason: `禁止访问: ${host}` };
    }

    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(host)) {
        return { blocked: true, reason: `禁止访问私有/保留 IP: ${host}` };
      }
    }

    // IPv6 地址检查（去掉方括号后匹配）
    const ipv6Host = host.replace(/^\[|\]$/g, '');
    for (const pattern of BLOCKED_IPV6_RANGES) {
      if (pattern.test(ipv6Host)) {
        return { blocked: true, reason: `禁止访问私有/保留 IPv6: ${ipv6Host}` };
      }
    }

    return { blocked: false };
  } catch (e) {
    return { blocked: true, reason: `无效的 URL: ${e.message}` };
  }
}

let _playwrightSearch = null;
let _playwrightLoadAttempted = false;
function _getPlaywrightSearch() {
  if (_playwrightLoadAttempted) return _playwrightSearch;
  _playwrightLoadAttempted = true;
  try {
    _playwrightSearch = require('../core/playwright-search');
    console.log('✅ WebSearch 将使用 Playwright 搜索');
} catch (e) {
  console.log('⚠️ Playwright 搜索模块未加载，WebSearch 将使用 HTTP 搜索');
  }
}

const JS_RENDER_DOMAINS = [
  { pattern: /mp\.weixin\.qq\.com/i, name: '微信公众号', selectors: { title: '#activity-name, .rich_media_title', content: '#js_content', author: '#js_name, .rich_media_meta_nickname .nickname_text', date: '#publish_time, .rich_media_meta_primary_area_link' } },
  { pattern: /mp\.qq\.com/i, name: 'QQ公众号', selectors: { title: 'h1, .article-title', content: '.article-content, .content-article', author: '.author-name, .source', date: '.pub-time, .article-time' } },
  { pattern: /zhuanlan\.zhihu\.com/i, name: '知乎专栏', selectors: { title: 'h1.Post-Title, .Post-Title', content: '.Post-RichText, .RichText', author: '.AuthorInfo-name, .UserLink-link', date: '.ContentItem-time' } },
  { pattern: /www\.zhihu\.com\/question/i, name: '知乎问答', selectors: { title: 'h1.QuestionHeader-title', content: '.RichContent-inner, .RichText', author: '.AuthorInfo-name', date: '.ContentItem-time' } },
  { pattern: /b23\.tv\/(?!av|bv|ep)/i, name: 'B站专栏', selectors: { title: 'h1.title, .article-title', content: '.article-content, .content-article', author: '.author-name, .up-name', date: '.pub-time, .publish-time' } },
  { pattern: /www\.bilibili\.com\/read/i, name: 'B站专栏', selectors: { title: 'h1.title, .article-title', content: '.article-content, .content-article', author: '.author-name, .up-name', date: '.pub-time, .publish-time' } },
  { pattern: /x\.com\/\w+\/status/i, name: 'X/Twitter', selectors: { title: '[data-testid="tweetText"]', content: '[data-testid="tweetText"]', author: '[data-testid="User-Name"]', date: 'time' } },
  { pattern: /twitter\.com\/\w+\/status/i, name: 'Twitter', selectors: { title: '[data-testid="tweetText"]', content: '[data-testid="tweetText"]', author: '[data-testid="User-Name"]', date: 'time' } },
];

function matchJsRenderDomain(url) {
  try {
    return JS_RENDER_DOMAINS.find(d => d.pattern.test(url)) || null;
  } catch {
    return null;
  }
}

async function fetchWithPlaywright(url, domainConfig) {
  if (!_getPlaywrightSearch() || !_getPlaywrightSearch().getBrowser) {
    return { error: 'Playwright 不可用，无法渲染此页面' };
  }

  const browser = await _getPlaywrightSearch().getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'zh-CN',
    javaScriptEnabled: true
  });

  const page = await context.newPage();

  try {
    console.log(`🌐 [Playwright-Fetch] 正在渲染: ${domainConfig.name} - ${url}`);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    const selectors = domainConfig.selectors;

    try {
      const primarySelector = selectors.content || 'body';
      await page.waitForSelector(primarySelector, { timeout: 10000 });
    } catch (e) {
      console.log(`⚠️ [Playwright-Fetch] 等待内容选择器超时，尝试直接提取`);
    }

    await page.waitForTimeout(2000);

    const extracted = await page.evaluate((sels) => {
      const getText = (sel) => {
        if (!sel) return '';
        const el = document.querySelector(sel);
        return el ? el.innerText.trim() : '';
      };

      const getHtml = (sel) => {
        if (!sel) return '';
        const el = document.querySelector(sel);
        if (!el) return '';
        return el.innerHTML;
      };

      const title = getText(sels.title);
      const author = getText(sels.author);
      const date = getText(sels.date);

      let contentText = getText(sels.content);
      let contentHtml = getHtml(sels.content);

      const images = [];
      if (sels.content) {
        const contentEl = document.querySelector(sels.content);
        if (contentEl) {
          contentEl.querySelectorAll('img').forEach(img => {
            const src = img.dataset.src || img.src;
            if (src && !src.includes('emoji') && !src.includes('icon') && !src.includes('logo')) {
              const alt = img.alt || '';
              images.push({ src, alt });
            }
          });
        }
      }

      if (!contentText) {
        contentText = document.body.innerText.slice(0, 50000);
        contentHtml = document.body.innerHTML.slice(0, 100000);
      }

      return { title, author, date, contentText, contentHtml, images };
    }, selectors);

    const meta = await page.evaluate(() => {
      const desc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const keywords = document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
      return { desc, keywords, ogTitle, ogDesc };
    });

    console.log(`✅ [Playwright-Fetch] 提取完成: 标题="${extracted.title?.slice(0, 50)}", 内容长度=${extracted.contentText?.length}`);

    return {
      url,
      method: 'playwright',
      domain: domainConfig.name,
      title: extracted.title || meta.ogTitle || '',
      author: extracted.author || '',
      date: extracted.date || '',
      content: extracted.contentText.slice(0, 50000),
      contentHtml: extracted.contentHtml.slice(0, 100000),
      images: extracted.images.slice(0, 20),
      meta: {
        description: meta.desc || meta.ogDesc || '',
        keywords: meta.keywords || ''
      }
    };
  } catch (error) {
    console.error(`❌ [Playwright-Fetch] 渲染失败: ${error.message}`);
    return { error: `Playwright 渲染失败: ${error.message}` };
  } finally {
    await page.close();
    await context.close();
  }
}

async function handleWebFetch(params, _context) {
  const { url } = params;
  
  const urlCheck = isBlockedUrl(url);
  if (urlCheck.blocked) {
    return { error: `SSRF 防护: ${urlCheck.reason}` };
  }

  const domainConfig = matchJsRenderDomain(url);
  if (domainConfig) {
    console.log(`🔍 [WebFetch] 检测到需要JS渲染的站点: ${domainConfig.name}`);
    const result = await fetchWithPlaywright(url, domainConfig);
    if (!result.error) return result;
    console.log(`⚠️ [WebFetch] Playwright 渲染失败，降级到 HTTP 请求`);
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_TIMEOUT);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    
    clearTimeout(timeoutId);
    
    const contentType = response.headers.get('content-type') || '';
    let content;
    
    if (contentType.includes('application/json')) {
      content = await response.json();
      return { url, status: response.status, json: content };
    } else {
      content = await response.text();
      return { url, status: response.status, content: content.slice(0, 50000) };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function handleWebSearch(params, _context) {
  const { query, num = 10, engine, backend, scenario } = params;

  if (!query || !query.trim()) {
    return { ok: false, tool: 'WebSearch', error: '缺少搜索关键词' };
  }

  // 优先使用多后端搜索管理器（两层级联式）
  const manager = getSearchManager();
  let result = null;  // T3: 提到 try 外——L357 在 try 块外引用 result,旧 const 块作用域致 ReferenceError

  try {
    result = await manager.search(query, { num, backend, scenario, engine });

    if (result.results && result.results.length > 0) {
      console.log(`✅ [WebSearch] ${result.backend} 返回 ${result.results.length} 条结果 (场景: ${scenario || manager.detectScenario(query)})`);
      // 确保返回 hint
      return {
        ...result,
        ok: true,
        tool: 'WebSearch',
        // 2026-08-19 搜索体验修复: hint 显式约束排版——此前 LLM 把 results 原样堆叠
        // (无格式/无编号/贴原始 JSON), 用户反馈"格式混乱"。改为明确输出结构要求。
        hint: result.hint || '用 Markdown 列表回答：每条为【标题（加粗）＋一句摘要＋来源链接】。必须从 results 中选取与问题相关的 3-5 条，按信息价值排序；如结果含 date 字段请标注日期。禁止原样贴出原始结果数组或 JSON。',
      };
    }

    // 如果 manager.search 返回了 error（所有引擎失败），尝试 Playwright 兜底
    if (result.error) {
      console.log(`⚠️ [WebSearch] 多后端搜索失败: ${result.error}`);
    }
  } catch (e) {
    console.log(`⚠️ [WebSearch] 多后端搜索异常: ${e.message}`);
  }

  // 2026-08-03: 外网搜索全部失败时给 LLM 明确失败信息（此前静默降级 Playwright
  // 也失败 → LLM 无反馈 → 用户体验糟糕）。明确告知 + 引导本地热点工具。
  try {
    const lastErr = (result && result.error) ? result.error : '搜索引擎全部不可用';
    return {
      success: false,
      error: `网络搜索暂时不可用（${lastErr}）。如果是查询热点/热搜类内容，请改用 hot_search 工具（本地热搜，不依赖外网搜索）；否则请直接告诉用户'网络搜索暂时不可用'，不要静默或继续尝试其他网页抓取。`,
    };
  } catch (e2) {
    /* best-effort */
    console.warn('[web-tools.js] 空 catch 补日志:', e2 && e2.message);
  }


  // 最终降级到 Playwright + HTTP 搜索
  if (_getPlaywrightSearch()) {
    try {
      console.log(`🔍 [WebSearch] 降级使用 Playwright 搜索: ${query}`);
      const result = await _getPlaywrightSearch().multiSearch(query, engine || null);

      if (result.results && result.results.length > 0) {
        const results = result.results.slice(0, num).map(r => ({
          title: r.title,
          url: r.link,
          snippet: r.desc,
          source: r.source,
          date: r.date
        }));

        return {
          ok: true,
          query,
          results,
          engine: result.engine,
          stats: result.stats,
          method: 'playwright',
          backend: 'playwright-legacy',
          // 2026-08-19: 排版约束统一走 SEARCH_ANSWER_HINT（与 manager 层一致）
          hint: require('../core/search').SEARCH_ANSWER_HINT,
        };
      }
    } catch (e) {
      console.log(`⚠️ [WebSearch] Playwright 搜索失败: ${e.message}`);
    }
  }

  return {
    ok: false,
    query,
    results: [],
    error: '所有搜索引擎均不可用（国内网络环境可能限制了免费搜索API）。建议配置付费 API Key（Tavily/Bing/Exa/Brave），或使用 WebFetch 直接获取已知 URL 内容。',
    hint: '尝试使用 fetch_url 直接获取已知 URL，或在设置中配置 Serper/Tavily/Brave/Jina API Key。',
  };
}

registry.register({
  name: 'WebFetch',
  toolset: 'web',
  category: 'network',
  description: '获取网页内容',
  schema: {
    description: '获取指定 URL 的内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要获取的 URL' }
      },
      required: ['url']
    }
  },
  handler: handleWebFetch,
  checkFn: (params) => {
    try {
      new URL(params.url);
      return true;
    } catch {
      return false;
    }
  },
  timeout: 60000,
  isReadOnly: true
});

registry.register({
  name: 'WebSearch',
  toolset: 'web',
  category: 'network',
  description: '搜索网络获取最新信息，支持中文和英文查询',
  schema: {
    description: '搜索网络获取最新信息，支持中文和英文查询',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        num: { type: 'number', description: '返回结果数量，默认 10' },
        engine: { type: 'string', description: '指定搜索引擎（可选）' },
        backend: { type: 'string', description: '指定搜索后端（可选）' },
        scenario: { type: 'string', description: '场景标签（可选）' }
      },
      required: ['query']
    }
  },
  handler: handleWebSearch,
  timeout: 30000,
  isReadOnly: true
});

/**
 * WebExtract - 正文提取
 * 抓取 URL 并提取可读正文，去除导航/广告/侧边栏
 */
async function handleWebExtract(params, _context) {
  const { urls, includeMeta } = params;
  const urlList = Array.isArray(urls) ? urls : [urls];

  if (urlList.length === 0) {
    return { error: '请提供至少一个 URL' };
  }

  if (urlList.length > 10) {
    return { error: '单次最多提取 10 个 URL' };
  }

  const extractor = getContentExtractor();
  const results = [];

  for (const url of urlList) {
    // SSRF 检查
    const urlCheck = isBlockedUrl(url);
    if (urlCheck.blocked) {
      results.push({ url, error: `SSRF 防护: ${urlCheck.reason}` });
      continue;
    }

    try {
      // 优先尝试 Playwright 渲染（对 JS 重度页面）
      const domainConfig = matchJsRenderDomain(url);
      let html = null;
      let method = 'http';

      if (domainConfig && _getPlaywrightSearch()) {
        try {
          const pwResult = await fetchWithPlaywright(url, domainConfig);
          if (!pwResult.error && pwResult.contentHtml) {
            html = pwResult.contentHtml;
            method = 'playwright';
          } else if (!pwResult.error && pwResult.content) {
            // Playwright 已提取纯文本，直接使用
            results.push({
              url,
              title: pwResult.title || '',
              author: pwResult.author || '',
              date: pwResult.date || '',
              content: pwResult.content,
              method: 'playwright',
              contentLength: pwResult.content.length,
              ...(includeMeta ? { meta: pwResult.meta } : {}),
            });
            continue;
          }
        } catch {
          console.warn('[web-tools.js] playwright fetch failed, falling back to HTTP');
        }
      }

      // HTTP 获取
      if (!html) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), WEB_TIMEOUT);
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html,application/xhtml+xml',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            results.push({ url, error: `HTTP ${response.status}` });
            continue;
          }
          html = await response.text();
        } catch (err) {
          clearTimeout(timeoutId);
          results.push({ url, error: err.message });
          continue;
        }
      }

      // 提取正文
      const extracted = extractor.extract(html, url);
      results.push({
        url,
        title: extracted.title,
        author: extracted.author,
        date: extracted.date,
        content: extracted.content,
        method: method === 'playwright' ? 'playwright+extractor' : `http+${extracted.method}`,
        contentLength: extracted.content.length,
        ...(includeMeta ? { meta: extracted.meta } : {}),
      });
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }

  // 单 URL 时直接返回结果对象
  if (urlList.length === 1) {
    return results[0];
  }

  return { results, total: results.length, extracted: results.filter(r => 'contentText' in r && r.contentText).length };
}

registry.register({
  name: 'WebExtract',
  toolset: 'web',
  category: 'network',
  description: '提取网页正文内容。抓取指定 URL，自动去除导航、广告、侧边栏等干扰内容，只保留可读正文。支持批量提取。',
  schema: {
    description: '提取网页正文，去除噪声内容',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          oneOf: [
            { type: 'string', description: '要提取的 URL' },
            { type: 'array', items: { type: 'string' }, description: '要提取的 URL 列表（最多10个）' }
          ],
          description: '要提取正文的 URL 或 URL 列表'
        },
        includeMeta: { type: 'boolean', description: '是否包含元数据（描述/关键词/图片），默认 false' }
      },
      required: ['urls']
    }
  },
  handler: handleWebExtract,
  checkFn: (params) => params.urls && (typeof params.urls === 'string' || Array.isArray(params.urls)),
  timeout: 120000,
  isReadOnly: true
});

console.log('🌐 网络工具集已注册:', registry.getByToolset('web').map(t => t.name).join(', '));

module.exports = {
  handleWebFetch,
  handleWebSearch,
  handleWebExtract,
  getSearchManager,
  getContentExtractor,
  __getManagerInstance,
};
