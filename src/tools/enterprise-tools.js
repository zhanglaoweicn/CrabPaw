/* eslint-env browser */
/**
 * Enterprise Tools - 企业资料查询工具集
 *
 * 数据源（全部免费、无需API Key）：
 *   1. 天眼查 (tianyancha.com) — 主源，数据最全，反爬较弱
 *   2. 企查查 (qcc.com) — 备源1
 *   3. 爱企查 (aiqicha.baidu.com) — 备源2，百度旗下
 *   4. 水滴信用 (shuidi.cn) — 备源3，凭安征信旗下
 *   5. 百度搜索 — 兜底
 *
 * 查询维度（8维度）：
 *   1. 基本工商  2. 股东股权  3. 主要人员  4. 风险信息
 *   5. 知识产权  6. 经营信息  7. 关联企业  8. 历史变更
 */

const { registry } = require('./registry');
const { getToolEvolutionBridge } = require('../core/tool-evolution-bridge');
const { getEnterpriseDataSourceManager } = require('../core/enterprise-data-source-manager');
const { getStockSkillEvolution } = require('../core/stock-skill-evolution');



// ==================== Playwright 爬虫 ====================

let _browser = null;
let _lastUsed = 0;
const BROWSER_IDLE_MS = 120000;
let _browserCloseTimer = null;

/**
 * 浏览器可执行文件回退查找。
 *
 * playwright-core 严格匹配自身版本对应的 browser revision（如 1.57 要
 * chromium_headless_shell-1200），换机/版本漂移后未装匹配 revision 时
 * chromium.launch 直接抛 "Executable doesn't exist"，整条企业查询链全灭。
 * 此处扫描 ms-playwright 缓存里任意已安装内核取最高 revision 回退，
 * 结果缓存（环境内 revision 集合不变）。找不到返回空串。
 */
let _fallbackExecutable = null;
function findFallbackChromium() {
  if (_fallbackExecutable !== null) return _fallbackExecutable;
  try {
    const fs = require('fs');
    const path = require('path');
    const base = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    if (!fs.existsSync(base)) { _fallbackExecutable = ''; return _fallbackExecutable; }
    const EXE_MAP = {
      chromium: { exe: 'chrome.exe', subs: ['chrome-win', 'chrome-win64'] },
      chromium_headless_shell: { exe: 'chrome-headless-shell.exe', subs: ['chrome-headless-shell-win64', 'chrome-win'] },
    };
    const candidates = [];
    for (const dir of fs.readdirSync(base)) {
      const m = dir.match(/^(chromium|chromium_headless_shell)-(\d+)$/);
      if (!m) continue;
      const spec = EXE_MAP[m[1]];
      for (const sub of spec.subs) {
        const exe = path.join(base, dir, sub, spec.exe);
        if (fs.existsSync(exe)) { candidates.push({ rev: Number(m[2]), exe }); break; }
      }
    }
    candidates.sort((a, b) => b.rev - a.rev);
    _fallbackExecutable = candidates.length ? candidates[0].exe : '';
  } catch (e) {
    console.warn('[enterprise-tools] 浏览器回退扫描失败:', e.message || e);
    _fallbackExecutable = '';
  }
  return _fallbackExecutable;
}

/**
 * 获取共享的 headless 浏览器实例
 * 统一管理生命周期，避免每次查询启动独立进程
 */
async function getBrowser() {
  const now = Date.now();
  if (_browser && _browser.isConnected && _browser.isConnected() && (now - _lastUsed) < BROWSER_IDLE_MS) {
    _lastUsed = now;
    return _browser;
  }
  if (_browser) {
    try { await _browser.close(); } catch (e) {
      /* ignore */
      console.warn('[enterprise-tools.js] 空 catch 补日志:', e && e.message);
    }

    _browser = null;
  }
  const { chromium } = require('playwright-core');
  const launchOpts = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  };
  try {
    _browser = await chromium.launch(launchOpts);
  } catch (e) {
    if (!/Executable doesn't exist/i.test(String(e && e.message))) throw e;
    const exe = findFallbackChromium();
    if (!exe) throw e;
    console.log(`[enterprise-tools] 匹配 revision 未安装，回退到已安装内核: ${exe}`);
    _browser = await chromium.launch({ ...launchOpts, executablePath: exe });
  }
  _lastUsed = now;

  // 浏览器断开连接时清理引用
  _browser.on('disconnected', () => { _browser = null; });

  // 设置空闲自动关闭定时器
  if (_browserCloseTimer) clearInterval(_browserCloseTimer);
  _browserCloseTimer = setInterval(async () => {
    if (_browser && Date.now() - _lastUsed > BROWSER_IDLE_MS) {
      try { await _browser.close(); } catch (e) { console.warn('[enterprise-tools] browser close failed:', e.message); }
      _browser = null;
    }
  }, 60000);
  if (_browserCloseTimer.unref) _browserCloseTimer.unref();

  return _browser;
}

async function _closeBrowser() {
  if (_browserCloseTimer) {
    clearInterval(_browserCloseTimer);
    _browserCloseTimer = null;
  }
  if (_browser) {
    try { await _browser.close(); } catch (e) {
      /* ignore */
      console.warn('[enterprise-tools.js] 空 catch 补日志:', e && e.message);
    }

    _browser = null;
  }
}

/**
 * 安全创建浏览器上下文 - 确保异常路径也能关闭浏览器
 * @param {Function} fn - 使用 context 的异步函数
 * @param {Object} contextOptions - 上下文选项
 */
async function withBrowserContext(contextOptions, fn) {
  const browser = await getBrowser();
  const context = await browser.newContext(contextOptions);
  try {
    return await fn(context);
  } finally {
    try { await context.close(); } catch (e) { console.warn('[enterprise-tools] context close failed:', e.message); }
  }
}

// ==================== 天眼查爬取（主源） ====================

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 简化企业名称用于搜索（去掉括号内容，避免触发登录墙）
 */
function simplifyKeyword(keyword) {
  return keyword
    .replace(/[（(][^）)]*[）)]/g, '')  // 去掉括号及内容如（海南）
    .replace(/\s+/g, '')                // 去掉多余空格
    .trim();
}

/**
 * 企业名称相似度评分（0-1）
 * 用于判断搜索结果是否匹配查询关键词
 * 核心逻辑：逐字匹配 + 地域/类型容错
 */
function nameSimilarity(query, result) {
  if (!query || !result) return 0;

  // 标准化：去空格、统一括号
  const normalize = s => s.replace(/\s+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')');
  const q = normalize(query);
  const r = normalize(result);

  // 精确匹配
  if (q === r) return 1.0;

  // 去掉公司类型后缀后比较
  const stripSuffix = s => s.replace(/(有限责任公司|有限公司|股份有限公司|集团有限公司|集团股份|合伙企业|工作室|公司)$/g, '');
  const qBase = stripSuffix(q);
  const rBase = stripSuffix(r);
  if (qBase === rBase) return 0.95;

  // 去掉括号内容后比较（保留地域信息在括号外）
  const stripParens = s => s.replace(/\([^)]*\)/g, '');
  const qNoParen = stripSuffix(stripParens(q));
  const rNoParen = stripSuffix(stripParens(r));
  if (qNoParen === rNoParen && qNoParen.length > 0) return 0.85;

  // 地域词序容错：提取地域词，去掉后比较核心名称
  // 例："海南岛上恰饭供应链" vs "岛上恰饭供应链管理(海南)" → 核心都是"岛上恰饭供应链"
  const REGIONS = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门';
  const stripRegion = s => {
    // 去掉括号内的地域
    let cleaned = stripParens(s);
    // 去掉开头或结尾的地域词
    cleaned = cleaned.replace(new RegExp(`^(${REGIONS})`), '');
    cleaned = cleaned.replace(new RegExp(`(${REGIONS})$`), '');
    return cleaned;
  };

  const qNoRegion = stripSuffix(stripRegion(q));
  const rNoRegion = stripSuffix(stripRegion(r));

  // 去掉地域后精确匹配
  if (qNoRegion === rNoRegion && qNoRegion.length > 0) return 0.88;

  // 词缀容错：去掉常见业务词缀后比较
  // 例："供应链" vs "供应链管理" → 核心都是"供应链"
  const stripBizSuffix = s => s.replace(/(管理|服务|技术|开发|咨询|设计|工程|建设|投资|控股|集团|科技|信息|数据|智能|网络|数字|互联网|物联网|电子商务|文化传媒|文化传播)$/g, '');
  const qCore = stripBizSuffix(qNoRegion);
  const rCore = stripBizSuffix(rNoRegion);

  if (qCore === rCore && qCore.length > 0) return 0.82;

  // 逐字匹配率（核心名称部分）
  if (qCore.length === 0 || rCore.length === 0) {
    // 退回到去掉括号后的基础比较
    const qFallback = stripParens(qBase);
    const rFallback = stripParens(rBase);
    if (qFallback.length === 0 || rFallback.length === 0) return 0;
    let matchCount = 0;
    const rChars = [...rFallback];
    for (const ch of qFallback) {
      const idx = rChars.indexOf(ch);
      if (idx >= 0) { matchCount++; rChars.splice(idx, 1); }
    }
    return matchCount / Math.max(qFallback.length, rFallback.length);
  }

  let matchCount = 0;
  const rChars = [...rCore];
  for (const ch of qCore) {
    const idx = rChars.indexOf(ch);
    if (idx >= 0) {
      matchCount++;
      rChars.splice(idx, 1);
    }
  }
  const charSimilarity = matchCount / Math.max(qCore.length, rCore.length);

  // 包含关系加分
  if (rCore.includes(qCore) || qCore.includes(rCore)) {
    return Math.min(0.9, charSimilarity * 0.5 + 0.5);
  }

  return charSimilarity;
}

/**
 * 从搜索结果中选择最佳匹配
 * 使用名称相似度评分，低于阈值则返回null（不匹配）
 * 同名公司优先选择存续/在业的
 */
function findBestMatch(query, results, threshold = 0.6) {
  if (!results || results.length === 0) return null;

  const cleanResults = results.map(r => ({
    ...r,
    cleanName: (r.name || '').replace(/[\n\r]/g, ' ').split(/\s+(?:关注|信用报告|简介|自身风险)/)[0].trim(),
  }));

  // 计算每个结果的相似度
  const scored = cleanResults.map(r => ({
    ...r,
    score: nameSimilarity(query, r.cleanName),
  }));

  // 按相似度排序
  scored.sort((a, b) => b.score - a.score);

  // 过滤低于阈值的结果
  const qualified = scored.filter(r => r.score >= threshold);
  if (qualified.length === 0) return null;

  // 如果有多个高分结果（同名公司），优先选择存续/在业的
  if (qualified.length > 1 && qualified[0].score >= 0.85) {
    const topScore = qualified[0].score;
    const sameScoreResults = qualified.filter(r => r.score >= topScore - 0.05);

    // 优先选择存续/在业的公司
    const activeResult = sameScoreResults.find(r => {
      const status = r.status || r.cleanName || '';
      return status.includes('存续') || status.includes('在业') || status.includes('开业');
    });

    if (activeResult) return activeResult;
  }

  return qualified[0];
}

