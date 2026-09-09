/**
 * 股票工具 - 基础工具函数
 *
 * 提取自 stock-tools.js，包含无外部依赖的纯工具函数
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const FLASHCLAW_DIR = path.resolve(__dirname, '../../../data/skills/flashclaw-stock/scripts');
const FLASHCLAW_SCRIPT = path.join(FLASHCLAW_DIR, 'flashclaw_stock.py');
const PYTHON_TIMEOUT = 30000;

const POPULAR_STOCKS = {
  '贵州茅台': '600519', '五粮液': '000858', '泸州老窖': '000568',
  '山西汾酒': '600809', '中国平安': '601318', '招商银行': '600036',
  '中信证券': '600030', '宁德时代': '300750', '比亚迪': '002594',
  '隆基绿能': '601012', '药明康德': '603259', '恒瑞医药': '600276',
  '迈瑞医疗': '300760', '海康威视': '002415', '中芯国际': '688981',
  '科大讯飞': '002230', '京东方A': '000725', '立讯精密': '002475',
  '大华股份': '002236', '大华': '002236',
  '腾讯控股': '00700', '阿里巴巴': '09988', '美团': '03690',
  '小米集团': '01810', '京东集团': '09618', '百度集团': '09888',
};

function extractStockName(text) {
  let name = text.trim();
  for (const stockName of Object.keys(POPULAR_STOCKS)) {
    if (name.includes(stockName)) return stockName;
  }
  const suffixes = [
    '实时行情', '最新行情', '实时价格', '最新价格', '实时报价',
    '行情', '报价', '价格', '股价', '多少钱',
    '买入时机', '买入点', '买点', '买入信号', '买入建议',
    '卖出时机', '卖出点', '卖点', '卖出信号', '卖出建议',
    '分析', '基本面', '趋势', '走势', '怎么样', '如何',
    '现在', '当前', '最新', '实时', '今天',
  ];
  for (const s of suffixes.sort((a, b) => b.length - a.length)) {
    if (name.endsWith(s)) name = name.slice(0, -s.length).trim();
    if (name.includes(s) && s.length >= 2) name = name.replace(s, '').trim();
  }
  name = name.replace(/[的了吗呢吧啊呀]/g, '').trim();
  return name || text.trim();
}

function runFlashclaw(text) {
  return new Promise((resolve, reject) => {
    // 验证脚本存在且路径安全
    if (!fs.existsSync(FLASHCLAW_SCRIPT)) {
      reject(new Error(`FlashClaw 脚本不存在: ${FLASHCLAW_SCRIPT}`));
      return;
    }
    const resolved = path.resolve(FLASHCLAW_SCRIPT);
    if (!resolved.startsWith(FLASHCLAW_DIR)) {
      reject(new Error('FlashClaw 脚本路径不安全'));
      return;
    }

    const args = [FLASHCLAW_SCRIPT, 'run', '--text', text, '--verbose'];
    execFile('python', args, {
      cwd: FLASHCLAW_DIR,
      timeout: PYTHON_TIMEOUT,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// 2026-08-21: 腾讯 smartbox 响应解析（纯函数，供单测）。
// 响应形如 v_hint="sh~688836~宇树科技W~yskjw~GP-A-KCB;sz~300674~..."，条目分号分隔，
// 字段 market~code~name~pinyin~type。取首个含 5-6 位代码的条目。
// @param {string} raw - 原始响应文本
// @returns {{code: string, market: string}|null}
function _parseTencentResult(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/"([^"]*)"/);
  const body = (m ? m[1] : raw).replace(/^v_hint\s*=\s*/, '');
  for (const entry of body.split(';')) {
    const parts = entry.split('~');
    if (parts.length >= 3) {
      const marketRaw = parts[0].trim();
      const code = String(parts[1] || '').trim();
      if (/^\d{5,6}$/.test(code) && /^(sh|sz|hk|bj)/i.test(marketRaw)) {
        return { code, market: marketRaw.toUpperCase() };
      }
    }
  }
  return null;
}

// 2026-08-21: 新浪 suggest 响应解析（纯函数，供单测）。GBK 编码下中文名称会乱码，
// 但代码/市场字段为 ASCII 数字字母，可直接正则提取。
// 响应形如 var suggestvalue="宇树科技,11,688836,sh688836,...;宇信科技,11,300674,sz300674,..."
// @param {string} raw - 原始响应文本（GBK/latin1 均可，只需 ASCII 字段）
// @returns {{code: string, market: string}|null}
function _parseSinaResult(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/"([^"]*)"/);
  const body = m ? m[1] : raw;
  for (const entry of body.split(';')) {
    const parts = entry.split(',');
    if (parts.length >= 4) {
      const code = String(parts[2] || '').trim();
      const marketRaw = String(parts[3] || '').trim();
      if (/^\d{5,6}$/.test(code) && /^(sh|sz|hk|bj)/i.test(marketRaw)) {
        return { code, market: marketRaw.slice(0, 2).toUpperCase() };
      }
    }
  }
  return null;
}

