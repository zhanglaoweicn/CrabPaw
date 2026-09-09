/**
 * 股票工具 - 基本面与市场环境分析
 *
 * 提取自 stock-tools.js，包含基本面、市场环境、综合评分、数据获取函数
 */

const { fetchJson, getMarketPrefix, fmtNum } = require('./stock-utils');
const _http = require('http');
// eslint-disable-next-line no-unused-vars -- stock-technical 的动量/风险分析由 calculateOverallScore 的入参注入，暂不在此直接调用
const { analyzeMomentum, detectRisks } = require('./stock-technical');

let _getStockDataSourceManager = null;

/**
 * 注入数据源管理器获取函数（避免循环依赖）
 */
function injectDataSourceManager(getFn) {
  _getStockDataSourceManager = getFn;
}

function analyzeFundamentals(quoteData) {
  if (!quoteData) return null;
  
  let score = 0;
  const metrics = [];
  
  if (quoteData.pe && quoteData.pe !== 'N/A') {
    const pe = parseFloat(quoteData.pe);
    if (pe < 15) {
      score += 0.3;
      metrics.push({ name: 'PE估值', value: pe.toFixed(2), status: '低估', score: 0.3 });
    } else if (pe < 25) {
      score += 0.1;
      metrics.push({ name: 'PE估值', value: pe.toFixed(2), status: '合理', score: 0.1 });
    } else if (pe > 40) {
      score -= 0.2;
      metrics.push({ name: 'PE估值', value: pe.toFixed(2), status: '高估', score: -0.2 });
    } else {
      metrics.push({ name: 'PE估值', value: pe.toFixed(2), status: '偏高', score: 0 });
    }
  }
  
  if (quoteData.pb && quoteData.pb !== 'N/A') {
    const pb = parseFloat(quoteData.pb);
    if (pb < 1) {
      score += 0.2;
      metrics.push({ name: 'PB估值', value: pb.toFixed(2), status: '破净', score: 0.2 });
    } else if (pb < 2) {
      score += 0.1;
      metrics.push({ name: 'PB估值', value: pb.toFixed(2), status: '合理', score: 0.1 });
    } else if (pb > 4) {
      score -= 0.1;
      metrics.push({ name: 'PB估值', value: pb.toFixed(2), status: '偏高', score: -0.1 });
    }
  }
  
  if (quoteData.roe && quoteData.roe !== 'N/A') {
    const roe = parseFloat(quoteData.roe);
    if (roe > 15) {
      score += 0.3;
      metrics.push({ name: 'ROE', value: roe.toFixed(2) + '%', status: '优秀', score: 0.3 });
    } else if (roe > 10) {
      score += 0.1;
      metrics.push({ name: 'ROE', value: roe.toFixed(2) + '%', status: '良好', score: 0.1 });
    } else if (roe < 5) {
      score -= 0.1;
      metrics.push({ name: 'ROE', value: roe.toFixed(2) + '%', status: '偏低', score: -0.1 });
    }
  }
  
  if (quoteData.grossMargin && quoteData.grossMargin !== 'N/A') {
    const gm = parseFloat(quoteData.grossMargin);
    if (gm > 30) {
      score += 0.2;
      metrics.push({ name: '毛利率', value: gm.toFixed(2) + '%', status: '优秀', score: 0.2 });
    } else if (gm > 20) {
      score += 0.1;
      metrics.push({ name: '毛利率', value: gm.toFixed(2) + '%', status: '良好', score: 0.1 });
    }
  }
  
  return {
    score: Math.max(-1, Math.min(1, score)),
    metrics
  };
}

function analyzeMarketContext(marketIndex) {
  if (!marketIndex) return null;
  
  let score = 0;
  let regime = '震荡';
  const indices = [];
  
  const sh = marketIndex['000001'];
  const hs300 = marketIndex['000300'];
  
  if (sh) {
    const changePct = sh.changePct;
    indices.push({ name: sh.name, price: sh.price, change: changePct + '%' });
    
    if (changePct > 1) {
      score += 0.2;
      regime = '强势';
    } else if (changePct > 0.5) {
      score += 0.1;
      regime = '偏强';
    } else if (changePct < -1) {
      score -= 0.2;
      regime = '弱势';
    } else if (changePct < -0.5) {
      score -= 0.1;
      regime = '偏弱';
    }
  }
  
  if (hs300) {
    indices.push({ name: hs300.name, price: hs300.price, change: hs300.changePct + '%' });
    const changePct = hs300.changePct;
    if (changePct > 1) score += 0.1;
    else if (changePct < -1) score -= 0.1;
  }
  
  return {
    score: Math.max(-1, Math.min(1, score)),
    regime,
    indices
  };
}