/**
 * 生成企业名称变体，用于搜索无结果时的模糊匹配
 * 例："海南岛上恰饭供应链有限公司" → ["岛上恰饭供应链管理(海南)", "岛上恰饭供应链", "岛上恰饭"]
 */
function generateNameVariants(name) {
  const variants = [name]; // 原始名称始终第一个
  const normalize = s => s.replace(/\s+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')');
  const n = normalize(name);

  // 去掉公司类型后缀
  const stripSuffix = s => s.replace(/(有限责任公司|有限公司|股份有限公司|集团有限公司|集团股份|合伙企业|工作室|公司)$/g, '');
  const base = stripSuffix(n);
  if (base !== n) variants.push(base);

  // 去掉括号内容
  const stripParens = s => s.replace(/\([^)]*\)/g, '');
  const noParen = stripSuffix(stripParens(n));
  if (noParen !== base && noParen.length > 0) variants.push(noParen);

  // 地域词移到括号内（如"海南岛上恰饭供应链" → "岛上恰饭供应链(海南)"）
  const REGIONS = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门';
  const regionMatch = base.match(new RegExp(`^(${REGIONS})(.+)$`));
  if (regionMatch) {
    const regionName = `${regionMatch[2]}(${regionMatch[1]})有限公司`;
    variants.push(regionName);
    const regionName2 = `${regionMatch[2]}(${regionMatch[1]})有限责任公司`;
    variants.push(regionName2);
    // 也尝试带"管理"等词缀
    const regionName3 = `${regionMatch[2]}管理(${regionMatch[1]})有限公司`;
    variants.push(regionName3);
  }

  // 地域词从括号内移到开头（如"岛上恰饭供应链管理(海南)" → "海南岛上恰饭供应链管理"）
  const parenRegionMatch = base.match(/^(.+)\(([^)]+)\)$/);
  if (parenRegionMatch) {
    const movedName = `${parenRegionMatch[2]}${parenRegionMatch[1]}有限公司`;
    variants.push(movedName);
  }

  // 去掉地域词后搜索核心名称
  const stripRegion = s => {
    let cleaned = stripParens(s);
    cleaned = cleaned.replace(new RegExp(`^(${REGIONS})`), '');
    cleaned = cleaned.replace(new RegExp(`(${REGIONS})$`), '');
    return cleaned;
  };
  const coreName = stripSuffix(stripRegion(n));
  if (coreName.length >= 2 && coreName !== base) variants.push(coreName);

  // 去掉常见业务词缀（如"管理"、"服务"等）
  const stripBizSuffix = s => s.replace(/(管理|服务|技术|开发|咨询|设计|工程|建设|投资|控股|集团|科技|信息|数据|智能|网络|数字|互联网|物联网|电子商务|文化传媒|文化传播)$/g, '');
  const bizCore = stripBizSuffix(coreName);
  if (bizCore.length >= 2 && bizCore !== coreName) variants.push(bizCore);

  // 去重
  return [...new Set(variants.filter(v => v.length >= 2))];
}

/**
 * 天眼查PC版搜索（主源）
 * www.tianyancha.com 搜索结果包含完整工商信息，反爬较弱
 */
