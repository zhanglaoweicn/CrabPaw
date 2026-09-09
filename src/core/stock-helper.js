/**
 * stock-helper — 股票语音播报组装（3 点式 + 免责声明）
 *
 * 行情获取由调用方注入（复用现有 stock-tools 的东方财富免费源），
 * 本模块只做「文本组装 + 免责声明 + 卡片结构」。
 */

const STOCK_DISCLAIMER = '数据仅供参考，不构成投资建议。';

function buildVoiceQuote({ code, name, price, changePct, signal, score }) {
  const parts = [];
  parts.push(`${name}（${code}）现价 ${price} 元`);
  if (changePct !== undefined) parts.push(changePct >= 0 ? `涨 ${changePct}%` : `跌 ${Math.abs(changePct)}%`);
  if (signal) parts.push(signal);
  if (score !== undefined) parts.push(`综合评分 ${score} 分`);
  return {
    text: parts.join('，') + '。' + STOCK_DISCLAIMER,
    card: { kind: 'stocks', items: [{ code, name, price, changePct, signal, score }] },
  };
}

function buildHoldingsSummary(holdings) {
  const list = Array.isArray(holdings) ? holdings : [];
  if (list.length === 0) {
    return { text: `您还没有持仓记录，说「买 600519 一百股成本 1200」就能开始管理。${STOCK_DISCLAIMER}`, card: { kind: 'stocks', items: [] } };
  }
  const marketValue = list.reduce((s, h) => s + h.shares * (h.price || 0), 0);
  const costValue = list.reduce((s, h) => s + h.shares * h.cost, 0);
  const pnl = marketValue - costValue;
  const pnlPct = costValue > 0 ? (pnl / costValue) * 100 : 0;
  const winners = list.filter((h) => (h.price || 0) >= h.cost).length;
  const names = list.map(h => h.name).filter(Boolean).join('、');
  const parts = [
    `您持有 ${names} 共 ${list.length} 只持仓，总市值约 ${Math.round(marketValue).toLocaleString('zh-CN')} 元`,
    pnl >= 0 ? `浮盈 ${Math.round(pnl).toLocaleString('zh-CN')} 元（${pnlPct.toFixed(1)}%）` : `浮亏 ${Math.round(Math.abs(pnl)).toLocaleString('zh-CN')} 元（${pnlPct.toFixed(1)}%）`,
    `${winners} 只盈利`,
  ];
  return {
    text: parts.join('，') + '。' + STOCK_DISCLAIMER,
    card: { kind: 'stocks', items: list },
  };
}

/**
 * buildKlineCard — 组装 K线 candlestick 卡片结构（scene surface 'stocks-kline'）
 *
 * 契约（前端 kinds/chart.tsx candlestick 分支消费）：
 *   kline 输入为 fetchKLineData 返回结构：[{ date, open, close, high, low, volume, amount }]
 *   映射表：
 *     kline[i].date  → data.labels[i]        （日期字符串）
 *     kline[i].open  → data.ohlc[i].o        （开盘价）
 *     kline[i].high  → data.ohlc[i].h        （最高价）
 *     kline[i].low   → data.ohlc[i].l        （最低价）
 *     kline[i].close → data.ohlc[i].c        （收盘价）
 *   volume/amount 不在蜡烛图绘制范围（预留未来成交量副图）。
 *   取最近 limit（默认 30）根做蜡烛；K线缺失/非法（非数组、空数组、全部数值无效）返回 null，
 *   调用方跳过不发卡（不报错、不阻塞主流程）。
 */
function buildKlineCard({ code, name, kline, limit = 30 }) {
  if (!Array.isArray(kline) || kline.length === 0) return null;
  const bars = kline.slice(-Math.max(1, Math.min(limit, kline.length)));
  const labels = [];
  const ohlc = [];
  for (const k of bars) {
    const o = Number(k.open);
    const h = Number(k.high);
    const l = Number(k.low);
    const c = Number(k.close);
    if (![o, h, l, c].every(Number.isFinite)) continue; // 单根非法 → 丢弃该根，不整卡失败
    labels.push(String(k.date ?? ''));
    ohlc.push({ o, h, l, c });
  }
  if (ohlc.length === 0) return null;
  return {
    kind: 'chart',
    data: {
      type: 'candlestick',
      title: `${code} ${name} K线`,
      labels,
      ohlc,
    },
    intent: 'inform',
  };
}

function buildPreopenBriefing({ sh, holdings = [] }) {
  const parts = [];
  if (sh && sh.changePct !== undefined) parts.push(`上证指数 ${sh.changePct >= 0 ? '涨' : '跌'} ${Math.abs(sh.changePct)}%`);
  if (holdings.length) parts.push(`${holdings.length} 只持仓待关注`);
  return {
    text: `开盘早报：${parts.join('，') || '今天没有特别提醒'}。${STOCK_DISCLAIMER}`,
    card: { kind: 'stocks', items: holdings },
  };
}

module.exports = { STOCK_DISCLAIMER, buildVoiceQuote, buildHoldingsSummary, buildPreopenBriefing, buildKlineCard };
