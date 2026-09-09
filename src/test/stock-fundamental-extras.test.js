/**
 * 股票卡片搜索增强：资讯/事件/基本面摘要取数层纯函数测试（2026-08-21）
 *
 * 网络链路免测（真网不稳定 + 股吧接口本机 302），解析/合并/映射/投影逻辑单测锁定。
 * 仿 stock-search-fallback.test.js 模式：解析纯函数直接测，fetchStockNews/
 * fetchStockEvents 的集成由 mock 层测试覆盖（stock-analysis / panels/stock）。
 *
 * 2026-08-21 实测背景：
 *   - 新闻源返回 JSONP 包裹 cb({...})，且 cmsArticleWebOld 是数组（生产代码 .list
 *     路径双重错误，新闻段长期降级——本次经 _fetchJsonp + 数组路径修复）
 *   - RPT_LICO_FN_CPD 排序列已由 REPORT_DATE 改为 REPORTDATE、同比字段改为
 *     YSTZ/SJLTZ（旧列名报「返回字段不存在」）
 *   - RPT_REPURCHASE_DET/RPT_EXECUTIVE_HOLD_DET/RPT_LIFT_STAGE_DET 报表已下线
 *     （「报表配置不存在」），回购/增减持/解禁段保持 try/catch 降级
 *   - 贵州茅台「风险评估报告」例行公告含弱词「风险」，风险词表必须用强动词
 */

const {
  parseNewsApiList, parseGubaApiList, parseAnnApiList,
  mergeNewsItems, normalizeEventItems, mergeEvents,
  _scoreNewsText, filterRiskAnnouncements, buildFundamentalsSummary,
} = require('../tools/stock/stock-fundamental');