async function searchTianyancha(keyword) {
  // 使用共享浏览器实例 + withBrowserContext 确保异常安全
  return withBrowserContext({
    userAgent: PC_UA,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  }, async (context) => {
  // 注入反检测脚本
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // 天眼查搜索策略：先用完整名称搜索，被拦截再用简化关键词
  const simplifiedKeyword = keyword
    .replace(/[（()）]/g, '')
    .replace(/(有限公司|有限责任公司|股份有限公司|集团有限公司|集团股份|合伙企业|工作室|公司)$/g, '')
    .replace(/\s+/g, '')
    .trim() || keyword;

  // 先用完整名称搜索
  let searchUrl = `https://www.tianyancha.com/nsearch?key=${encodeURIComponent(keyword)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 检测是否被登录墙拦截
  const isBlocked = await page.evaluate(() => {
    const text = document.body.innerText;
    return text.includes('登录') && text.includes('查看完整') && !text.includes('法定代表人');
  });

  if (isBlocked && simplifiedKeyword !== keyword) {
    console.log(`[EnterpriseQuery] 天眼查完整名称被拦截，使用简化关键词: ${simplifiedKeyword}`);
    searchUrl = `https://www.tianyancha.com/nsearch?key=${encodeURIComponent(simplifiedKeyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  // 等待搜索结果渲染
  try {
    await page.waitForFunction(() => document.body.innerText.includes('法定代表人'), { timeout: 8000 });
  } catch (e) {
    console.warn('[enterprise-tools] tianyancha waitForFunction timed out, continuing with current content');
  }
  await page.waitForTimeout(2000);

  // 提取搜索结果 - 使用innerText解析
  const results = await page.evaluate(() => {
    const items = [];
    const bodyText = document.body.innerText;
    const segments = bodyText.split(/(?=法定代表人[：:])/);

    for (const seg of segments) {
      if (!seg.includes('法定代表人')) continue;
      const fullSeg = seg.substring(0, 600);
      const prevText = seg.substring(0, 200);
      const nameMatch = prevText.match(/([\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*有限公司|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*公司|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*集团|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*合伙企业)/);
      let name = nameMatch ? nameMatch[1].trim() : '';
      name = name.replace(/\{\d+\}/g, '').trim();
      if (name.length < 2) continue;

      let legalPerson = '';
      const lpMatch = fullSeg.match(/法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/);
      if (lpMatch) legalPerson = lpMatch[1];

      let regCapital = '';
      const rcMatch = fullSeg.match(/注册资本[：:\s]*([\d.]+万[^\s,，]*)/);
      if (!rcMatch) {
        const rcMatch2 = fullSeg.match(/([\d.]+万[^\s,，]*)/);
        if (rcMatch2) regCapital = rcMatch2[1];
      } else {
        regCapital = rcMatch[1];
      }

      let establishedDate = '';
      const edMatch = fullSeg.match(/成立日期[：:\s]*([\d-]+)/);
      if (edMatch) establishedDate = edMatch[1];

      let unifiedCode = '';
      const ucMatch = fullSeg.match(/统一社会信用代码[：:\s]*([A-Z0-9]{18})/);
      if (ucMatch) unifiedCode = ucMatch[1];

      let status = '';
      const stMatch = fullSeg.match(/(存续|在业|开业|注销|吊销|迁入|迁出|停业|清算)/);
      if (stMatch) status = stMatch[1];

      let address = '';
      const addrMatch = fullSeg.match(/地址[：:\s]*([\u4e00-\u9fff][^\n]{5,80})/);
      if (addrMatch) address = addrMatch[1].trim();

      items.push({ name, href: '', status, legalPerson, regCapital, establishedDate, unifiedCode, address, risks: '' });
    }
    return items;
  });

  // 如果PC版没提取到结果，回退到移动版
  if (results.length === 0) {
    console.log(`[EnterpriseQuery] 天眼查PC版无结果，尝试移动版`);
    return await searchTianyanchaMobile(keyword);
  }

  return results;
  }); // withBrowserContext end
}

/**
 * 天眼查移动版搜索（备选）
 */
async function searchTianyanchaMobile(keyword) {
  return withBrowserContext({
    userAgent: MOBILE_UA,
    locale: 'zh-CN',
    viewport: { width: 375, height: 812 },
  }, async (context) => {
    const page = await context.newPage();
    const simplifiedKeyword = keyword
      .replace(/[（()）]/g, '')
      .replace(/(有限公司|有限责任公司|股份有限公司|集团有限公司|集团股份|合伙企业|工作室|公司)$/g, '')
      .replace(/\s+/g, '')
      .trim() || keyword;

    let searchUrl = `https://m.tianyancha.com/search?key=${encodeURIComponent(keyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const isBlocked = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('登录') && !text.includes('法定代表人');
    });

    if (isBlocked && simplifiedKeyword !== keyword) {
      console.log(`[EnterpriseQuery] 天眼查移动版完整名称被拦截，使用简化关键词: ${simplifiedKeyword}`);
      searchUrl = `https://m.tianyancha.com/search?key=${encodeURIComponent(simplifiedKeyword)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    try {
      await page.waitForFunction(() => document.body.innerText.includes('法定代表人'), { timeout: 8000 });
    } catch (e) { console.warn('waitForFunction timed out waiting for 法定代表人 text'); }
    await page.waitForTimeout(2000);

    const results = await page.evaluate(() => {
      const items = [];
      const bodyText = document.body.innerText;
      const segments = bodyText.split(/(?=法定代表人[：:])/);

      for (const seg of segments) {
        if (!seg.includes('法定代表人')) continue;
        const prevText = seg.substring(0, 200);
        const nameMatch = prevText.match(/([\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*有限公司|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*公司|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*集团)/);
        let name = nameMatch ? nameMatch[1].trim() : '';
        name = name.replace(/\{\d+\}/g, '').trim();
        if (name.length < 2) continue;

        const fullSeg = seg.substring(0, 500);
        let legalPerson = '';
        const lpMatch = fullSeg.match(/法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/);
        if (lpMatch) legalPerson = lpMatch[1];

        let regCapital = '';
        const rcMatch = fullSeg.match(/注册资本[：:\s]*([\d.]+万[^\s,，]*)/);
        if (!rcMatch) {
          const rcMatch2 = fullSeg.match(/([\d.]+万[^\s,，]*)/);
          if (rcMatch2) regCapital = rcMatch2[1];
        } else {
          regCapital = rcMatch[1];
        }

        let establishedDate = '';
        const edMatch = fullSeg.match(/成立日期[：:\s]*([\d-]+)/);
        if (edMatch) establishedDate = edMatch[1];

        let status = '';
        const stMatch = fullSeg.match(/(存续|在业|开业|注销|吊销|迁入|迁出|停业|清算)/);
        if (stMatch) status = stMatch[1];

        items.push({ name, href: '', status, legalPerson, regCapital, establishedDate, unifiedCode: '', address: '', risks: '' });
      }
      return items;
    });

    return results;
  }); // withBrowserContext end
}

// ==================== 企查查爬取（备源1） ====================

async function searchQichacha(keyword) {
  const browser = await getBrowser();

  // 优先使用PC版搜索
  const context = await browser.newContext({
    userAgent: PC_UA,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await context.newPage();
    // 使用简化关键词搜索（去掉括号等可能触发反爬的字符）
    const searchKeyword = simplifyKeyword(keyword) || keyword;
    const searchUrl = `https://www.qcc.com/web/search?key=${encodeURIComponent(searchKeyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 等待搜索结果渲染（SPA页面需要等待Vue/React渲染完成）
    try {
      await page.waitForSelector('.company-item, .search-result-item, tbody tr, [class*="result"]', { timeout: 8000 });
    } catch (e) {
      console.warn('[enterprise-tools] qichacha waitForSelector timed out, falling back to innerText extraction');
    }
    await page.waitForTimeout(2000);

    // 等待页面文本内容包含"法定代表人"（确认搜索结果已渲染）
    try {
      await page.waitForFunction(() => document.body.innerText.includes('法定代表人'), { timeout: 5000 });
    } catch (e) {
      console.warn('[enterprise-tools] qichacha waitForFunction timed out, continuing with current content');
    }

    // 检测是否被重定向到登录页
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/user_login')) {
      console.log(`[EnterpriseQuery] 企查查PC版触发登录，尝试移动版`);
      await context.close();
      return await searchQichachaMobile(keyword);
    }

    // 提取PC版搜索结果 - 使用innerText解析策略（SPA页面CSS选择器不稳定）
    const results = await page.evaluate(() => {
      const items = [];
      const bodyText = document.body.innerText;

      // 企查查PC版搜索结果在innerText中格式清晰
      // 格式：企业名称 + 状态 + 法定代表人：xxx + 注册资本：xxx + 成立日期：xxx
      // 用正则从全文提取

      // 先找所有包含"法定代表人"的行段
      const segments = bodyText.split(/(?=法定代表人[：:])/);

      for (const seg of segments) {
        if (!seg.includes('法定代表人')) continue;

        // 在此段之前找企业名称（最近的一行）
        const prevText = seg.substring(0, 200);
        const nameMatch = prevText.match(/([\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*有限公司|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*公司|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*集团|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*合伙企业|[\u4e00-\u9fff][\u4e00-\u9fff\w（()）\s]*工作室)/);
        const name = nameMatch ? nameMatch[1].trim() : '';

        if (name.length < 2) continue;

        // 从当前段提取信息
        const fullSeg = seg.substring(0, 500);

        let legalPerson = '';
        const lpMatch = fullSeg.match(/法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/);
        if (lpMatch) legalPerson = lpMatch[1];

        let regCapital = '';
        const rcMatch = fullSeg.match(/注册资本[：:\s]*([\d.]+万[^\s,，]*)/);
        if (!rcMatch) {
          const rcMatch2 = fullSeg.match(/([\d.]+万元)/);
          if (rcMatch2) regCapital = rcMatch2[1];
        } else {
          regCapital = rcMatch[1];
        }

        let establishedDate = '';
        const edMatch = fullSeg.match(/成立日期[：:\s]*([\d-]+)/);
        if (edMatch) establishedDate = edMatch[1];

        let unifiedCode = '';
        const ucMatch = fullSeg.match(/统一社会信用代码[：:\s]*([A-Z0-9]{18})/);
        if (ucMatch) unifiedCode = ucMatch[1];

        let status = '';
        const stMatch = fullSeg.match(/(存续|在业|开业|注销|吊销|迁入|迁出|停业|清算)/);
        if (stMatch) status = stMatch[1];

        items.push({
          name,
          href: '',
          status,
          legalPerson,
          regCapital,
          establishedDate,
          unifiedCode,
          risks: '',
        });
      }

      return items;
    });

    // 如果PC版没提取到结果，回退到移动版
    if (results.length === 0) {
      console.log(`[EnterpriseQuery] 企查查PC版无结果，尝试移动版`);
      await context.close();
      return await searchQichachaMobile(keyword);
    }

    return results;
  } finally {
    await context.close();
  }
}

/**
 * 企查查移动版搜索（备选）
 */
async function searchQichachaMobile(keyword) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    locale: 'zh-CN',
    viewport: { width: 375, height: 812 },
  });

  try {
    const page = await context.newPage();

    // 先用原始关键词搜索
    let searchUrl = `https://m.qcc.com/search?key=${encodeURIComponent(keyword)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 检测是否被重定向到登录页
    const currentUrl = page.url();
    if (currentUrl.includes('/mlogin') || currentUrl.includes('/login')) {
      console.log(`[EnterpriseQuery] 企查查移动版触发登录墙，尝试简化关键词`);
      const simplified = simplifyKeyword(keyword);
      if (simplified !== keyword) {
        searchUrl = `https://m.qcc.com/search?key=${encodeURIComponent(simplified)}`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
      }
    }

    // 提取搜索结果
    const results = await page.evaluate(() => {
      const items = [];

      // 企查查移动版搜索结果结构 - 多种选择器兼容
      const companyCards = document.querySelectorAll(
        '.list-item, [class*="company"], a[href*="/firm/"], a[href*="/company/"], ' +
        '.search-result-item, .result-list a, [class*="search"] a, ' +
        'section a, ul li a, .app-list a'
      );

      companyCards.forEach(card => {
        const text = card.textContent || '';
        const href = card.getAttribute('href') || card.querySelector('a')?.getAttribute('href') || '';

        // 提取企业名称 - 多种选择器
        const nameEl = card.querySelector('.ma_h1, [class*="name"], h3, h2, .title') ||
                       card.querySelector('a[href*="/firm/"], a[href*="/company/"]') ||
                       (card.tagName === 'A' ? card : null);
        let name = nameEl?.textContent?.trim() || '';

        // 清理名称中的模板占位符
        name = name.replace(/\{\d+\}/g, '').trim();

        if (name.length < 2) return;

        // 提取状态标签
        const statusEl = card.querySelector('.m-l-sm, [class*="tag"], [class*="status"]');
        const status = statusEl?.textContent?.trim() || '';

        // 提取法定代表人
        let legalPerson = '';
        const lpMatch = text.match(/法定代表人\s*([\u4e00-\u9fff]+)/);
        if (lpMatch) legalPerson = lpMatch[1];

        // 提取注册资本
        let regCapital = '';
        const rcMatch = text.match(/注册资本\s*([\d.]+万[^\s]*)/);
        if (rcMatch) regCapital = rcMatch[1];

        // 提取成立日期
        let establishedDate = '';
        const edMatch = text.match(/成立日期\s*([\d-]+)/);
        if (edMatch) establishedDate = edMatch[1];

        // 提取风险信息
        let risks = '';
        const riskMatch = text.match(/(\d+)\s*条自身风险/);
        if (riskMatch) risks = riskMatch[1] + '条自身风险';
        const relRiskMatch = text.match(/(\d+)\s*条关联风险/);
        if (relRiskMatch) risks += (risks ? ', ' : '') + relRiskMatch[1] + '条关联风险';

        // 构建详情URL
        let detailUrl = '';
        if (href.includes('/firm/') || href.includes('/company/')) {
          detailUrl = href.startsWith('http') ? href : `https://m.qcc.com${href}`;
        }

        items.push({
          name,
          href: detailUrl,
          status,
          legalPerson,
          regCapital,
          establishedDate,
          risks,
        });
      });

      return items;
    });

    // 如果结构化提取失败，用全文解析兜底
    if (results.length === 0) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const companies = [];

      // 从文本中提取企业信息块
      const blocks = bodyText.split(/(?=法定代表人)/);
      for (const block of blocks) {
        const nameMatch = block.match(/^([\u4e00-\u9fff]+(?:有限公司|股份|集团|公司|企业|厂|店|部|院|所|中心|合作社))/);
        if (!nameMatch) continue;

        const lpMatch = block.match(/法定代表人\s*([\u4e00-\u9fff]+)/);
        const rcMatch = block.match(/注册资本\s*([\d.]+万[^\s]*)/);
        const edMatch = block.match(/成立日期\s*([\d-]+)/);

        companies.push({
          name: nameMatch[1],
          legalPerson: lpMatch?.[1] || '',
          regCapital: rcMatch?.[1] || '',
          establishedDate: edMatch?.[1] || '',
          href: '',
          status: '',
          risks: '',
        });
      }

      return companies;
    }

    return results;
  } finally {
    await context.close();
  }
}

/**
 * 企查查移动版详情页
 */
async function fetchQichachaDetail(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    locale: 'zh-CN',
    viewport: { width: 375, height: 812 },
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const detail = await page.evaluate(() => {
      const data = {};
      const bodyText = document.body.innerText;

      // 通用键值对提取
      const kvPatterns = [
        /法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/,
        /注册资本[：:\s]*([\d.]+万[^\n]*)/,
        /成立日期[：:\s]*([\d-]+)/,
        /经营状态[：:\s]*(存续|在业|开业|注销|吊销|迁入|迁出|停业|清算)/,
        /统一社会信用代码[：:\s]*([A-Z0-9]{18})/,
        /工商注册号[：:\s]*([\d]+)/,
        /组织机构代码[：:\s]*([A-Z0-9-]+)/,
        /纳税人识别号[：:\s]*([A-Z0-9]{18})/,
        /企业类型[：:\s]*([^\n]{2,30})/,
        /所属行业[：:\s]*([^\n]{2,30})/,
        /登记机关[：:\s]*([^\n]{2,30})/,
        /核准日期[：:\s]*([\d-]+)/,
        /营业期限[：:\s]*([^\n]{2,40})/,
        /注册地址[：:\s]*([^\n]{2,80})/,
        /经营范围[：:\s]*([^\n]+)/,
      ];

      for (const pattern of kvPatterns) {
        const match = bodyText.match(pattern);
        if (match) {
          const key = pattern.source.split('[')[0];
          data[key] = match[1].trim();
        }
      }

      // DOM表格提取
      const tables = document.querySelectorAll('table');
      tables.forEach((table, _idx) => {
        const rows = Array.from(table.querySelectorAll('tr'));
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('th, td'));
          if (cells.length >= 2) {
            const key = cells[0].textContent.trim();
            const val = cells[1].textContent.trim();
            if (key && val && key.length < 20) data[key] = val;
          }
        });
      });

      // 列表项提取
      const items = document.querySelectorAll('.detail-item, .info-item, li, [class*="item"]');
      items.forEach(item => {
        const text = item.textContent.trim();
        const match = text.match(/^([^:：\n]+)[：:]\s*(.+)$/);
        if (match) {
          const key = match[1].trim();
          const val = match[2].trim();
          if (key.length > 0 && val.length > 0 && key.length < 20) {
            data[key] = val;
          }
        }
      });

      // 企业名称
      data._companyName = document.querySelector('h1, h2, [class*="name"]')?.textContent?.trim() || '';

      return data;
    });

    return detail;
  } finally {
    await context.close();
  }
}

// ==================== 爱企查爬取（备源1） ====================

/**
 * 爱企查搜索 — 可能触发验证码，作为备源
 */