function calculateOverallScore(quoteData, momentum, northFlow, marginData, fundamentals, marketContext) {
  let score = 0;
  const components = [];
  
  if (fundamentals) {
    score += fundamentals.score * 0.25;
    components.push({ name: '基本面分析', score: fundamentals.score.toFixed(2), weight: '25%' });
  }
  
  if (momentum) {
    const mScore = parseFloat(momentum.momentumScore);
    score += mScore * 0.30;
    components.push({ name: '动量分析', score: mScore.toFixed(2), weight: '30%' });
  }
  
  if (marketContext) {
    score += marketContext.score * 0.15;
    components.push({ name: '市场环境', score: marketContext.score.toFixed(2), weight: '15%', note: marketContext.regime });
  }
  
  if (northFlow) {
    if (northFlow.trend === '流入') {
      score += 0.15;
      components.push({ name: '北向资金', score: '0.15', weight: '15%', note: '资金流入' });
    } else {
      score -= 0.1;
      components.push({ name: '北向资金', score: '-0.10', weight: '10%', note: '资金流出' });
    }
  }
  
  if (marginData) {
    const rzche = marginData.rzche || 0;
    if (rzche > 0) {
      score += 0.1;
      components.push({ name: '融资余额', score: '0.10', weight: '10%', note: '融资增加' });
    }
  }
  
  if (quoteData) {
    const changePct = parseFloat(quoteData.changePct);
    if (changePct < -5) {
      score += 0.15;
      components.push({ name: '价格回调', score: '0.15', weight: '15%', note: '大幅回调可能存在机会' });
    } else if (changePct > 5) {
      score -= 0.1;
      components.push({ name: '价格涨幅', score: '-0.10', weight: '10%', note: '短期涨幅较大' });
    }
  }
  
  score = Math.max(-1, Math.min(1, score));
  
  let recommendation = 'HOLD';
  if (score > 0.3) recommendation = 'BUY';
  else if (score < -0.3) recommendation = 'SELL';
  
  return {
    finalScore: score.toFixed(2),
    recommendation,
    confidence: Math.abs(score).toFixed(2),
    components
  };
}