function _httpGetText(url, timeout = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.setEncoding('latin1'); // 新浪 GBK 源：latin1 保字节序，解析函数只取 ASCII 字段
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { try { req.destroy(); } catch { /* 已超时销毁 */ } resolve(null); });
  });
}

/**
 * 按名称搜索股票代码（2026-08-21: 三源降级链）。
 * 根因：688836 宇树科技等新股上市 3 天内东财 suggest 未收录 → 返回 null →
 * 搜索兜底只回字典页文本 → 卡片空态。腾讯/新浪 suggest 收录更及时（实测双中）。
 * 链序：东财(原有) → 腾讯 smartbox → 新浪 suggest；每源失败/null 自动降级下一源。
 * 全部失败 resolve(null)（调用方已有 null 兜底，不 reject 避免把"未收录"当异常）。
 */
async function searchStockByName(name) {
  // 源1: 东财 suggest（原有主源，收录全、结构化）
  try {
    const body = await _httpGetText(
      `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(name)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=5`
    );
    if (body) {
      const json = JSON.parse(body);
      if (json.QuotationCodeTable && json.QuotationCodeTable.Security) {
        const stocks = json.QuotationCodeTable.Security.filter(s =>
          s.Classify === 'AStock' || s.Classify === 'HKStock'
        );
        if (stocks.length > 0) {
          const first = stocks[0];
          return {
            code: first.Code,
            name: first.Name,
            market: first.MktNum === '1' ? 'SH' : first.MktNum === '0' ? 'SZ' : 'HK',
          };
        }
      }
    }
  } catch (e) {
    console.warn('[stock-utils] 东财 suggest 失败(降级):', e.message || e);
  }

  // 源2: 腾讯 smartbox（新股收录快，实测 688836 命中）
  try {
    const body = await _httpGetText(
      `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(name)}&t=all`
    );
    const hit = _parseTencentResult(body);
    if (hit) return { code: hit.code, name, market: hit.market };
  } catch (e) {
    console.warn('[stock-utils] 腾讯 suggest 失败(降级):', e.message || e);
  }

  // 源3: 新浪 suggest（与腾讯互为冗余）
  try {
    const body = await _httpGetText(
      `https://suggest3.sinajs.cn/suggest/type=11,12,13,14,15&key=${encodeURIComponent(name)}`
    );
    const hit = _parseSinaResult(body);
    if (hit) return { code: hit.code, name, market: hit.market };
  } catch (e) {
    console.warn('[stock-utils] 新浪 suggest 失败(降级):', e.message || e);
  }

  return null;
}

function fmtNum(n) {
  if (!n || n === '-') return 'N/A';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toString();
}

function fetchJson(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

async function fetchKLineData(code, days = 60) {
  let prefix = '1';
  if (code.startsWith('0') || code.startsWith('3')) prefix = '0';
  else if (code.startsWith('6')) prefix = '1';
  else if (code.length === 5) prefix = '1';

  const sinaUrl = `http://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${prefix == '0' ? 'sz' : 'sh'}${code}&scale=240&ma=no&datalen=${days}`;
  
  try {
    const json = await fetchJson(sinaUrl, 10000);
    if (Array.isArray(json) && json.length > 0) {
      return json.map(item => ({
        date: item.day,
        open: parseFloat(item.open),
        close: parseFloat(item.close),
        high: parseFloat(item.high),
        low: parseFloat(item.low),
        volume: parseFloat(item.volume),
        amount: 0
      }));
    }
  } catch (e) {
    console.log(`📈 新浪K线获取失败: ${e.message}`);
  }
  return null;
}

function getMarketPrefix(code) {
  if (code.startsWith('0') || code.startsWith('3')) return '0';
  if (code.startsWith('6')) return '1';
  if (code.length === 5) return '1';
  return '1';
}

module.exports = {
  POPULAR_STOCKS,
  FLASHCLAW_DIR,
  FLASHCLAW_SCRIPT,
  extractStockName,
  runFlashclaw,
  searchStockByName,
  fmtNum,
  fetchJson,
  fetchKLineData,
  getMarketPrefix,
  // 2026-08-21: 腾讯/新浪 suggest 解析纯函数——导出供单测（网络链路免测）
  _parseTencentResult,
  _parseSinaResult,
};