async function searchAiqicha(keyword) {
  return withBrowserContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  }, async (context) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  // 先访问首页获取Cookie
  await page.goto('https://aiqicha.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1500);

  // 搜索 - 去掉括号避免搜索问题
  const searchKeyword = keyword.replace(/[（()）]/g, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = `https://aiqicha.baidu.com/s?q=${encodeURIComponent(searchKeyword)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // 检查是否被验证码拦截
  const currentUrl = page.url();
  if (currentUrl.includes('captcha') || currentUrl.includes('wappass')) {
    return []; // 被验证码拦截，跳过
  }

    // 提取pageData
    const pageDataResults = await page.evaluate(() => {
      try {
        if (window.pageData?.result?.resultList) {
          return window.pageData.result.resultList.map(item => ({
            name: (item.entName || '').replace(/<[^>]+>/g, ''),
            pid: item.pid || null,
            status: item.openStatus || '',
            regCapital: item.regCapital || '',
            legalPerson: item.legalPerson || '',
            establishedDate: item.startDate || '',
          }));
        }

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.includes('resultList')) {
            const match = text.match(/window\.pageData\s*=\s*(\{[\s\S]*?\});/);
            if (match) {
              const data = JSON.parse(match[1]);
              if (data?.result?.resultList) {
                return data.result.resultList.map(item => ({
                  name: (item.entName || '').replace(/<[^>]+>/g, ''),
                  pid: item.pid || null,
                  status: item.openStatus || '',
                  regCapital: item.regCapital || '',
                  legalPerson: item.legalPerson || '',
                  establishedDate: item.startDate || '',
                }));
              }
            }
          }
        }
        return [];
      } catch (e) { return []; }
    });

    return pageDataResults;
  }); // withBrowserContext end
}

/**
 * 爱企查详情
 */
async function fetchAiqichaDetail(pid) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });

  try {
    const page = await context.newPage();
    await page.goto('https://aiqicha.baidu.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    const detailUrl = `https://aiqicha.baidu.com/company_detail_${pid}`;
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // 检查验证码
    if (page.url().includes('captcha') || page.url().includes('wappass')) {
      return { detail: {}, pageData: null };
    }

    const pageData = await page.evaluate(() => {
      try {
        if (window.pageData) return window.pageData;
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.includes('basicData') || text.includes('entName')) {
            const match = text.match(/window\.pageData\s*=\s*(\{[\s\S]*?\});/);
            if (match) return JSON.parse(match[1]);
          }
        }
        return null;
      } catch (e) { return null; }
    });

    const detail = await page.evaluate(() => {
      const data = {};
      const basicSection = document.querySelector('.detail-basic, .basic-info, [class*="basic"]');
      if (basicSection) {
        basicSection.querySelectorAll('tr, .info-item, [class*="item"]').forEach(row => {
          const label = row.querySelector('.label, th, [class*="label"]')?.textContent?.trim() || '';
          const value = row.querySelector('.value, td, [class*="value"]')?.textContent?.trim() || '';
          if (label && value) data[label] = value;
        });
      }
      data._companyName = document.querySelector('h1, [class*="company-name"]')?.textContent?.trim() || '';
      return data;
    });

    return { detail, pageData };
  } finally {
    await context.close();
  }
}

// ==================== 水滴信用爬取（备源2） ====================

async function searchShuidi(keyword) {
  return withBrowserContext({
    userAgent: MOBILE_UA,
    locale: 'zh-CN',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  }, async (context) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const searchKeyword = keyword.replace(/[（()）]/g, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = `https://shuidi.cn/search?searchkey=${encodeURIComponent(searchKeyword)}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000); // 水滴信用需要更长的渲染时间

  const results = await page.evaluate(() => {
    const items = [];
    const cards = document.querySelectorAll('[class*="result"], [class*="company"], a[href*="company"]');
    cards.forEach(card => {
      const nameEl = card.querySelector('a, [class*="name"], h3');
      const name = nameEl?.textContent?.trim() || '';
      const href = nameEl?.getAttribute('href') || '';
      if (name.length >= 2) {
        items.push({
          name,
          href: href.startsWith('http') ? href : `https://shuidi.cn${href}`,
        });
      }
    });
    return items;
  });

  return results;
  }); // withBrowserContext end
}

// ==================== 百度搜索聚合（兜底） ====================

async function searchBaiduAggregation(keyword) {
  return withBrowserContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  }, async (context) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const searchKeyword = keyword.replace(/[（()）]/g, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(searchKeyword + ' 企业信息 工商注册')}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000);

  const results = await page.evaluate(() => {
    const items = [];
    const resultDivs = document.querySelectorAll('.result, .c-container');
    resultDivs.forEach(div => {
      const titleEl = div.querySelector('h3 a, .t a');
      const title = titleEl?.textContent?.trim() || '';
      const href = titleEl?.getAttribute('href') || '';
      const snippet = div.querySelector('.c-abstract, .c-span-last, .content-right_8Zs40')?.textContent?.trim() || '';
      if (title.length < 2) return;

      let legalPerson = '', regCapital = '', establishedDate = '', status = '';
      const lpMatch = snippet.match(/法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/);
      if (lpMatch) legalPerson = lpMatch[1];
      const rcMatch = snippet.match(/注册资本[：:\s]*([\d.]+万[^\s,，。.]*)/);
      if (rcMatch) regCapital = rcMatch[1];
      const edMatch = snippet.match(/成立日期[：:\s]*(\d{4}-\d{2}-\d{2})/);
      if (edMatch) establishedDate = edMatch[1];
      const stMatch = snippet.match(/经营状态[：:\s]*(存续|在业|开业|注销|吊销)/);
      if (stMatch) status = stMatch[1];

      items.push({ title, href, snippet: snippet.substring(0, 300), legalPerson, regCapital, establishedDate, status });
    });
    return items;
  });

  const aggregated = { name: keyword, legalPerson: '', regCapital: '', establishedDate: '', status: '', snippets: [] };
  for (const r of results.slice(0, 5)) {
    if (r.legalPerson && !aggregated.legalPerson) aggregated.legalPerson = r.legalPerson;
    if (r.regCapital && !aggregated.regCapital) aggregated.regCapital = r.regCapital;
    if (r.establishedDate && !aggregated.establishedDate) aggregated.establishedDate = r.establishedDate;
    if (r.status && !aggregated.status) aggregated.status = r.status;
    if (r.snippet) aggregated.snippets.push(r.snippet);
  }

  if (!aggregated.legalPerson && !aggregated.regCapital) {
    const fullText = await page.evaluate(() => document.body.innerText);
    const lpMatch = fullText.match(/法定代表人[：:\s]*([^\s,，。.、：:]{2,4})/);
    if (lpMatch) {
      let lp = lpMatch[1];
      lp = lp.replace(/^[是为有]/, '');
      lp = lp.replace(/[注册登]$/, '');
      if (/^[\u4e00-\u9fff]{2,4}$/.test(lp)) aggregated.legalPerson = lp;
    }
    const rcMatch = fullText.match(/注册资本[：:\s]*([\d.]+万[^\s,，。.]*)/);
    if (rcMatch) aggregated.regCapital = rcMatch[1];
    const edMatch = fullText.match(/成立(?:日期|时间)[：:\s]*(\d{4}-\d{2}-\d{2})/);
    if (edMatch) aggregated.establishedDate = edMatch[1];
    const stMatch = fullText.match(/经营状态[：:\s]*(存续|在业|开业|注销|吊销)/);
    if (stMatch) aggregated.status = stMatch[1];
  }

  return aggregated;
  }); // withBrowserContext end
}

// ==================== Bing搜索聚合（备用兜底） ====================

