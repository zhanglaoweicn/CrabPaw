const { STOCK_DISCLAIMER, buildVoiceQuote, buildHoldingsSummary, buildPreopenBriefing } = require('../../src/core/stock-helper');
const { addHolding, listHoldings, removeHolding, publishHoldingsCard } = require('../../src/tools/stock-holdings-tools');

module.exports = {
  name: 'Stock Voice',
  cases: [
    {
      id: 'sv_001',
      name: '免责声明常量非空且含"仅供参考"',
      category: 'stock_voice',
      run: () => typeof STOCK_DISCLAIMER === 'string' && STOCK_DISCLAIMER.includes('仅供参考'),
    },
    {
      id: 'sv_002',
      name: '语音行情：现价/涨跌/信号 3 点式 + 免责',
      category: 'stock_voice',
      run: () => {
        const r = buildVoiceQuote({ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1, signal: 'MACD 金叉', score: 72 });
        return r.text.includes('1450.5') && r.text.includes('2.1') && r.text.includes('MACD') && r.text.includes('仅供参考');
      },
    },
    {
      id: 'sv_003',
      name: '持仓摘要：总市值/浮盈亏/免责',
      category: 'stock_voice',
      run: () => {
        const r = buildHoldingsSummary([
          { code: '600519', name: '贵州茅台', shares: 100, cost: 1200, price: 1450 },
          { code: '000001', name: '平安银行', shares: 1000, cost: 10, price: 11 },
        ]);
        return r.text.includes('总市值') && r.text.includes('仅供参考') && r.text.includes('茅台');
      },
    },
    {
      id: 'sv_004',
      name: '早报：大盘指数 + 免责',
      category: 'stock_voice',
      run: () => {
        const r = buildPreopenBriefing({ sh: { changePct: 0.5 }, holdings: [] });
        return r.text.includes('上证') && r.text.includes('仅供参考');
      },
    },
    {
      id: 'sv_005',
      name: '持仓 CRUD 闭环',
      category: 'stock_voice',
      run: () => {
        addHolding({ code: 'EVAL001', name: '测试股', shares: 100, cost: 10 });
        const has = listHoldings().some((h) => h.code === 'EVAL001');
        const removed = removeHolding('EVAL001');
        return has && removed && !listHoldings().some((h) => h.code === 'EVAL001');
      },
    },
    {
      id: 'sv_006',
      name: '持仓校验：股数/成本须为正数',
      category: 'stock_voice',
      run: () => {
        const r = addHolding({ code: 'EVALBAD', name: 'X', shares: -1, cost: 10 });
        return !!r.error;
      },
    },
    {
      id: 'sv_007',
      name: '持仓变更后发射 stocks 卡片到 SceneStore（审计 P1-4 通路）',
      category: 'stock_voice',
      run: () => {
        const { getSceneStore } = require('../../src/core/scene/scene-store');
        addHolding({ code: 'EVAL002', name: '卡片股', shares: 50, cost: 20 });
        publishHoldingsCard();
        const card = getSceneStore().getSurface('stocks-card');
        const ok = !!card && card.kind === 'stocks' && Array.isArray(card.data.items) && card.data.items.some((i) => i.code === 'EVAL002');
        removeHolding('EVAL002');
        return ok;
      },
    },
    {
      id: 'sv_008',
      name: '空持仓摘要卡片 items 为空数组（前端空态可渲染）',
      category: 'stock_voice',
      run: () => {
        const r = buildHoldingsSummary([]);
        return r.card.kind === 'stocks' && Array.isArray(r.card.items) && r.card.items.length === 0;
      },
    },
    {
      id: 'sv_009',
      name: 'K线 candlestick 卡结构映射：date/open/high/low/close → labels/ohlc',
      category: 'stock_voice',
      run: () => {
        const { buildKlineCard } = require('../../src/core/stock-helper');
        const kline = [
          { date: '2026-08-10', open: 1430, close: 1450, high: 1460, low: 1425, volume: 100, amount: 0 },
          { date: '2026-08-11', open: 1450, close: 1440, high: 1455, low: 1435, volume: 90, amount: 0 },
        ];
        const card = buildKlineCard({ code: '600519', name: '贵州茅台', kline, limit: 30 });
        return !!card
          && card.kind === 'chart'
          && card.data.type === 'candlestick'
          && card.data.title === '600519 贵州茅台 K线'
          && card.data.labels.join(',') === '2026-08-10,2026-08-11'
          && card.data.ohlc[0].o === 1430 && card.data.ohlc[0].h === 1460
          && card.data.ohlc[0].l === 1425 && card.data.ohlc[0].c === 1450
          && card.data.ohlc[1].c === 1440;
      },
    },
    {
      id: 'sv_010',
      name: 'K线缺失/全部非法数据 → buildKlineCard 返回 null（跳过发卡不阻塞）',
      category: 'stock_voice',
      run: () => {
        const { buildKlineCard } = require('../../src/core/stock-helper');
        const invalid = [
          { date: '2026-08-10', open: NaN, close: 'x', high: undefined, low: null },
          { date: '2026-08-11', open: 'y', close: 'z', high: 'w', low: 'v' },
        ];
        return buildKlineCard({ code: '600519', name: '贵州茅台', kline: null }) === null
          && buildKlineCard({ code: '600519', name: '贵州茅台', kline: [] }) === null
          && buildKlineCard({ code: '600519', name: '贵州茅台', kline: invalid }) === null;
      },
    },
    {
      id: 'sv_011',
      name: '单股查询卡片链路：stocks-card 与 stocks-kline（candlestick）均可发射到 SceneStore',
      category: 'stock_voice',
      run: () => {
        const { getSceneStore } = require('../../src/core/scene/scene-store');
        const { _publishKlineCard } = require('../../src/tools/stock-tools');
        // stocks-card 通路（stock-helper 构造形状）
        const voice = buildVoiceQuote({ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1, signal: 'MACD 金叉', score: 72 });
        const stocksOk = voice.card.kind === 'stocks' && voice.card.items[0].score === 72 && voice.card.items[0].signal === 'MACD 金叉';
        // stocks-kline 通路：模拟 fetchKLineData 返回结构 → SceneStore（不依赖网络）
        const kline = [
          { date: '2026-08-10', open: 1430, close: 1450, high: 1460, low: 1425, volume: 100, amount: 0 },
          { date: '2026-08-11', open: 1450, close: 1470, high: 1475, low: 1435, volume: 90, amount: 0 },
        ];
        _publishKlineCard({ code: '600519', name: '贵州茅台', kline });
        const surf = getSceneStore().getSurface('stocks-kline');
        const klineOk = !!surf && surf.kind === 'chart' && surf.data.type === 'candlestick'
          && surf.data.ohlc.length === 2 && surf.data.ohlc[1].c === 1470 && surf.data.labels[0] === '2026-08-10';
        // 非法 K线 → 跳过不发卡，且不覆盖已有卡
        _publishKlineCard({ code: '600519', name: '贵州茅台', kline: null });
        const after = getSceneStore().getSurface('stocks-kline');
        const skipOk = !!after && after.data.ohlc.length === 2;
        return stocksOk && klineOk && skipOk;
      },
    },
    {
      id: 'sv_012',
      name: '搜索增强 extras 并入股票卡：news/events/fundamentalsSummary 三字段（2026-08-21 P4）',
      category: 'stock_voice',
      run: () => {
        const { _publishStockCard } = require('../../src/tools/stock-tools');
        const { getSceneStore } = require('../../src/core/scene/scene-store');
        const extras = {
          code: '600519',
          news: [{ title: '茅台业绩超预期', url: 'http://a', source: '新闻', time: '2026-08-20 10:00:00', sentiment: 'pos' }],
          events: [{ type: '财报披露', date: '2026-06-30', detail: 'EPS: 35.57', direction: 'neu', url: null }],
          fundamentalsSummary: {
            company: { businessModel: '高附加值型', overallScore: 0.8, summary: '品牌壁垒深厚' },
            industry: { name: '白酒', prosperity: '景气', summary: '白酒景气' },
            metrics: [{ name: 'PE估值', value: '28.50', status: '合理' }],
            score: 0.6, summary: '综合摘要',
          },
        };
        _publishStockCard([{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }], null, extras);
        const surf = getSceneStore().getSurface('stock-panel');
        if (!surf || !surf.data) return false;
        const n0 = surf.data.news && surf.data.news[0];
        const e0 = surf.data.events && surf.data.events[0];
        return Array.isArray(surf.data.news) && !!n0 && !!n0.title && !!n0.url && !!n0.source && n0.sentiment === 'pos'
          && Array.isArray(surf.data.events) && !!e0 && e0.direction === 'neu' && e0.type === '财报披露'
          && !!surf.data.fundamentalsSummary && surf.data.fundamentalsSummary.score === 0.6;
      },
    },
  ],
};
