/**
 * 台风工具（TyphoonQuery）Eval 用例
 *
 * 覆盖：a) 活跃列表解析 + 场景卡发射含 items
 *       b) 单台风详情解析含 detail（路径点 + 机构预报）
 *       c) 主源失败降级备源
 *       d) 双源失败返回可读错误
 *       e) 空列表空态 + 空态卡片
 *
 * mock 方式：通过 context._fetchImpl 注入按 URL 分派的 fetch（typhoon-tools.resolveFetch），
 * 不替换 global.fetch，与 eval 并行执行的其它套件互不干扰；
 * 卡片断言用 context._surfaceId 独立 surface id，避免并发用例互相覆盖。
 */

const {
  handleTyphoonQuery,
  parseActivityItem,
  parsePrimaryDetail,
} = require('../../src/tools/typhoon-tools');

// ==================== mock 数据（基于 2026-08-12 真实接口结构） ====================

const PRIMARY_ITEM = {
  enname: 'NANGKA', lat: '22.90', lng: '145.30', movedirection: '东', movespeed: '24',
  name: '浪卡', power: '8', pressure: '998', radius10: null, radius7: '600',
  speed: '18', strong: '热带风暴', tfid: '202617', warnlevel: null,
  time: '2026-08-12T12:00:00.000+00:00', timeformate: '8月12日20时',
};

const PRIMARY_DETAIL = {
  tfid: '202617', name: '浪卡', enname: 'NANGKA', isactive: '1',
  starttime: '2026-08-12 08:00:00', endtime: '2026-08-12 20:00:00',
  warnlevel: 'white', centerlng: '143.500000', centerlat: '27.200000',
  land: [{ time: '2026-08-14 20:00:00', lng: '122.10', lat: '28.50' }],
  points: [
    {
      time: '2026-08-12 08:00:00', lng: '141.70', lat: '21.80', strong: '热带风暴',
      power: '8', speed: '18', pressure: '998', movespeed: '36', movedirection: '北东',
      radius7: '300|500|300|600', radius10: '',
      forecast: [
        { tm: '中国', forecastpoints: [{ time: '2026-08-12 08:00:00', lng: '141.70', lat: '21.80' }, { time: '2026-08-13 08:00:00', lng: '147.20', lat: '26.60' }] },
        { tm: '日本', forecastpoints: [{ time: '2026-08-12 08:00:00', lng: '141.70', lat: '21.80' }, { time: '2026-08-13 08:00:00', lng: '147.00', lat: '26.00' }] },
      ],
    },
    {
      time: '2026-08-12 20:00:00', lng: '145.30', lat: '22.90', strong: '热带风暴',
      power: '8', speed: '18', pressure: '998', movespeed: '24', movedirection: '东',
      radius7: '300|300|500|600', radius10: '',
      forecast: [
        { tm: '中国', forecastpoints: [{ time: '2026-08-12 20:00:00', lng: '145.30', lat: '22.90' }, { time: '2026-08-13 20:00:00', lng: '148.60', lat: '28.40' }] },
        { tm: '日本', forecastpoints: [{ time: '2026-08-12 20:00:00', lng: '145.30', lat: '22.90' }, { time: '2026-08-13 20:00:00', lng: '148.00', lat: '28.00' }] },
      ],
    },
  ],
};

const BACKUP_LIST = {
  code: 0, msg: '成功',
  data: {
    typhoons: [
      { id: '3302529', tc_num: '2617', name_cn: '浪卡', name_en: 'NANGKA',
        description: '又名菠萝蜜果', state: 'start', is_active: true },
    ],
    active_count: 1, total_count: 19,
  },
  request_id: 'eval-mock',
};

// ==================== mock 工具 ====================

const jsonResp = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

/**
 * 构造按 URL 包含匹配分派的 fetch mock。
 * 通过 context._fetchImpl 注入（typhoon-tools.resolveFetch），
 * 不替换 global.fetch —— 与 eval 并行执行的其它套件互不干扰。
 * 返回 [mockFn, ...]，调用方将 mockFn 作为第二个参数传给 handleTyphoonQuery。
 */
function buildMockFetch(handlers) {
  return async (url) => {
    const u = String(url);
    for (const [key, fn] of Object.entries(handlers)) {
      if (u.includes(key)) return fn(u);
    }
    throw new Error(`eval: 未预期的请求 ${u}`);
  };
}

// ==================== 用例 ====================