describe('parseNewsApiList（新闻搜索 API 解析）', () => {
  test('字段映射：title/url/time/source，剥离 em 标签', () => {
    const list = parseNewsApiList([
      { title: '贵州茅台(<em>600519</em>).SH：<em>2</em>0<em>2</em>6年中报净利润<em>44</em>5亿元',
        content: '2026年8月15日发布中报。',
        date: '2026-08-15 10:11:51', mediaName: '界面新闻',
        url: 'http://finance.eastmoney.com/a/202608153842377958.html' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: '贵州茅台(600519).SH：2026年中报净利润445亿元',
      content: '2026年8月15日发布中报。',
      url: 'http://finance.eastmoney.com/a/202608153842377958.html',
      source: '新闻',
      time: '2026-08-15 10:11:51',
    });
  });

  test('url 缺失 → null（降级表），空标题条目丢弃', () => {
    const list = parseNewsApiList([
      { title: '无链接新闻', date: '2026-08-15 10:00:00' },
      { title: '', date: '2026-08-15 10:00:00' },
      { title: '   ', date: '2026-08-15 10:00:00' },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBeNull();
  });

  test('非数组输入 → 空数组', () => {
    expect(parseNewsApiList(null)).toEqual([]);
    expect(parseNewsApiList(undefined)).toEqual([]);
    expect(parseNewsApiList('x')).toEqual([]);
  });
});

describe('parseGubaApiList（股吧热帖解析）', () => {
  test('postid 拼接跳转 url，post_publish_time 作 time', () => {
    const list = parseGubaApiList([
      { title: '茅台起飞了', content: '加仓', postid: '12345', post_publish_time: '2026-08-20 09:30:00' },
    ], '600519');
    expect(list[0]).toMatchObject({
      title: '茅台起飞了',
      url: 'https://guba.eastmoney.com/news,600519,12345.html',
      source: '股吧',
      time: '2026-08-20 09:30:00',
    });
  });

  test('无 postid → url null（不可点行，不隐藏）', () => {
    const list = parseGubaApiList([{ title: '水贴', post_publish_time: '2026-08-20' }], '600519');
    expect(list[0].url).toBeNull();
  });
});

describe('parseAnnApiList（公告解析）', () => {
  test('art_code 拼接公告详情页 url', () => {
    const list = parseAnnApiList([
      { title: '贵州茅台:贵州茅台关于召开业绩说明会的公告', art_code: 'AN202608141827994407', notice_date: '2026-08-15 00:00:00' },
    ], '600519');
    expect(list[0]).toMatchObject({
      title: '贵州茅台:贵州茅台关于召开业绩说明会的公告',
      url: 'http://data.eastmoney.com/notices/detail/600519/AN202608141827994407.html',
      source: '公告',
      time: '2026-08-15 00:00:00',
    });
  });

  test('无 art_code → url null', () => {
    const list = parseAnnApiList([{ title: '贵州茅台:公告', notice_date: '2026-08-15' }], '600519');
    expect(list[0].url).toBeNull();
  });
});

describe('mergeNewsItems（多源合并去重 + 时间窗 + 排序 + 截断）', () => {
  const now = new Date('2026-08-21T00:00:00Z').getTime();
  const mk = (title, time) => ({ title, time, source: '新闻', url: null });

  test('标题归一化去重（空格/标点差异视为同一标题）', () => {
    const out = mergeNewsItems([
      [mk('茅台 业绩说明会', '2026-08-20 10:00:00')],
      [mk('茅台业绩说明会', '2026-08-20 11:00:00')],  // 去空格后与上同
      [mk('茅台：业绩说明会', '2026-08-20 12:00:00')], // 去冒号后与上同
    ], { now });
    expect(out).toHaveLength(1);
  });

  test('时间窗过滤：超 30 天丢弃，无时间戳保留', () => {
    const out = mergeNewsItems([
      [mk('老新闻', '2026-06-01 10:00:00'), mk('新新闻', '2026-08-20 10:00:00'), mk('无时间戳', null)],
    ], { now });
    expect(out.map(i => i.title)).toEqual(['新新闻', '无时间戳']);
  });

  test('按 time 倒序（缺失排后）', () => {
    const out = mergeNewsItems([
      [mk('a', '2026-08-18 10:00:00'), mk('b', null), mk('c', '2026-08-20 10:00:00'), mk('d', '2026-08-19 10:00:00')],
    ], { now });
    expect(out.map(i => i.title)).toEqual(['c', 'd', 'a', 'b']);
  });

  test('截断 limit（默认 12）', () => {
    const items = Array.from({ length: 20 }, (_, i) => mk(`标题${i}`, `2026-08-${String(1 + (i % 20)).padStart(2, '0')} 10:00:00`));
    const out = mergeNewsItems([items], { now });
    expect(out).toHaveLength(12);
  });
});

describe('_scoreNewsText（规则情感词典）', () => {
  test('正面文案 → pos（胜出需超对手 1 次以上）', () => {
    expect(_scoreNewsText('公司业绩超预期，利润增长，回购股份')).toBe('pos');
  });

  test('负面文案 → neg', () => {
    expect(_scoreNewsText('公司亏损扩大，违规被处罚，股价暴跌')).toBe('neg');
  });

  test('中性/无词典词 → neu', () => {
    expect(_scoreNewsText('公司召开股东大会')).toBe('neu');
  });

  test('空输入 → null', () => {
    expect(_scoreNewsText(null)).toBeNull();
    expect(_scoreNewsText(undefined)).toBeNull();
    expect(_scoreNewsText('')).toBeNull();
  });

  test('正负打平（差 1 以内）→ neu（与原 analyzeMarketSentiment 规则一致）', () => {
    expect(_scoreNewsText('增长但风险并存')).toBe('neu');
  });
});

describe('normalizeEventItems（direction 映射）', () => {
  test('无 direction 按类型表映射', () => {
    expect(normalizeEventItems([
      { type: '高管减持', date: '2026-08-01', detail: 'x' },
      { type: '回购', date: '2026-08-02', detail: 'y' },
      { type: '财报披露', date: '2026-08-03', detail: 'z' },
    ])).toEqual([
      { type: '高管减持', date: '2026-08-01', detail: 'x', direction: 'neg', url: null },
      { type: '回购', date: '2026-08-02', detail: 'y', direction: 'pos', url: null },
      { type: '财报披露', date: '2026-08-03', detail: 'z', direction: 'neu', url: null },
    ]);
  });

  test('已有 direction 保留，未知类型默认 neu', () => {
    expect(normalizeEventItems([
      { type: '风险', date: '2026-08-01', detail: 'x', direction: 'neg', url: 'http://a' },
      { type: '新类型', date: '2026-08-02', detail: 'y' },
    ])).toEqual([
      { type: '风险', date: '2026-08-01', detail: 'x', direction: 'neg', url: 'http://a' },
      { type: '新类型', date: '2026-08-02', detail: 'y', direction: 'neu', url: null },
    ]);
  });
});

describe('mergeEvents（多路合并去重 + 倒序 + 截断）', () => {
  test('type+date+detail 键去重，按 date 倒序', () => {
    const out = mergeEvents([
      [
        { type: '回购', date: '2026-08-01', detail: '回购 1 亿', direction: 'pos' },
        { type: '回购', date: '2026-08-01', detail: '回购 1 亿', direction: 'pos' }, // 重复
        { type: '财报披露', date: '2026-08-10', detail: 'EPS 1.2', direction: 'neu' },
      ],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].type).toBe('财报披露');
  });

  test('非数组段跳过，截断 limit', () => {
    const seg = Array.from({ length: 15 }, (_, i) => ({ type: 'T' + i, date: '2026-08-01', detail: 'd' + i }));
    const out = mergeEvents([seg, 'bad'], { limit: 10 });
    expect(out).toHaveLength(10);
  });
});

describe('filterRiskAnnouncements（风险公告词表）', () => {
  test('立案/处罚/违规/诉讼类命中，产出 neg + 公告原文 url', () => {
    const out = filterRiskAnnouncements([
      { title: '贵州茅台:贵州茅台关于收到中国证监会立案告知书的公告', art_code: 'AN001', notice_date: '2026-08-20 00:00:00' },
      { title: '贵州茅台:关于公司收到行政处罚决定书的公告', art_code: 'AN002', notice_date: '2026-08-19 00:00:00' },
    ], '600519');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: '风险',
      date: '2026-08-20',
      direction: 'neg',
      detail: '贵州茅台关于收到中国证监会立案告知书的公告',
      url: 'http://data.eastmoney.com/notices/detail/600519/AN001.html',
    });
  });

  test('例行公告与弱词「风险评估报告」不命中（2026-08-21 实测校准）', () => {
    const out = filterRiskAnnouncements([
      { title: '贵州茅台:贵州茅台关于召开业绩说明会的公告', art_code: 'AN003' },
      { title: '贵州茅台:贵州茅台集团财务有限公司的风险评估报告', art_code: 'AN004' },
    ], '600519');
    expect(out).toEqual([]);
  });
});

describe('buildFundamentalsSummary（基本面摘要投影）', () => {
  const fullAnalysis = {
    companyQualitative: {
      businessModel: { type: '高附加值型', pricing: '强定价权', score: 0.4, details: [] },
      moat: { type: '品牌护城河', strength: '强', score: 0.4, details: [] },
      management: { quality: '优秀', score: 0.3, details: [] },
      overallScore: 0.8,
      summary: '品牌壁垒深厚，定价权强',
    },
    industryProspects: {
      industry: '白酒', prosperity: { level: '景气', score: 0.2, details: [] },
      supplyDemand: { signal: '供不应求', details: [] },
      lifecycle: '成熟期', ranking: null,
      summary: '白酒行业景气度景气，供需供不应求，生命周期成熟期',
    },
    fundamentals: {
      score: 0.6,
      metrics: [{ name: 'PE估值', value: '28.50', status: '合理', score: 0.1 }],
    },
    overallScore: { finalScore: '0.72', recommendation: 'BUY', confidence: '0.72' },
  };

  test('完整投影：company/industry/metrics/score/summary 全量', () => {
    const s = buildFundamentalsSummary(fullAnalysis);
    expect(s).toEqual({
      company: {
        businessModel: '高附加值型', pricing: '强定价权', moat: '品牌护城河',
        management: '优秀', overallScore: 0.8, summary: '品牌壁垒深厚，定价权强',
      },
      industry: {
        name: '白酒', prosperity: '景气', supplyDemand: '供不应求',
        lifecycle: '成熟期', summary: '白酒行业景气度景气，供需供不应求，生命周期成熟期',
      },
      metrics: [{ name: 'PE估值', value: '28.50', status: '合理', score: 0.1 }],
      score: 0.6,
      summary: '品牌壁垒深厚，定价权强；白酒行业景气度景气，供需供不应求，生命周期成熟期',
    });
  });

  test('部分缺失：无 industryProspects → industry 子对象 null', () => {
    const { industryProspects, ...rest } = fullAnalysis;
    const s = buildFundamentalsSummary(rest);
    expect(s.industry).toBeNull();
    expect(s.company).not.toBeNull();
  });

  test('无 fundamentals.score 时回退 overallScore.finalScore', () => {
    const { fundamentals, ...rest } = fullAnalysis;
    const s = buildFundamentalsSummary({ ...rest, fundamentals: { metrics: [{ name: 'PB', value: '1.0' }] } });
    expect(s.score).toBe(0.72);
  });

  test('三源全缺失 → null', () => {
    expect(buildFundamentalsSummary({})).toBeNull();
    expect(buildFundamentalsSummary({ companyQualitative: null, industryProspects: null, fundamentals: null })).toBeNull();
  });

  test('无 analysis → null', () => {
    expect(buildFundamentalsSummary(null)).toBeNull();
    expect(buildFundamentalsSummary(undefined)).toBeNull();
  });
});