async function searchBingAggregation(keyword) {
  return withBrowserContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  }, async (context) => {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  const searchKeyword = keyword.replace(/[（()）]/g, ' ').replace(/\s+/g, ' ').trim();
  const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(searchKeyword + ' 工商信息 法定代表人 注册资本')}`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  const results = await page.evaluate(() => {
    const items = [];
    const resultLi = document.querySelectorAll('#b_results > li');
    resultLi.forEach(li => {
      const titleEl = li.querySelector('h2 a');
      const title = titleEl?.textContent?.trim() || '';
      const snippetEl = li.querySelector('.b_caption p, .b_lineclamp2, p');
      const snippet = snippetEl?.textContent?.trim() || '';
      if (title.length < 2) return;

      let legalPerson = '', regCapital = '', establishedDate = '', status = '', address = '', businessScope = '';
      const lpMatch = snippet.match(/法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/);
      if (lpMatch) legalPerson = lpMatch[1];
      const rcMatch = snippet.match(/注册资本[：:\s]*([\d.]+万[^\s,，]*)/);
      if (rcMatch) regCapital = rcMatch[1];
      const edMatch = snippet.match(/成立日期[：:\s]*([\d-]+)/);
      if (edMatch) establishedDate = edMatch[1];
      const stMatch = snippet.match(/经营状态[：:\s]*(存续|在业|开业|注销|吊销)/);
      if (stMatch) status = stMatch[1];
      const addrMatch = snippet.match(/(?:注册地址|住所|地址)[：:\s]*([^\s,，。;；]{5,50})/);
      if (addrMatch) address = addrMatch[1];
      const bsMatch = snippet.match(/(?:经营范围)[：:\s]*([^\s]{10,100})/);
      if (bsMatch) businessScope = bsMatch[1];

      items.push({ title, snippet: snippet.substring(0, 500), legalPerson, regCapital, establishedDate, status, address, businessScope });
    });
    return items;
  });

  const aggregated = { name: keyword, legalPerson: '', regCapital: '', establishedDate: '', status: '', address: '', businessScope: '', snippets: [] };
  for (const r of results.slice(0, 8)) {
    if (r.legalPerson && !aggregated.legalPerson) aggregated.legalPerson = r.legalPerson;
    if (r.regCapital && !aggregated.regCapital) aggregated.regCapital = r.regCapital;
    if (r.establishedDate && !aggregated.establishedDate) aggregated.establishedDate = r.establishedDate;
    if (r.status && !aggregated.status) aggregated.status = r.status;
    if (r.address && !aggregated.address) aggregated.address = r.address;
    if (r.businessScope && !aggregated.businessScope) aggregated.businessScope = r.businessScope;
    if (r.snippet) aggregated.snippets.push(r.snippet);
  }

  if (!aggregated.legalPerson && !aggregated.regCapital) {
    const fullText = await page.evaluate(() => document.body.innerText);
    const lpMatch = fullText.match(/法定代表人[：:\s]*([\u4e00-\u9fff]{2,4})/);
    if (lpMatch) aggregated.legalPerson = lpMatch[1];
    const rcMatch = fullText.match(/注册资本[：:\s]*([\d.]+万[^\s,，]*)/);
    if (rcMatch) aggregated.regCapital = rcMatch[1];
    const edMatch = fullText.match(/成立日期[：:\s]*([\d-]+)/);
    if (edMatch) aggregated.establishedDate = edMatch[1];
    const stMatch = fullText.match(/经营状态[：:\s]*(存续|在业|开业|注销|吊销)/);
    if (stMatch) aggregated.status = stMatch[1];
  }
  return aggregated;
  }); // withBrowserContext end
}

// ==================== 数据标准化 ====================

/**
 * 将多源数据标准化为统一格式
 */
function normalizeEnterpriseData(rawData, source) {
  const data = {
    _source: source,
    basic: {
      name: '',
      legalPerson: '',
      regCapital: '',
      establishedDate: '',
      status: '',
      unifiedCode: '',
      regNumber: '',
      orgCode: '',
      taxNumber: '',
      regAddress: '',
      businessScope: '',
      companyType: '',
      industry: '',
      authority: '',
      operatingPeriod: '',
      approvedDate: '',
    },
    shareholders: [],
    keyPersonnel: [],
    risks: { dishonest: [], restricted: [], lawsuits: [], penalties: [], abnormal: [], selfRisk: '', relatedRisk: '' },
    intellectualProperty: { trademarks: [], patents: [], copyrights: [] },
    business: { bidding: [], recruitment: [], taxRating: '' },
    relatedCompanies: [],
    historyChanges: [],
  };

  const d = rawData.detail || rawData;
  const pd = rawData.pageData?.data?.basicData || rawData.pageData?.result || null;

  // 优先使用pageData（结构化数据）
  if (pd) {
    data.basic.name = pd.entName || pd.companyName || '';
    data.basic.legalPerson = pd.legalPerson || pd.legalPersonName || '';
    data.basic.regCapital = pd.regCapital || '';
    data.basic.establishedDate = pd.annualDate || pd.startDate || pd.estiblishTime || '';
    data.basic.status = pd.openStatus || pd.regStatus || '';
    data.basic.unifiedCode = pd.unifiedCode || pd.creditCode || '';
    data.basic.regNumber = pd.regCode || '';
    data.basic.orgCode = pd.orgNo || '';
    data.basic.taxNumber = pd.taxNo || '';
    data.basic.regAddress = pd.regAddr || pd.address || '';
    data.basic.businessScope = pd.scope || pd.businessScope || '';
    data.basic.companyType = pd.entType || pd.companyOrgType || '';
    data.basic.industry = pd.industry || '';
    data.basic.authority = pd.authority || '';
    data.basic.operatingPeriod = pd.openTime || pd.operatingPeriod || '';
    data.basic.approvedDate = pd.approvedTime || '';

    if (pd.shareHolderList || pd.shareholders) {
      data.shareholders = (pd.shareHolderList || pd.shareholders || []).map(h => ({
        name: h.stockName || h.name || '',
        ratio: h.stockProportion || h.ratio || '',
        capital: h.shouldCap || h.subscribedCapital || '',
      }));
    }

    if (pd.employeeList || pd.keyPersonnel) {
      data.keyPersonnel = (pd.employeeList || pd.keyPersonnel || []).map(e => ({
        name: e.employeeName || e.name || '',
        position: e.position || e.job || '',
      }));
    }
  }

  // DOM提取数据映射
  if (!data.basic.name) data.basic.name = d._companyName || d.name || d['企业名称'] || d['公司名称'] || '';
  // 清理企业名称中的多余内容（简介、标签、模板占位符等）
  if (data.basic.name) {
    data.basic.name = data.basic.name
      .replace(/\{\d+\}/g, '')  // 移除模板占位符如 {0}, {1}
      .split(/\s+(?:信用报告|简介|自身风险|存续|注销|吊销)/)[0]
      .trim();
  }
  // 名称太短则清空（可能是误提取）
  if (data.basic.name && data.basic.name.length < 2) data.basic.name = '';
  if (!data.basic.legalPerson) data.basic.legalPerson = d.legalPerson || d['法定代表人'] || d['法人'] || '';
  if (!data.basic.regCapital) data.basic.regCapital = d.regCapital || d['注册资本'] || '';
  if (!data.basic.establishedDate) data.basic.establishedDate = d.establishedDate || d['成立日期'] || d['成立时间'] || '';
  if (!data.basic.status) data.basic.status = d.status || d['经营状态'] || d['状态'] || '';
  // 清理经营状态，只保留状态词
  if (data.basic.status) {
    const statusMatch = data.basic.status.match(/(存续|在业|开业|注销|吊销|迁入|迁出|停业|清算)/);
    if (statusMatch) data.basic.status = statusMatch[1];
  }
  if (!data.basic.unifiedCode) data.basic.unifiedCode = d.unifiedCode || d['统一社会信用代码'] || d['信用代码'] || '';
  if (!data.basic.regNumber) data.basic.regNumber = d.regNumber || d['工商注册号'] || '';
  if (!data.basic.orgCode) data.basic.orgCode = d.orgCode || d['组织机构代码'] || '';
  if (!data.basic.taxNumber) data.basic.taxNumber = d.taxNumber || d['纳税人识别号'] || '';
  if (!data.basic.regAddress) data.basic.regAddress = d.regAddress || d.address || d['注册地址'] || d['住所'] || '';
  if (!data.basic.businessScope) data.basic.businessScope = d.businessScope || d['经营范围'] || '';
  if (!data.basic.companyType) data.basic.companyType = d.companyType || d['企业类型'] || d['公司类型'] || '';
  if (!data.basic.industry) data.basic.industry = d.industry || d['所属行业'] || d['行业'] || '';
  if (!data.basic.authority) data.basic.authority = d.authority || d['登记机关'] || '';
  if (!data.basic.operatingPeriod) data.basic.operatingPeriod = d.operatingPeriod || d['营业期限'] || '';
  if (!data.basic.approvedDate) data.basic.approvedDate = d.approvedDate || d['核准日期'] || '';

  // 风险信息
  if (d['自身风险'] || rawData.selfRisk) data.risks.selfRisk = d['自身风险'] || rawData.selfRisk || '';
  if (d['关联风险'] || rawData.relatedRisk) data.risks.relatedRisk = d['关联风险'] || rawData.relatedRisk || '';

  // 表格数据映射
  for (const [key, value] of Object.entries(d)) {
    if (key.startsWith('table_') && value.headers && value.rows) {
      const tableName = value.headers.join(',');
      if (tableName.includes('股东') || tableName.includes('持股')) {
        data.shareholders = value.rows.map(row => ({
          name: row[0] || '',
          ratio: row.find((_, i) => value.headers[i]?.includes('比例')) || '',
          capital: row.find((_, i) => value.headers[i]?.includes('认缴') || value.headers[i]?.includes('出资')) || '',
        }));
      }
      if (tableName.includes('人员') || tableName.includes('高管') || tableName.includes('董监')) {
        data.keyPersonnel = value.rows.map(row => ({ name: row[0] || '', position: row[1] || '' }));
      }
      if (tableName.includes('变更')) {
        data.historyChanges = value.rows.map(row => ({
          item: row[0] || '', before: row[1] || '', after: row[2] || '', date: row[3] || '',
        }));
      }
    }
  }

  return data;
}

// ==================== 股权穿透分析 (P2) ====================

function analyzeShareholderStructure(shareholders) {
  if (!shareholders || shareholders.length === 0) {
    return { controller: '未知', path: [], concentration: 0, summary: '无股东数据' };
  }

  const sorted = [...shareholders].sort((a, b) => (parseFloat(b.ratio) || 0) - (parseFloat(a.ratio) || 0));
  const topHolder = sorted[0];
  const topRatio = parseFloat(topHolder.ratio) || 0;
  const top3Ratio = sorted.slice(0, 3).reduce((sum, s) => sum + (parseFloat(s.ratio) || 0), 0);

  let controlType = '分散控制';
  if (topRatio >= 67) controlType = '绝对控股';
  else if (topRatio >= 50) controlType = '相对控股';
  else if (topRatio >= 34) controlType = '重大影响';
  else if (top3Ratio >= 50) controlType = '联合控制';

  return {
    controller: topHolder.name,
    controllerRatio: topRatio,
    controlType,
    concentration: top3Ratio,
    topShareholders: sorted.slice(0, 5).map(s => `${s.name}${s.ratio ? ` (${s.ratio})` : ''}`),
    summary: `${controlType}，第一大股东${topHolder.name}持股${topRatio ? topRatio + '%' : '未知'}，前3大股东合计${top3Ratio ? top3Ratio.toFixed(1) + '%' : '未知'}`,
  };
}

// ==================== 风险画像 (P2) ====================

function analyzeRiskProfile(risks, basic) {
  const riskItems = [];
  let riskScore = 0;

  if (risks.dishonest?.length > 0) { riskScore += 40; riskItems.push({ level: '高', type: '失信被执行', count: risks.dishonest.length }); }
  if (risks.restricted?.length > 0) { riskScore += 25; riskItems.push({ level: '高', type: '限制消费', count: risks.restricted.length }); }
  if (risks.lawsuits?.length > 0) { riskScore += 15; riskItems.push({ level: '中', type: '司法诉讼', count: risks.lawsuits.length }); }
  if (risks.penalties?.length > 0) { riskScore += 15; riskItems.push({ level: '中', type: '行政处罚', count: risks.penalties.length }); }
  if (risks.abnormal?.length > 0) { riskScore += 20; riskItems.push({ level: '中', type: '经营异常', count: risks.abnormal.length }); }
  if (basic.status && (basic.status.includes('注销') || basic.status.includes('吊销'))) {
    riskScore += 30; riskItems.push({ level: '高', type: '经营状态异常', details: [basic.status] });
  }

  // 企查查搜索结果中的风险数量
  if (risks.selfRisk) {
    const num = parseInt(risks.selfRisk) || 0;
    if (num > 0) { riskScore += Math.min(20, num); riskItems.push({ level: num > 50 ? '高' : '中', type: '自身风险', count: num }); }
  }

  riskScore = Math.min(100, riskScore);
  let riskLevel = '低风险';
  if (riskScore >= 60) riskLevel = '高风险';
  else if (riskScore >= 30) riskLevel = '中风险';

  return {
    riskScore,
    riskLevel,
    riskItems,
    summary: riskItems.length === 0 ? '未发现公开风险信息' : `${riskLevel}（${riskScore}分），发现${riskItems.length}类风险`,
  };
}

// ==================== 关联图谱 (P2) ====================

function buildRelationGraph(relatedCompanies, shareholders, keyPersonnel) {
  const nodes = [];
  const edges = [];

  shareholders.forEach(s => {
    if (s.name) { nodes.push({ id: s.name, type: '股东' }); edges.push({ source: s.name, relation: `持股${s.ratio || '未知'}`, target: 'self' }); }
  });
  keyPersonnel.forEach(p => {
    if (p.name) { nodes.push({ id: p.name, type: '人员' }); edges.push({ source: p.name, relation: p.position || '任职', target: 'self' }); }
  });
  (relatedCompanies || []).forEach(r => {
    if (r.name) { nodes.push({ id: r.name, type: '关联企业' }); edges.push({ source: 'self', relation: r.relation || '关联', target: r.name }); }
  });

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodes.slice(0, 20),
    edges: edges.slice(0, 20),
    summary: `关联${nodes.length}个节点，${edges.length}条关系`,
  };
}

// ==================== 报告格式化 ====================

function formatEnterpriseReport(data, shareholderAnalysis, riskProfile, relationGraph) {
  const lines = [];
  const basic = data.basic;

  lines.push(`${basic.name || '未知企业'} 企业信息报告`);
  lines.push('━'.repeat(50));

  lines.push(`\n【基本工商信息】`);
  lines.push(`  企业名称: ${basic.name || '-'}`);
  lines.push(`  法定代表人: ${basic.legalPerson || '-'}`);
  lines.push(`  经营状态: ${basic.status || '-'}`);
  lines.push(`  注册资本: ${basic.regCapital || '-'}`);
  lines.push(`  成立日期: ${basic.establishedDate || '-'}`);
  if (basic.unifiedCode) lines.push(`  统一社会信用代码: ${basic.unifiedCode}`);
  if (basic.regNumber) lines.push(`  工商注册号: ${basic.regNumber}`);
  if (basic.orgCode) lines.push(`  组织机构代码: ${basic.orgCode}`);
  if (basic.taxNumber) lines.push(`  纳税人识别号: ${basic.taxNumber}`);
  if (basic.companyType) lines.push(`  企业类型: ${basic.companyType}`);
  if (basic.industry) lines.push(`  所属行业: ${basic.industry}`);
  if (basic.authority) lines.push(`  登记机关: ${basic.authority}`);
  if (basic.operatingPeriod) lines.push(`  营业期限: ${basic.operatingPeriod}`);
  if (basic.regAddress) lines.push(`  注册地址: ${basic.regAddress}`);
  if (basic.businessScope) {
    const scope = basic.businessScope.length > 200 ? basic.businessScope.substring(0, 200) + '...' : basic.businessScope;
    lines.push(`  经营范围: ${scope}`);
  }
  lines.push(`  数据源: ${data._source || '未知'}`);

  if (data.shareholders?.length > 0) {
    lines.push(`\n【股东股权】`);
    data.shareholders.slice(0, 10).forEach(s => {
      lines.push(`  - ${s.name}${s.ratio ? ` | 持股: ${s.ratio}` : ''}${s.capital ? ` | 认缴: ${s.capital}` : ''}`);
    });
    if (data.shareholders.length > 10) lines.push(`  ... 共${data.shareholders.length}位股东`);
  }

  if (shareholderAnalysis) {
    lines.push(`\n【股权穿透分析】`);
    lines.push(`  控制类型: ${shareholderAnalysis.controlType}`);
    lines.push(`  ${shareholderAnalysis.summary}`);
    if (shareholderAnalysis.topShareholders?.length > 0) {
      lines.push(`  主要股东:`);
      shareholderAnalysis.topShareholders.forEach(s => lines.push(`    - ${s}`));
    }
  }

  if (data.keyPersonnel?.length > 0) {
    lines.push(`\n【主要人员】`);
    data.keyPersonnel.slice(0, 10).forEach(p => {
      lines.push(`  - ${p.name}${p.position ? ` | ${p.position}` : ''}`);
    });
  }

  if (riskProfile) {
    lines.push(`\n【风险画像】${riskProfile.summary}`);
    if (riskProfile.riskItems?.length > 0) {
      riskProfile.riskItems.forEach(item => {
        const icon = item.level === '高' ? '[高]' : item.level === '中' ? '[中]' : '[低]';
        lines.push(`  ${icon} ${item.type}${item.count ? ` (${item.count}条)` : ''}`);
      });
    } else {
      lines.push(`  [低] 未发现公开风险信息`);
    }
  }

  const ip = data.intellectualProperty;
  if (ip.trademarks?.length > 0 || ip.patents?.length > 0 || ip.copyrights?.length > 0) {
    lines.push(`\n【知识产权】`);
    if (ip.trademarks?.length > 0) lines.push(`  商标: ${ip.trademarks.length}件`);
    if (ip.patents?.length > 0) lines.push(`  专利: ${ip.patents.length}件`);
    if (ip.copyrights?.length > 0) lines.push(`  著作权: ${ip.copyrights.length}件`);
  }

  if (data.relatedCompanies?.length > 0) {
    lines.push(`\n【关联企业】`);
    data.relatedCompanies.slice(0, 10).forEach(r => {
      lines.push(`  - ${r.name}${r.relation ? ` | ${r.relation}` : ''}`);
    });
  }

  if (relationGraph) {
    lines.push(`\n【关联图谱】${relationGraph.summary}`);
  }

  if (data.historyChanges?.length > 0) {
    lines.push(`\n【历史变更】`);
    data.historyChanges.slice(0, 5).forEach(c => {
      lines.push(`  - ${c.item}: ${c.before || '-'} -> ${c.after || '-'}${c.date ? ` (${c.date})` : ''}`);
    });
    if (data.historyChanges.length > 5) lines.push(`  ... 共${data.historyChanges.length}条变更`);
  }

  lines.push('\n' + '━'.repeat(50));
  lines.push('以上信息来源于公开数据，仅供参考，不构成任何商业建议。');

  return lines.join('\n');
}

// ==================== 主处理函数 ====================

// 2026-08-14: 企业卡片发射——EnterpriseQuery 成功时把结构化摘要发射为
// scene surface 'enterprise-card'（kind 'enterprise'），前端 SceneShell
// kinds/enterprise.tsx 渲染（对齐 person_card/股票卡模式，此前企业查询
// 只出长文本报告、无卡片）。懒加载 scene-store 避免循环依赖；失败不阻塞主流程。
function _publishEnterpriseCard(enterpriseData, riskProfile, dataSource) {
  try {
    const { getSceneStore } = require('../core/scene/scene-store');
    const store = getSceneStore();
    if (!store) return;
    const basic = enterpriseData.basic || {};
    const riskItems = riskProfile && Array.isArray(riskProfile.riskItems) ? riskProfile.riskItems : [];
    store.upsertSurface('enterprise-card', {
      kind: 'enterprise',
      data: {
        basic: {
          name: basic.name || '',
          legalPerson: basic.legalPerson || '',
          status: basic.status || '',
          regCapital: basic.regCapital || '',
          establishedDate: basic.establishedDate || '',
          industry: basic.industry || '',
          regAddress: basic.regAddress || '',
        },
        shareholders: Array.isArray(enterpriseData.shareholders)
          ? enterpriseData.shareholders.slice(0, 8).map(s => ({ name: s.name || '', ratio: s.ratio || '' }))
          : [],
        risks: riskItems.map(r => ({ level: r.level || '', type: r.type || '', count: r.count })),
        riskScore: riskProfile && typeof riskProfile.riskScore === 'number' ? riskProfile.riskScore : null,
        source: dataSource || '',
        disclaimer: '信息仅供参考，不构成商业建议。',
      },
      intent: 'inform',
    });
  } catch (e) {
    console.error('[enterprise-tools] 企业卡片发射失败:', e.message || e);
  }
}

async function handleEnterpriseQuery(params) {
  const { query } = params;
  if (!query) return { success: false, error: '请提供企业名称或统一社会信用代码' };

  const startTime = Date.now();
  const evoBridge = getToolEvolutionBridge();
  const dsManager = getEnterpriseDataSourceManager();

  try {
    // 先查缓存
    const cached = dsManager.getCached(query);
    if (cached) {
      const shareholderAnalysis = analyzeShareholderStructure(cached.shareholders);
      const riskProfile = analyzeRiskProfile(cached.risks, cached.basic);
      const relationGraph = buildRelationGraph(cached.relatedCompanies, cached.shareholders, cached.keyPersonnel);
      const report = formatEnterpriseReport(cached, shareholderAnalysis, riskProfile, relationGraph);
      _publishEnterpriseCard(cached, riskProfile, '本地缓存');
      return { success: true, content: report + '\n\n[数据来源: 本地缓存]' };
    }

    let enterpriseData = null;
    let dataSource = '';
    let dataSourceKey = '';

    // 计算数据完整度（用于反馈循环）
    const calcCompleteness = function(data) {
      if (!data?.basic) return 0;
      const fields = ['name', 'legalPerson', 'regCapital', 'establishedDate', 'status',
        'unifiedCode', 'companyType', 'industry', 'regAddress', 'businessScope'];
      const filled = fields.filter(f => data.basic[f] && data.basic[f].length > 0).length;
      return filled / fields.length;
    };

    // 主源：天眼查
    let tianyanchaData = null;
    let tianyanchaAmbiguous = false; // 是否存在同名歧义
    try {
      const tycStart = Date.now();
      console.log(`[EnterpriseQuery] 天眼查搜索: ${query}`);
      const searchResults = await searchTianyancha(query);

      if (searchResults?.length > 0) {
        // 使用名称相似度评分选择最佳匹配
        const best = findBestMatch(query, searchResults, 0.6);

        if (best) {
          const searchData = {
            name: best.cleanName,
            legalPerson: best.legalPerson || '',
            regCapital: best.regCapital || '',
            establishedDate: best.establishedDate || '',
            status: best.status || '',
            unifiedCode: best.unifiedCode || '',
            regAddress: best.address || '',
            selfRisk: best.risks || '',
          };

          tianyanchaData = normalizeEnterpriseData({ detail: searchData }, '天眼查');
          console.log(`[EnterpriseQuery] 天眼查匹配: ${best.cleanName} (相似度: ${best.score?.toFixed(2)})`);

          // 检测同名歧义：多个结果名称相似度>=0.75
          const highScoreCount = searchResults.filter(r => {
            const cleanName = (r.name || '').replace(/[\n\r]/g, ' ').split(/\s+(?:关注|信用报告|简介|自身风险)/)[0].trim();
            return nameSimilarity(query, cleanName) >= 0.75;
          }).length;
          if (highScoreCount > 1) {
            tianyanchaAmbiguous = true;
            console.log(`[EnterpriseQuery] 天眼查存在 ${highScoreCount} 个同名/近似结果，需要交叉验证`);
          }
          // 单个匹配但相似度不高时，也标记需要验证（可能遗漏了更匹配的结果）
          if (highScoreCount === 1 && best.score < 0.9) {
            tianyanchaAmbiguous = true;
            console.log(`[EnterpriseQuery] 天眼查单结果匹配相似度较低(${best.score?.toFixed(2)})，需要交叉验证`);
          }
        } else {
          console.log(`[EnterpriseQuery] 天眼查搜索结果无匹配项（相似度均低于0.6），跳过`);
        }
      }
      dsManager.recordFeedback('tianyancha', true, Date.now() - tycStart, {
        completeness: tianyanchaData ? calcCompleteness(tianyanchaData) : 0,
      });
    } catch (e) {
      console.log(`[EnterpriseQuery] 天眼查失败: ${e.message}`);
      dsManager.recordFeedback('tianyancha', false, Date.now() - startTime, { completeness: 0 });
    }

    // 备源1：企查查（无结果或存在同名歧义时尝试）
    let qccData = null;
    if (!tianyanchaData || !tianyanchaData.basic.name || tianyanchaAmbiguous) {
      const qccStart = Date.now();
      try {
        console.log(`[EnterpriseQuery] 企查查搜索: ${query}`);
        const searchResults = await searchQichacha(query);

        if (searchResults?.length > 0) {
          // 使用名称相似度评分选择最佳匹配
          const best = findBestMatch(query, searchResults, 0.6);

          if (best) {
            const searchData = {
              name: best.cleanName || best.name,
              legalPerson: best.legalPerson || '',
              regCapital: best.regCapital || '',
              establishedDate: best.establishedDate || '',
              status: best.status || '',
              selfRisk: best.risks || '',
            };

            if (best.href) {
              try {
                console.log(`[EnterpriseQuery] 企查查详情: ${best.href}`);
                const detailData = await fetchQichachaDetail(best.href);
                if (Object.keys(detailData).length > 1) {
                  qccData = normalizeEnterpriseData({ detail: detailData, ...searchData }, '企查查');
                  if (!qccData.basic.name && best.name) qccData.basic.name = best.name;
                  if (!qccData.basic.legalPerson && best.legalPerson) qccData.basic.legalPerson = best.legalPerson;
                  if (!qccData.basic.regCapital && best.regCapital) qccData.basic.regCapital = best.regCapital;
                  if (!qccData.basic.establishedDate && best.establishedDate) qccData.basic.establishedDate = best.establishedDate;
                  if (!qccData.basic.status && best.status) qccData.basic.status = best.status;
                }
              } catch (e) {
                console.log(`[EnterpriseQuery] 企查查详情失败: ${e.message}`);
              }
            }

            if (!qccData) {
              qccData = normalizeEnterpriseData({ detail: searchData }, '企查查(搜索)');
            }
            console.log(`[EnterpriseQuery] 企查查匹配: ${best.cleanName || best.name} (相似度: ${best.score?.toFixed(2)})`);
          } else {
            console.log(`[EnterpriseQuery] 企查查搜索结果无匹配项（相似度均低于0.6），跳过`);
          }
        }
        dsManager.recordFeedback('qichacha', true, Date.now() - qccStart, {
          completeness: qccData ? calcCompleteness(qccData) : 0,
        });
      } catch (e) {
        console.log(`[EnterpriseQuery] 企查查失败: ${e.message}`);
        dsManager.recordFeedback('qichacha', false, Date.now() - qccStart, { completeness: 0 });
      }
    }

    // 备源1.5：爱企查（同名歧义时也尝试）
    let aqcData = null;
    if ((!tianyanchaData && !qccData) || (!tianyanchaData?.basic.name && !qccData?.basic.name) || tianyanchaAmbiguous) {
      const aqcStart = Date.now();
      try {
        console.log(`[EnterpriseQuery] 爱企查搜索: ${query}`);
        const aqcResults = await searchAiqicha(query);
        if (aqcResults?.length > 0) {
          // 使用名称相似度评分选择最佳匹配
          const best = findBestMatch(query, aqcResults, 0.6);

          if (best) {
            if (best.pid) {
              const detailData = await fetchAiqichaDetail(best.pid);
              aqcData = normalizeEnterpriseData(detailData, '爱企查');
              if (!aqcData.basic.name && best.name) aqcData.basic.name = best.name;
            } else {
              aqcData = normalizeEnterpriseData({ detail: { _companyName: best.cleanName || best.name } }, '爱企查(搜索)');
            }
            console.log(`[EnterpriseQuery] 爱企查匹配: ${best.cleanName || best.name} (相似度: ${best.score?.toFixed(2)})`);
          } else {
            console.log(`[EnterpriseQuery] 爱企查搜索结果无匹配项（相似度均低于0.6），跳过`);
          }
        }
        dsManager.recordFeedback('aiqicha', true, Date.now() - aqcStart, {
          completeness: aqcData ? calcCompleteness(aqcData) : 0,
        });
      } catch (e) {
        console.log(`[EnterpriseQuery] 爱企查失败: ${e.message}`);
        dsManager.recordFeedback('aiqicha', false, Date.now() - aqcStart, { completeness: 0 });
      }
    }

    // ==================== 多源交叉验证：选择最佳结果 ====================
    const candidates = [
      { data: tianyanchaData, source: '天眼查' },
      { data: qccData, source: '企查查' },
      { data: aqcData, source: '爱企查' },
    ].filter(c => c.data?.basic?.name);

    if (candidates.length > 0) {
      if (tianyanchaAmbiguous) {
        // 同名歧义时：用百度搜索确定正确法人，再交叉验证
        console.log(`[EnterpriseQuery] 同名歧义，使用百度搜索进行消歧...`);
        let bingDisambigData = null;
        try {
          bingDisambigData = await searchBaiduAggregation(query);
          if (bingDisambigData?.legalPerson) {
            console.log(`[EnterpriseQuery] 百度搜索消歧: 法人=${bingDisambigData.legalPerson}, 注册资本=${bingDisambigData.regCapital || '-'}, 成立=${bingDisambigData.establishedDate || '-'}`);
          } else {
            console.log(`[EnterpriseQuery] 百度搜索消歧: 未提取到法人信息，尝试Bing...`);
            bingDisambigData = await searchBingAggregation(query);
            if (bingDisambigData?.legalPerson) {
              console.log(`[EnterpriseQuery] Bing搜索消歧: 法人=${bingDisambigData.legalPerson}`);
            }
          }
        } catch (e) {
          console.log(`[EnterpriseQuery] 搜索消歧失败: ${e.message}`);
        }

        if (bingDisambigData?.legalPerson) {
          // 优先选择与百度搜索法人一致的结果
          const matchedCandidate = candidates.find(c => c.data.basic.legalPerson === bingDisambigData.legalPerson);
          if (matchedCandidate) {
            enterpriseData = matchedCandidate.data;
            dataSource = matchedCandidate.source;
            console.log(`[EnterpriseQuery] 消歧成功: ${dataSource} (法人: ${bingDisambigData.legalPerson})`);
          } else {
            // 百度搜索的法人不在已有候选中，用变体搜索天眼查
            console.log(`[EnterpriseQuery] 消歧: 各源均无法人"${bingDisambigData.legalPerson}"的结果，尝试变体搜索...`);
            const variants = generateNameVariants(query);
            let foundByVariant = false;
            for (const variant of variants.slice(1)) {
              try {
                const variantResults = await searchTianyancha(variant);
                if (variantResults?.length > 0) {
                  // 用百度搜索的法人来匹配天眼查变体搜索结果
                  const matchByLP = variantResults.find(r => {
                    const cleanName = (r.name || '').replace(/[\n\r]/g, ' ').split(/\s+(?:关注|信用报告|简介|自身风险)/)[0].trim();
                    return nameSimilarity(query, cleanName) >= 0.5 && r.legalPerson === bingDisambigData.legalPerson;
                  });
                  if (matchByLP) {
                    const searchData = {
                      name: (matchByLP.name || '').replace(/[\n\r]/g, ' ').split(/\s+(?:关注|信用报告|简介|自身风险)/)[0].trim(),
                      legalPerson: matchByLP.legalPerson || '',
                      regCapital: matchByLP.regCapital || '',
                      establishedDate: matchByLP.establishedDate || '',
                      status: matchByLP.status || '',
                      unifiedCode: matchByLP.unifiedCode || '',
                      regAddress: matchByLP.address || '',
                    };
                    enterpriseData = normalizeEnterpriseData({ detail: searchData }, '天眼查(变体+消歧)');
                    dataSource = `天眼查+百度(变体:${variant})`;
                    console.log(`[EnterpriseQuery] 变体消歧成功: ${searchData.name} (法人: ${bingDisambigData.legalPerson})`);
                    foundByVariant = true;
                    break;
                  }
                }
              } catch (e) {
                console.log(`[EnterpriseQuery] 变体天眼查搜索失败: ${e.message}`);
              }
            }

            if (!foundByVariant) {
              // 变体搜索也没找到，直接用百度搜索数据
              console.log(`[EnterpriseQuery] 变体搜索也未找到，使用百度搜索数据`);
              if (bingDisambigData.legalPerson || bingDisambigData.regCapital) {
                enterpriseData = normalizeEnterpriseData({
                  detail: {
                    _companyName: bingDisambigData.name || query,
                    '法定代表人': bingDisambigData.legalPerson,
                    '注册资本': bingDisambigData.regCapital,
                    '成立日期': bingDisambigData.establishedDate,
                    '经营状态': bingDisambigData.status,
                    '注册地址': bingDisambigData.address,
                    '经营范围': bingDisambigData.businessScope,
                  }
                }, '百度搜索(消歧)');
                dataSource = '百度搜索(消歧)';
              } else {
                candidates.sort((a, b) => calcCompleteness(b.data) - calcCompleteness(a.data));
                enterpriseData = candidates[0].data;
                dataSource = candidates[0].source;
              }
            }
          }
        } else if (candidates.length >= 2) {
          // Bing也没找到法人，用多源交叉验证
          console.log(`[EnterpriseQuery] 交叉验证: ${candidates.map(c => `${c.source}(法人:${c.data.basic.legalPerson || '-'})`).join(', ')}`);
          const legalPersons = candidates.map(c => c.data.basic.legalPerson).filter(lp => lp && lp !== '-');
          if (legalPersons.length >= 2) {
            const lpCounts = {};
            legalPersons.forEach(lp => { lpCounts[lp] = (lpCounts[lp] || 0) + 1; });
            const bestLP = Object.entries(lpCounts).sort((a, b) => b[1] - a[1])[0][0];
            const consistentCandidates = candidates.filter(c => c.data.basic.legalPerson === bestLP);
            consistentCandidates.sort((a, b) => calcCompleteness(b.data) - calcCompleteness(a.data));
            enterpriseData = consistentCandidates[0].data;
            dataSource = consistentCandidates[0].source;
          } else {
            candidates.sort((a, b) => calcCompleteness(b.data) - calcCompleteness(a.data));
            enterpriseData = candidates[0].data;
            dataSource = candidates[0].source;
          }
        } else {
          candidates.sort((a, b) => calcCompleteness(b.data) - calcCompleteness(a.data));
          enterpriseData = candidates[0].data;
          dataSource = candidates[0].source;
        }
      } else {
        // 无歧义：选数据最完整的
        candidates.sort((a, b) => calcCompleteness(b.data) - calcCompleteness(a.data));
        enterpriseData = candidates[0].data;
        dataSource = candidates[0].source;
      }
    }

    // 备源2：水滴信用
    if (!enterpriseData || !enterpriseData.basic.name) {
      const sdStart = Date.now();
      try {
        console.log(`[EnterpriseQuery] 水滴信用搜索: ${query}`);
        const shuidiResults = await searchShuidi(query);
        if (shuidiResults?.length > 0) {
          const best = findBestMatch(query, shuidiResults, 0.6);
          if (best && best.cleanName && best.cleanName.length >= 2) {
            enterpriseData = normalizeEnterpriseData({ detail: { _companyName: best.cleanName } }, '水滴信用(搜索)');
            dataSource = '水滴信用(搜索)';
            console.log(`[EnterpriseQuery] 水滴信用匹配: ${best.cleanName} (相似度: ${best.score?.toFixed(2)})`);
          } else {
            console.log(`[EnterpriseQuery] 水滴信用搜索结果无匹配项，跳过`);
          }
        }
        dsManager.recordFeedback('shuidi', true, Date.now() - sdStart, {
          completeness: enterpriseData ? calcCompleteness(enterpriseData) : 0,
        });
        dataSourceKey = 'shuidi';
      } catch (e) {
        console.log(`[EnterpriseQuery] 水滴信用失败: ${e.message}`);
        dsManager.recordFeedback('shuidi', false, Date.now() - sdStart, { completeness: 0 });
      }
    }

    // 备源3：百度搜索聚合（兜底）
    if (!enterpriseData || !enterpriseData.basic.name) {
      const bdStart = Date.now();
      try {
        console.log(`[EnterpriseQuery] 百度搜索聚合: ${query}`);
        const baiduData = await searchBaiduAggregation(query);
        if (baiduData && (baiduData.legalPerson || baiduData.regCapital)) {
          enterpriseData = normalizeEnterpriseData({
            detail: {
              _companyName: baiduData.name,
              '法定代表人': baiduData.legalPerson,
              '注册资本': baiduData.regCapital,
              '成立日期': baiduData.establishedDate,
              '经营状态': baiduData.status,
            }
          }, '百度搜索');
          dataSource = '百度搜索';
        }
        dsManager.recordFeedback('baidu', true, Date.now() - bdStart, {
          completeness: enterpriseData ? calcCompleteness(enterpriseData) : 0,
        });
        // eslint-disable-next-line no-unused-vars -- dataSourceKey 仅被赋值从未读取（写穿变量，保留赋值避免未声明引用）
        dataSourceKey = 'baidu';
      } catch (e) {
        console.log(`[EnterpriseQuery] 百度搜索失败: ${e.message}`);
        dsManager.recordFeedback('baidu', false, Date.now() - bdStart, { completeness: 0 });
      }
    }

    // 备源4：Bing搜索聚合（最终兜底）
    if (!enterpriseData || !enterpriseData.basic.name) {
      // eslint-disable-next-line no-unused-vars -- bingStart 未消费（Date.now() 调用保留计时语义）
      const bingStart = Date.now();
      try {
        console.log(`[EnterpriseQuery] Bing搜索聚合: ${query}`);
        const bingData = await searchBingAggregation(query);
        if (bingData && (bingData.legalPerson || bingData.regCapital)) {
          enterpriseData = normalizeEnterpriseData({
            detail: {
              _companyName: bingData.name,
              '法定代表人': bingData.legalPerson,
              '注册资本': bingData.regCapital,
              '成立日期': bingData.establishedDate,
              '经营状态': bingData.status,
              '注册地址': bingData.address,
              '经营范围': bingData.businessScope,
            }
          }, 'Bing搜索');
          dataSource = 'Bing搜索';
        }
      } catch (e) {
        console.log(`[EnterpriseQuery] Bing搜索失败: ${e.message}`);
      }
    }

    // 所有源都失败 → 尝试名称变体重试
    if (!enterpriseData || !enterpriseData.basic.name) {
      const variants = generateNameVariants(query);
      console.log(`[EnterpriseQuery] 精确搜索无结果，生成名称变体: ${variants.slice(1).join(', ')}`);

      for (const variant of variants.slice(1)) { // 跳过第一个（原始名称已搜过）
        if (enterpriseData?.basic?.name) break;
        console.log(`[EnterpriseQuery] 尝试变体: ${variant}`);

        // 用百度搜索变体（优先，因为可以消歧）
        try {
          const baiduData = await searchBaiduAggregation(variant);
          if (baiduData && (baiduData.legalPerson || baiduData.regCapital)) {
            // 用百度搜索结果作为消歧依据
            console.log(`[EnterpriseQuery] 变体百度搜索: 法人=${baiduData.legalPerson || '-'}, 注册资本=${baiduData.regCapital || '-'}`);

            // 再用天眼查搜索变体获取详细信息
            try {
              const variantResults = await searchTianyancha(variant);
              if (variantResults?.length > 0) {
                // 如果有多个同名结果，用百度搜索的法人来消歧
                if (baiduData.legalPerson) {
                  const matchByLP = variantResults.find(r => {
                    const cleanName = (r.name || '').replace(/[\n\r]/g, ' ').split(/\s+(?:关注|信用报告|简介|自身风险)/)[0].trim();
                    return nameSimilarity(query, cleanName) >= 0.5 && r.legalPerson === baiduData.legalPerson;
                  });
                  if (matchByLP) {
                    const searchData = {
                      name: (matchByLP.name || '').replace(/[\n\r]/g, ' ').split(/\s+(?:关注|信用报告|简介|自身风险)/)[0].trim(),
                      legalPerson: matchByLP.legalPerson || '',
                      regCapital: matchByLP.regCapital || '',
                      establishedDate: matchByLP.establishedDate || '',
                      status: matchByLP.status || '',
                      unifiedCode: matchByLP.unifiedCode || '',
                      regAddress: matchByLP.address || '',
                    };
                    enterpriseData = normalizeEnterpriseData({ detail: searchData }, '天眼查(变体+消歧)');
                    dataSource = `天眼查+百度(变体:${variant})`;
                    console.log(`[EnterpriseQuery] 变体消歧成功: ${searchData.name} (法人: ${baiduData.legalPerson})`);
                    break;
                  }
                }
                // 没有法人匹配，用相似度选最佳
                const best = findBestMatch(query, variantResults, 0.5);
                if (best) {
                  const searchData = {
                    name: best.cleanName,
                    legalPerson: best.legalPerson || '',
                    regCapital: best.regCapital || '',
                    establishedDate: best.establishedDate || '',
                    status: best.status || '',
                    unifiedCode: best.unifiedCode || '',
                    regAddress: best.address || '',
                  };
                  enterpriseData = normalizeEnterpriseData({ detail: searchData }, '天眼查(变体)');
                  dataSource = `天眼查(变体:${variant})`;
                  console.log(`[EnterpriseQuery] 变体匹配成功: ${best.cleanName} (相似度: ${best.score?.toFixed(2)})`);
                  break;
                }
              }
            } catch (e) {
              console.log(`[EnterpriseQuery] 变体天眼查搜索失败: ${e.message}`);
            }

            // 天眼查也没找到匹配的，用百度搜索数据但需验证名称相关性
            // 验证：百度搜索结果的公司名必须与原始查询有足够相似度
            const baiduName = baiduData.name || variant;
            const nameSim = nameSimilarity(query, baiduName);
            // 必须满足：名称相似度>=0.6，且变体不能太短（避免"链客科技"匹配到不相关公司）
            const variantTooShort = variant.replace(/[（()）有限公司]/g, '').length < 4;
            if (nameSim >= 0.6 && !variantTooShort) {
              enterpriseData = normalizeEnterpriseData({
                detail: {
                  _companyName: query, // 使用原始查询名称，而非变体名称
                  '法定代表人': baiduData.legalPerson,
                  '注册资本': baiduData.regCapital,
                  '成立日期': baiduData.establishedDate,
                  '经营状态': baiduData.status,
                  '注册地址': baiduData.address,
                  '经营范围': baiduData.businessScope,
                }
              }, '百度搜索(变体)');
              dataSource = `百度搜索(变体:${variant})`;
              console.log(`[EnterpriseQuery] 变体百度匹配成功: 法人=${baiduData.legalPerson}`);
              break;
            } else {
              console.log(`[EnterpriseQuery] 变体百度搜索结果名称不匹配(相似度:${nameSim?.toFixed(2)})，跳过`);
            }
          }
        } catch (e) {
          console.log(`[EnterpriseQuery] 变体百度搜索失败: ${e.message}`);
        }
      }
    }

    // 所有源和变体都失败
    if (!enterpriseData || !enterpriseData.basic.name) {
      evoBridge.recordToolExecution('EnterpriseQuery', {
        success: false, durationMs: Date.now() - startTime, error: '所有数据源均未获取到企业信息',
      });

      return {
        success: true,
        content: `未找到"${query}"的企业信息。\n\n建议：\n1. 检查企业名称是否完整准确\n2. 尝试使用统一社会信用代码查询\n3. 访问企查查(m.qcc.com)手动查询`,
      };
    }

    // 分析
    const shareholderAnalysis = analyzeShareholderStructure(enterpriseData.shareholders);
    const riskProfile = analyzeRiskProfile(enterpriseData.risks, enterpriseData.basic);
    const relationGraph = buildRelationGraph(enterpriseData.relatedCompanies, enterpriseData.shareholders, enterpriseData.keyPersonnel);

    // 格式化报告
    const report = formatEnterpriseReport(enterpriseData, shareholderAnalysis, riskProfile, relationGraph);

    // 缓存
    dsManager.cacheData(query, enterpriseData);

    // 记录成功
    evoBridge.recordToolExecution('EnterpriseQuery', {
      success: true, durationMs: Date.now() - startTime, metadata: { dataSource },
    });

    try { getStockSkillEvolution().recordUserBehavior(query, '企业查询', null); } catch (e) { console.warn('[enterprise-tools] failed to record user behavior:', e.message); }

    _publishEnterpriseCard(enterpriseData, riskProfile, dataSource);

    return {
      success: true,
      content: report + `\n\n[数据来源: ${dataSource} | 信息仅供参考，不构成商业建议]`,
    };
  } catch (e) {
    console.log(`[EnterpriseQuery] 失败: ${e.message}`);
    evoBridge.recordToolExecution('EnterpriseQuery', {
      success: false, durationMs: Date.now() - startTime, error: e.message,
    });
    return { success: false, error: `企业查询失败: ${e.message}` };
  }
}

// ==================== 工具注册 ====================

registry.register({
  name: 'EnterpriseQuery',
  description: '查询企业工商/司法/经营/关联信息。当用户提到公司名称、统一社会信用代码、查企业、公司背景、企业信息、法人信息时调用此工具。支持：基本工商信息、股东股权、主要人员、风险画像、知识产权、关联企业、历史变更。数据来源：企查查/爱企查/水滴信用等免费公开数据。',
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '企业名称、统一社会信用代码或法人姓名。如"华为技术有限公司"、"91110000101666588J"'
      },
      dimensions: {
        type: 'array',
        description: '查询维度，可选: basic, shareholders, personnel, risks, ip, business, related, history。默认查询全部维度。',
        items: { type: 'string' }
      }
    },
    required: ['query']
  },
  handler: handleEnterpriseQuery
});

console.log('✅ 企业查询工具已注册 (企查查/爱企查/水滴信用, 免费无API Key)');

module.exports = {
  handleEnterpriseQuery,
  searchQichacha,
  fetchQichachaDetail,
  searchAiqicha,
  fetchAiqichaDetail,
  searchShuidi,
  normalizeEnterpriseData,
  analyzeShareholderStructure,
  analyzeRiskProfile,
  buildRelationGraph,
  formatEnterpriseReport,
};