async function fetchNorthFlow(_code) {
  try {
    const url = 'http://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=1.000001&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63';
    const json = await fetchJson(url, 8000);
    if (json.data && json.data.klines) {
      const recent = json.data.klines.slice(-5);
      const totalIn = recent.reduce((sum, line) => {
        const parts = line.split(',');
        return sum + parseFloat(parts[1] || 0);
      }, 0);
      const totalOut = recent.reduce((sum, line) => {
        const parts = line.split(',');
        return sum + parseFloat(parts[2] || 0);
      }, 0);
      return {
        netFlow: totalIn - totalOut,
        trend: totalIn > totalOut ? '流入' : '流出'
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchMarginData(code) {
  try {
    const url = `http://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_RZRQ_DETIAL&columns=ALL&filter=(SECURITY_CODE="${code}")&pageSize=1&sortColumns=TRADE_DATE&sortTypes=-1`;
    const json = await fetchJson(url, 8000);
    if (json.result && json.result.data && json.result.data.length > 0) {
      const d = json.result.data[0];
      return {
        rzye: d.RZYE || d.RZYE2,
        rqye: d.RQYE || d.RQYE2,
        rzche: d.RZCHE || d.RZMRE,
        rqchl: d.RQCHL || d.RQMCL
      };
    }
    const url2 = `http://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_RZRQ_LSHJ&columns=ALL&filter=(SECURITY_CODE="${code}")&pageSize=1&sortColumns=TRADE_DATE&sortTypes=-1`;
    const json2 = await fetchJson(url2, 8000);
    if (json2.result && json2.result.data && json2.result.data.length > 0) {
      const d = json2.result.data[0];
      return {
        rzye: d.RZYE,
        rqye: d.RQYE,
        rzche: d.RZCHE,
        rqchl: d.RQCHL
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchMarketIndex() {
  try {
    const url = 'http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,1.000300&fields=f2,f3,f4,f12,f14';
    const json = await fetchJson(url, 8000);
    if (json.data && json.data.diff) {
      const indices = {};
      json.data.diff.forEach(item => {
        indices[item.f12] = {
          name: item.f14,
          price: item.f2,
          changePct: item.f3
        };
      });
      return indices;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchIndustryPeers(code) {
  const prefix = getMarketPrefix(code);
  try {
    const quoteUrl = `http://push2.eastmoney.com/api/qt/stock/get?secid=${prefix}.${code}&fields=f127&ut=fa5fd1943c7b386f172d6893dbbd1d0c`;
    const quoteJson = await fetchJson(quoteUrl, 8000);
    const industry = quoteJson?.data?.f127;
    if (!industry) return null;

    const rankUrl = `http://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${prefix}${code}f&fields=f2,f3,f12,f14,f127,f162,f167`;
    const rankJson = await fetchJson(rankUrl, 8000);
    if (!rankJson?.data?.diff) return null;

    const peers = rankJson.data.diff
      .filter(item => item.f12 !== code)
      .slice(0, 5)
      .map(item => ({
        name: item.f14,
        code: item.f12,
        price: item.f2,
        changePct: item.f3,
        pe: item.f162 || 'N/A',
        pb: item.f167 || 'N/A',
      }));

    return { industry, peers };
  } catch (e) {
    return null;
  }
}

async function fetchFundFlowTrend(code) {
  const prefix = getMarketPrefix(code);
  try {
    const url = `http://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=${prefix}.${code}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65`;
    const json = await fetchJson(url, 8000);
    if (!json?.data?.klines) return null;

    const klines = json.data.klines;
    const recent = klines.slice(-10);
    if (recent.length === 0) return null;

    const trendData = recent.map(line => {
      const parts = line.split(',');
      return {
        date: parts[0],
        mainNetInflow: parseFloat(parts[1] || 0),
        smallNetInflow: parseFloat(parts[5] || 0),
      };
    });

    const mainInflows = trendData.map(d => d.mainNetInflow);
    const totalMainInflow = mainInflows.reduce((a, b) => a + b, 0);
    const recent3Days = mainInflows.slice(-3);
    const recent3Total = recent3Days.reduce((a, b) => a + b, 0);
    
    let trend = '平衡';
    if (recent3Total > 0 && totalMainInflow > 0) trend = '持续流入';
    else if (recent3Total > 0 && totalMainInflow < 0) trend = '由出转入';
    else if (recent3Total < 0 && totalMainInflow > 0) trend = '由入转出';
    else if (recent3Total < 0 && totalMainInflow < 0) trend = '持续流出';

    return { trendData, totalMainInflow, recent3Total, trend };
  } catch (e) {
    return null;
  }
}

async function fetchEastMoneyQuote(code) {
  // 尝试通过数据源管理器获取（支持多接口冗余）
  try {
    const getDSManager = _getStockDataSourceManager;
    if (getDSManager) {
      const dsManager = getDSManager();
      const result = await dsManager.fetchWithRedundancy(code, ['quote']);
      if (result.data) {
        const d = result.data;
        return {
          name: d.name || '',
          code: d.code || code,
          price: d.price || 0,
          open: d.open || 0,
          high: d.high || 0,
          low: d.low || 0,
          prevClose: d.prevClose || (d.price - (d.change || 0)),
          change: d.change || 0,
          changePct: d.changePct || '0.00',
          volume: d.volume || 0,
          amount: d.amount || 0,
          pe: d.pe_ttm || d.pe || 'N/A',
          pb: d.pb || 'N/A',
          totalMv: d.totalMv || 0,
          circMv: d.circMv || 0,
          industry: d.industry || 'N/A',
          region: d.region || 'N/A',
          roe: d.roe || 'N/A',
          grossMargin: d.grossMargin || 'N/A',
          netMargin: d.netMargin || 'N/A',
          _dataSource: result.sourceName || result.source,
          _degraded: result.degraded || false,
        };
      }
    }
  } catch (e) {
    console.log(`📈 数据源管理器获取失败，回退到原始方式: ${e.message}`);
  }

  // 原始东方财富获取方式（兜底）
  const prefix = getMarketPrefix(code);
  const url = `http://push2.eastmoney.com/api/qt/stock/get?secid=${prefix}.${code}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f127,f128,f140,f141,f162,f167,f168,f169,f170,f171,f184,f185,f186,f292&ut=fa5fd1943c7b386f172d6893dbbd1d0c`;
  
  const json = await fetchJson(url, 10000);
  
  if (json.data && json.data.f43) {
    const d = json.data;
    const price = d.f43 / 100;
    const open = d.f46 / 100;
    const high = d.f44 / 100;
    const low = d.f45 / 100;
    const prevClose = d.f60 / 100;
    const change = price - prevClose;
    const changePct = prevClose > 0 ? ((change / prevClose) * 100).toFixed(2) : '0.00';
    const volume = d.f47;
    const amount = d.f48;
    const pe = d.f162 ? (d.f162 / 100).toFixed(2) : 'N/A';
    const pb = d.f167 ? (d.f167 / 100).toFixed(2) : 'N/A';
    const totalMv = d.f116;
    const circMv = d.f117;
    const industry = d.f127 || 'N/A';
    const region = d.f128 || 'N/A';
    const roe = d.f186 ? d.f186.toFixed(2) : 'N/A';
    const grossMargin = d.f184 ? d.f184.toFixed(2) : 'N/A';
    const netMargin = d.f185 ? d.f185.toFixed(2) : 'N/A';
    
    return {
      name: d.f58 || '',
      code: d.f57 || code,
      price,
      open,
      high,
      low,
      prevClose,
      change,
      changePct,
      volume,
      amount,
      pe,
      pb,
      totalMv,
      circMv,
      industry,
      region,
      roe,
      grossMargin,
      netMargin,
      _dataSource: '东方财富(兜底)',
      _degraded: false,
    };
  }
  
  throw new Error('东方财富 API 无数据');
}

// ==================== 股票卡片搜索增强：资讯/事件/基本面摘要（2026-08-21） ====================
// 单源化设计：fetchStockNews/fetchStockEvents 同时服务 analyzeStockFull（StockQuery
// depth='full' 零重复打源）与 panel 路径（10min extras 缓存）；两路径 data 形状一致。
// 亮点提炼：TradingAgents（情感三元组 pos/neg/neu + 时间窗过滤 + 标题去重）、
// daily_stock_analysis（风险词表识别 + 事件 direction 语义 + 公告原文跳转 url）。

// 情感词典（原样搬自 analyzeMarketSentiment 新闻段——行为非破坏）
const _POSITIVE_WORDS = ['利好', '增长', '突破', '新高', '超预期', '增持', '回购', '创新高', '上涨', '强势', '机会', '看好', '低估', '爆发', '翻倍', '龙头', '领先'];
const _NEGATIVE_WORDS = ['利空', '下跌', '减持', '风险', '亏损', '违规', '处罚', '退市', '爆雷', '暴跌', '预警', '下滑', '不及预期', '负面', '诉讼', '解禁', '质押'];

// 风险公告词表（强动词；「风险」「风险提示」等例行词不入表——实测贵州茅台
// 「风险评估报告」例行公告会误伤，2026-08-21 curl 校准）
const _RISK_EVENT_TERMS = ['立案', '处罚', '违规', '警示函', '问询函', '监管函', '诉讼', '仲裁', '被罚', '证监会', '纪律处分', '立案调查', '冻结'];

// 事件方向映射（A 股语义：pos 正面/neg 负面/neu 中性；与 analyzeEventDriven eventStats 分类一致）
const _EVENT_DIRECTION = {
  '业绩超预期': 'pos',
  '财报披露': 'neu',
  '回购': 'pos',
  '高管增持': 'pos',
  '高管减持': 'neg',
  '解禁': 'neg',
  '风险': 'neg',
};

function _stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim();
}

function _normalizeTitle(title) {
  return _stripHtmlTags(title).replace(/[\s\u3000，。,.!?！？:：;；"'()（）[\]【】_—-]/g, '');
}

function _parseTimeToTs(time) {
  if (!time) return null;
  const s = String(time).trim();
  if (!s || s === 'N/A') return null;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * 新闻文本情感打分（规则词典，零 LLM 成本）
 * @param {string} text 标题+正文
 * @returns {'pos'|'neg'|'neu'|null} 规则同 analyzeMarketSentiment：胜出需超对手 1 次以上
 */
function _scoreNewsText(text) {
  if (!text) return null;
  let posHits = 0, negHits = 0;
  for (const w of _POSITIVE_WORDS) { if (text.includes(w)) posHits++; }
  for (const w of _NEGATIVE_WORDS) { if (text.includes(w)) negHits++; }
  if (posHits > negHits + 1) return 'pos';
  if (negHits > posHits + 1) return 'neg';
  return 'neu';
}

/** 东财新闻搜索 API 列表 → 标准资讯项（url 字段实测存在，无则 null） */
function parseNewsApiList(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(item => {
    const title = _stripHtmlTags(item.title || '');
    if (!title) return null;
    return {
      title,
      content: _stripHtmlTags(item.content || ''),
      url: item.url || item.artUrl || null,
      source: '新闻',
      time: item.date || item.showTime || null,
    };
  }).filter(Boolean);
}

/** 股吧热帖列表 → 标准资讯项（postid 拼接跳转 url，缺字段降级 null） */
function parseGubaApiList(rawList, code) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(post => {
    const title = _stripHtmlTags(post.title || '');
    if (!title) return null;
    const postId = post.postid || post.post_id || post.id;
    return {
      title,
      content: _stripHtmlTags(post.content || ''),
      url: postId ? 'https://guba.eastmoney.com/news,' + code + ',' + postId + '.html' : null,
      source: '股吧',
      time: post.post_publish_time || post.date || null,
    };
  }).filter(Boolean);
}

/** 公告列表 → 标准资讯项（art_code 拼接公告详情页 url） */
function parseAnnApiList(rawList, code) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map(ann => {
    const title = _stripHtmlTags(ann.title || ann.title_ch || '');
    if (!title) return null;
    const artCode = ann.art_code;
    return {
      title,
      content: '',
      url: artCode ? 'http://data.eastmoney.com/notices/detail/' + code + '/' + artCode + '.html' : null,
      source: '公告',
      time: ann.notice_date || ann.display_time || null,
    };
  }).filter(Boolean);
}

/**
 * 多源合并：标题归一化去重 + 时间窗过滤（超 maxAgeDays 丢弃，无时间戳保留排后）+
 * 按 time 倒序 + 截断 limit
 */
function mergeNewsItems(lists, opts = {}) {
  const { maxAgeDays = 30, limit = 12, now = Date.now() } = opts;
  const seen = new Set();
  const items = [];
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const key = _normalizeTitle(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const ts = _parseTimeToTs(item.time);
      if (ts !== null && ts < cutoff) continue;
      items.push(item);
    }
  }
  items.sort((a, b) => (_parseTimeToTs(b.time) || 0) - (_parseTimeToTs(a.time) || 0));
  return items.slice(0, limit);
}

/** 事件方向映射：无 direction 字段的事件按类型表兜底（默认 neu），url 兜底 null */
function normalizeEventItems(list) {
  if (!Array.isArray(list)) return [];
  return list.map(ev => ({
    type: ev.type || '未知',
    date: ev.date || 'N/A',
    detail: ev.detail || '',
    direction: ev.direction || _EVENT_DIRECTION[ev.type] || 'neu',
    url: ev.url || null,
  }));
}

/** 多路事件合并：type+date+detail 键去重 + 按 date 倒序（缺失排后）+ 截断 */
function mergeEvents(segments, opts = {}) {
  const { limit = 12 } = opts;
  const seen = new Set();
  const items = [];
  for (const seg of segments) {
    if (!Array.isArray(seg)) continue;
    for (const ev of seg) {
      const key = (ev.type || '') + '|' + (ev.date || '') + '|' + (ev.detail || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(ev);
    }
  }
  items.sort((a, b) => (_parseTimeToTs(b.date) || 0) - (_parseTimeToTs(a.date) || 0));
  return items.slice(0, limit);
}

/**
 * JSONP 接口拉取（东财新闻搜索返回 cb({...}) 包裹，fetchJson 裸 JSON.parse 必败——
 * 生产 analyzeMarketSentiment 新闻段因此长期走 catch 降级，2026-08-21 实测定罪）
 */
function _fetchJsonp(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const req = _http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const start = data.indexOf('(');
          const end = data.lastIndexOf(')');
          const inner = start > -1 && end > start ? data.slice(start + 1, end) : data;
          resolve(JSON.parse(inner));
        } catch (e) {
          reject(new Error('JSONP解析失败: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

/** 风险公告过滤（词表强词；'风险提示'类例行公告不命中——2026-08-21 curl 实测校准） */
function filterRiskAnnouncements(rawList, code) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map(ann => {
      const title = _stripHtmlTags(ann.title || ann.title_ch || '');
      if (!title || !_RISK_EVENT_TERMS.some(t => title.includes(t))) return null;
      const artCode = ann.art_code;
      return {
        type: '风险',
        date: (ann.notice_date || '').substring(0, 10) || 'N/A',
        detail: title.split(':').pop() || title,
        direction: 'neg',
        url: artCode ? 'http://data.eastmoney.com/notices/detail/' + code + '/' + artCode + '.html' : null,
      };
    })
    .filter(Boolean);
}

/**
 * 三源合并取数：新闻搜索 + 股吧热帖 + 公告。部分失败合并成功路；三路全失败→null。
 * 返回 items 保留 content 供情感打分复用（前端类型不声明 content）。
 */
async function fetchStockNews(code) {
  const prefix = getMarketPrefix(code);
  const newsUrl = 'http://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=%7B%22uid%22%3A%22%22%2C%22keyword%22%3A%22' + code + '%22%2C%22type%22%3A%5B%22cmsArticleWebOld%22%5D%2C%22client%22%3A%22web%22%2C%22clientType%22%3A%22web%22%2C%22clientVersion%22%3A%22curr%22%2C%22param%22%3A%7B%22cmsArticleWebOld%22%3A%7B%22searchScope%22%3A%22default%22%2C%22sort%22%3A%22default%22%2C%22pageIndex%22%3A1%2C%22pageSize%22%3A10%7D%7D%7D';
  const gubaUrl = 'http://guba.eastmoney.com/interface/GetData.aspx?path=guba/newlist&param=ps%3D10%26code%3D' + prefix + code + '%26type%3Dpost';
  const annUrl = 'http://np-anotice-stock.eastmoney.com/api/security/ann?page_size=5&page_index=1&ann_type=A&stock_list=' + code + '&f_node=0&s_node=0';
  const tasks = [
    _fetchJsonp(newsUrl, 6000).then(j => parseNewsApiList(j && j.result && Array.isArray(j.result.cmsArticleWebOld) ? j.result.cmsArticleWebOld : [])),
    fetchJson(gubaUrl, 5000).then(j => parseGubaApiList(j && j.Data && j.Data.list ? j.Data.list : [], code)),
    fetchJson(annUrl, 5000).then(j => parseAnnApiList(j && j.data && j.data.list ? j.data.list : [], code)),
  ];
  const settled = await Promise.allSettled(tasks);
  const lists = settled.map(s => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []));
  const all = mergeNewsItems(lists, { limit: 12 });
  if (all.length === 0) return null;
  // 情感打分（标题+正文，词典规则零成本——两路径共用）
  for (const item of all) {
    item.sentiment = _scoreNewsText((item.title + ' ' + item.content).trim());
  }
  return all;
}

/**
 * 事件取数：4 段 datacenter（业绩/回购/增减持/解禁，原样搬自 analyzeEventDriven
 * 并补 direction/url）+ 第 5 段风险公告词表识别。全失败→null。
 */
async function fetchStockEvents(code) {
  const segments = [];

  // 1. 业绩公告事件（含超预期/不及预期判定）
  // 2026-08-21 实测修正：RPT_LICO_FN_CPD 排序列 REPORT_DATE→REPORTDATE、同比字段
  // YYSR_TBZZ/JLR_TBZZ→YSTZ/SJLTZ（旧列名报「返回字段不存在」），columns 用 ALL 防再改名
  try {
    const earnUrl = 'http://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=(SECURITY_CODE="' + code + '")&pageSize=2&sortColumns=REPORTDATE&sortTypes=-1';
    const earnJson = await fetchJson(earnUrl, 6000);
    if (earnJson && earnJson.result && earnJson.result.data && earnJson.result.data.length >= 1) {
      const latest = earnJson.result.data[0];
      const reportDate = latest.REPORTDATE ? latest.REPORTDATE.substring(0, 10) : 'N/A';
      if (latest.SJLTZ != null && latest.YSTZ != null) {
        const surprise = latest.SJLTZ - latest.YSTZ;
        if (Math.abs(surprise) > 10) {
          segments.push({
            type: surprise > 0 ? '业绩超预期' : '业绩不及预期',
            date: reportDate,
            detail: '利润增速' + latest.SJLTZ.toFixed(1) + '% vs 营收增速' + latest.YSTZ.toFixed(1) + '%，差值' + (surprise > 0 ? '+' : '') + surprise.toFixed(1) + '%',
            direction: surprise > 0 ? 'pos' : 'neg',
            url: null,
          });
        }
      }
      if (latest.BASIC_EPS) {
        segments.push({ type: '财报披露', date: reportDate, detail: 'EPS: ' + latest.BASIC_EPS.toFixed(2) + '，营收同比' + (latest.YSTZ != null ? latest.YSTZ.toFixed(2) + '%' : 'N/A') + '，净利同比' + (latest.SJLTZ != null ? latest.SJLTZ.toFixed(2) + '%' : 'N/A'), direction: 'neu', url: null });
      }
    }
  } catch (e) {
    console.warn('[stock] 财报事件数据获取失败:', e.message);
  }

  // 2. 回购事件
  try {
    const repUrl = 'http://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_REPURCHASE_DET&columns=SECURITY_CODE,END_DATE,REPURCHASE_AMOUNT,REPURCHASE_NUM&filter=(SECURITY_CODE="' + code + '")&pageSize=3&sortColumns=END_DATE&sortTypes=-1';
    const repJson = await fetchJson(repUrl, 5000);
    if (repJson && repJson.result && repJson.result.data && repJson.result.data.length > 0) {
      for (const rep of repJson.result.data) {
        segments.push({
          type: '回购',
          date: rep.END_DATE ? rep.END_DATE.substring(0, 10) : 'N/A',
          detail: '回购金额 ' + fmtNum(rep.REPURCHASE_AMOUNT || 0) + '，回购数量 ' + fmtNum(rep.REPURCHASE_NUM || 0),
          direction: 'pos',
          url: null,
        });
      }
    }
  } catch (e) {
    console.warn('[stock] 回购数据获取失败:', e.message);
  }

  // 3. 高管增减持事件
  try {
    const execUrl = 'http://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_EXECUTIVE_HOLD_DET&columns=SECURITY_CODE,END_DATE,CHANGE_NUM,CHANGE_PRICE,EXECUTIVE_NAME&filter=(SECURITY_CODE="' + code + '")&pageSize=5&sortColumns=END_DATE&sortTypes=-1';
    const execJson = await fetchJson(execUrl, 5000);
    if (execJson && execJson.result && execJson.result.data && execJson.result.data.length > 0) {
      for (const exec of execJson.result.data) {
        const changeNum = exec.CHANGE_NUM || 0;
        const isAdd = changeNum > 0;
        segments.push({
          type: isAdd ? '高管增持' : '高管减持',
          date: exec.END_DATE ? exec.END_DATE.substring(0, 10) : 'N/A',
          detail: (exec.EXECUTIVE_NAME || '高管') + ' ' + (isAdd ? '增持' : '减持') + ' ' + fmtNum(Math.abs(changeNum)) + '股',
          direction: isAdd ? 'pos' : 'neg',
          url: null,
        });
      }
    }
  } catch (e) {
    console.warn('[stock] 高管增减持数据获取失败:', e.message);
  }

  // 4. 解禁事件
  try {
    const liftUrl = 'http://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LIFT_STAGE_DET&columns=SECURITY_CODE,END_DATE,LIFT_NUM,LIFT_RATIO&filter=(SECURITY_CODE="' + code + '")&pageSize=3&sortColumns=END_DATE&sortTypes=-1';
    const liftJson = await fetchJson(liftUrl, 5000);
    if (liftJson && liftJson.result && liftJson.result.data && liftJson.result.data.length > 0) {
      for (const lift of liftJson.result.data) {
        segments.push({
          type: '解禁',
          date: lift.END_DATE ? lift.END_DATE.substring(0, 10) : 'N/A',
          detail: '解禁数量 ' + fmtNum(lift.LIFT_NUM || 0) + '，占流通股 ' + (lift.LIFT_RATIO || 0).toFixed(2) + '%',
          direction: 'neg',
          url: null,
        });
      }
    }
  } catch (e) {
    console.warn('[stock] 解禁数据获取失败:', e.message);
  }

  // 5. 风险公告识别（词表强词；'风险提示'类例行公告不命中）
  try {
    const annUrl = 'http://np-anotice-stock.eastmoney.com/api/security/ann?page_size=10&page_index=1&ann_type=A&stock_list=' + code + '&f_node=0&s_node=0';
    const annJson = await fetchJson(annUrl, 5000);
    const list = annJson && annJson.data && annJson.data.list ? annJson.data.list : [];
    segments.push(...filterRiskAnnouncements(list, code));
  } catch (e) {
    console.warn('[stock] 风险公告识别失败:', e.message);
  }

  const merged = mergeEvents([normalizeEventItems(segments)], { limit: 12 });
  return merged.length > 0 ? merged : null;
}

/**
 * 基本面摘要投影（纯函数，勿重算任何基本面数值）
 * company ← companyQualitative / industry ← industryProspects / metrics+score ← fundamentals
 * 三源全缺失 → null
 */
function buildFundamentalsSummary(analysis) {
  if (!analysis) return null;
  const { companyQualitative, industryProspects, fundamentals, overallScore } = analysis;
  const company = companyQualitative ? {
    businessModel: (companyQualitative.businessModel && companyQualitative.businessModel.type) || null,
    pricing: (companyQualitative.businessModel && companyQualitative.businessModel.pricing) || null,
    moat: (companyQualitative.moat && companyQualitative.moat.type) || null,
    management: (companyQualitative.management && companyQualitative.management.quality) || null,
    overallScore: typeof companyQualitative.overallScore === 'number' ? companyQualitative.overallScore : null,
    summary: companyQualitative.summary || null,
  } : null;
  const industry = industryProspects ? {
    name: industryProspects.industry || null,
    prosperity: (industryProspects.prosperity && industryProspects.prosperity.level) || null,
    supplyDemand: (industryProspects.supplyDemand && industryProspects.supplyDemand.signal) || null,
    lifecycle: industryProspects.lifecycle || null,
    summary: industryProspects.summary || null,
  } : null;
  const metrics = fundamentals && fundamentals.metrics && fundamentals.metrics.length
    ? fundamentals.metrics.map(m => ({ name: m.name, value: m.value, status: m.status || null, score: typeof m.score === 'number' ? m.score : null }))
    : null;
  let score = null;
  if (fundamentals && typeof fundamentals.score === 'number') score = fundamentals.score;
  else if (overallScore) {
    const f = parseFloat(overallScore.finalScore);
    score = Number.isNaN(f) ? null : f;
  }
  if (!company && !industry && !metrics && score === null) return null;
  const parts = [];
  if (company && company.summary) parts.push(company.summary);
  if (industry && industry.summary) parts.push(industry.summary);
  return { company, industry, metrics, score, summary: parts.length > 0 ? parts.join('；') : null };
}

module.exports = {  fetchStockNews,
  fetchStockEvents,
  buildFundamentalsSummary,
  parseNewsApiList,
  parseGubaApiList,
  parseAnnApiList,
  mergeNewsItems,
  normalizeEventItems,
  mergeEvents,
  _scoreNewsText,
  _fetchJsonp,
  filterRiskAnnouncements,

  analyzeFundamentals,
  analyzeMarketContext,
  calculateOverallScore,
  fetchNorthFlow,
  fetchMarginData,
  fetchMarketIndex,
  fetchIndustryPeers,
  fetchFundFlowTrend,
  fetchEastMoneyQuote,
  injectDataSourceManager,
};