module.exports = {
  name: 'Typhoon',
  cases: [
    {
      id: 'ty_001',
      name: '活跃列表项解析：字段齐全（tfid/名称/经纬度/强度/风圈/预警）',
      category: 'typhoon',
      run: () => {
        const it = parseActivityItem(PRIMARY_ITEM);
        return it.tfid === '202617' && it.name === '浪卡' && it.enname === 'NANGKA'
          && it.lat === 22.9 && it.lng === 145.3
          && it.strong === '热带风暴' && it.power === '8'
          && it.pressure === 998 && it.speed === 18
          && it.moveDir === '东' && it.moveSpeed === 24
          && it.radius7 === '600' && it.radius10 === '' && it.warnLevel === '';
      },
    },
    {
      id: 'ty_002',
      name: '详情解析：最新路径点取当前状态 + 路径点/机构预报摘要',
      category: 'typhoon',
      run: () => {
        const d = parsePrimaryDetail(PRIMARY_DETAIL);
        return d.name === '浪卡' && d.warnLevel === 'white'
          && d.lat === 27.2 && d.lng === 143.5
          && d.strong === '热带风暴' && d.pressure === 998
          && d.moveDir === '东' && d.moveSpeed === 24
          && d.points.length === 2
          && d.forecasts.length === 2 && d.forecasts[0].agency === '中国'
          && d.forecasts[0].pointCount === 2
          && d.forecasts[0].summary.includes('08-12 20:00')
          && d.land.length === 1;
      },
    },
    {
      id: 'ty_003',
      name: '空查询：列表文本 + 发射 typhoon 卡片（items 非空）',
      category: 'typhoon',
      run: async () => {
        const fetchImpl = buildMockFetch({ TyhoonActivity: () => jsonResp([PRIMARY_ITEM]) });
        const { getSceneStore } = require('../../src/core/scene/scene-store');
        const r = await handleTyphoonQuery({}, { _fetchImpl: fetchImpl, _surfaceId: 'typhoon-eval-list' });
        if (!r.success || !r.content.includes('活跃台风') || !r.content.includes('浪卡')) return false;
        const card = getSceneStore().getSurface('typhoon-eval-list');
        return !!card && card.kind === 'typhoon'
          && Array.isArray(card.data.items) && card.data.items.length === 1
          && card.data.items[0].tfid === '202617'
          && card.data.detail === undefined;
      },
    },
    {
      id: 'ty_004',
      name: '按名称命中：详情文本 + 卡片含 detail（points/forecasts/land）',
      category: 'typhoon',
      run: async () => {
        const fetchImpl = buildMockFetch({
          TyhoonActivity: () => jsonResp([PRIMARY_ITEM]),
          'TyphoonInfo/202617': () => jsonResp(PRIMARY_DETAIL),
        });
        const { getSceneStore } = require('../../src/core/scene/scene-store');
        const r = await handleTyphoonQuery({ query: '浪卡' }, { _fetchImpl: fetchImpl, _surfaceId: 'typhoon-eval-detail' });
        if (!r.success || !r.content.includes('中心气压') || !r.content.includes('东经143.5')) return false;
        const card = getSceneStore().getSurface('typhoon-eval-detail');
        return !!card && !!card.data.detail
          && Array.isArray(card.data.detail.points) && card.data.detail.points.length === 2
          && Array.isArray(card.data.detail.forecasts) && card.data.detail.forecasts.length === 2
          && card.data.detail.land.length === 1
          && card.data.detail.forecasts[0].agency === '中国';
      },
    },
    {
      id: 'ty_005',
      name: '主源失败（网络错误）降级备源：返回备源列表文本',
      category: 'typhoon',
      run: async () => {
        const fetchImpl = buildMockFetch({
          TyhoonActivity: () => { throw new Error('network down'); },
          'v1.apizero.cn': () => jsonResp(BACKUP_LIST),
        });
        const r = await handleTyphoonQuery({}, { _fetchImpl: fetchImpl });
        return r.success && r.content.includes('活跃台风') && r.content.includes('浪卡');
      },
    },
    {
      id: 'ty_006',
      name: '双源均失败：返回可读错误（台风数据源暂不可用）',
      category: 'typhoon',
      run: async () => {
        const fetchImpl = buildMockFetch({
          TyhoonActivity: () => { throw new Error('network down'); },
          'v1.apizero.cn': () => { throw new Error('quota exceeded'); },
        });
        const r = await handleTyphoonQuery({ query: '浪卡' }, { _fetchImpl: fetchImpl });
        return !r.success && typeof r.error === 'string' && r.error.includes('台风数据源暂不可用');
      },
    },
    {
      id: 'ty_007',
      name: '空列表：返回空态文本 + 空态卡片（items 为空数组，前端可渲染）',
      category: 'typhoon',
      run: async () => {
        const fetchImpl = buildMockFetch({ TyhoonActivity: () => jsonResp([]) });
        const { getSceneStore } = require('../../src/core/scene/scene-store');
        const r = await handleTyphoonQuery({}, { _fetchImpl: fetchImpl, _surfaceId: 'typhoon-eval-empty' });
        if (!r.success || !r.content.includes('暂无活跃台风')) return false;
        const card = getSceneStore().getSurface('typhoon-eval-empty');
        return !!card && Array.isArray(card.data.items) && card.data.items.length === 0;
      },
    },
  ],
};
