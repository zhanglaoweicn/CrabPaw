/**
 * 台风查询工具 — 全链路（数据源 → 口语化文本 → 场景卡）
 *
 * 数据源（2026-08 已验证可用）：
 *   - 主源：浙江水利厅台风路径实时发布系统（政府公益，零鉴权，JSON 直出，3-6 小时更新）
 *       GET https://typhoon.slt.zj.gov.cn/Api/TyhoonActivity        （注意拼写：Activity 前漏了字母 p，照搬）
 *       GET https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo/{tfid}
 *   - 备源：apizero.cn  POST https://v1.apizero.cn/api/typhoon     （匿名 500 次/日）
 *       参数 action=list/detail、id、status=active、limit
 *   - 降级链：主源失败（网络/超时/非200/解析失败）→ 备源 → 明确可读错误
 *
 * 场景卡：查询成功后发射 scene surface 'typhoon'（kind 'typhoon'），
 * 前端 SceneShell kinds/typhoon.tsx 渲染（语音"有台风吗"即可看到卡片）。
 * 发射参考 stock-tools.js 的懒加载模式，失败不阻塞主流程。
 */

const { registry } = require('./registry');

const PRIMARY_LIST_URL = 'https://typhoon.slt.zj.gov.cn/Api/TyhoonActivity';
const PRIMARY_DETAIL_URL = 'https://typhoon.slt.zj.gov.cn/Api/TyphoonInfo/';
const BACKUP_URL = 'https://v1.apizero.cn/api/typhoon';
const FETCH_TIMEOUT_MS = 10000;
const DISCLAIMER = '台风信息以官方发布为准。';
const USER_FRIENDLY_ERROR = '台风数据源暂不可用，请稍后再试。';

// 预警等级 → 中文
const WARN_LEVEL_CN = {
  white: '白色预警',
  blue: '蓝色预警',
  yellow: '黄色预警',
  orange: '橙色预警',
  red: '红色预警',
};

// ==================== 基础 fetch（AbortController 10s 超时） ====================

/**
 * 解析本次调用使用的 fetch 实现：
 * 优先取 context._fetchImpl（eval 测试注入点，并发安全），否则用全局 fetch。
 * 生产路径 context 无此字段，行为与直接使用 global.fetch 完全一致。
 */
function resolveFetch(context) {
  if (context && typeof context._fetchImpl === 'function') return context._fetchImpl;
  return global.fetch;
}

async function fetchJson(url, options = {}, fetchImpl = global.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error('空响应');
    const json = JSON.parse(text);
    if (json === null || typeof json !== 'object') throw new Error('响应格式异常');
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`请求超时（${options.timeout || FETCH_TIMEOUT_MS}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 主源（浙江水利厅）解析 ====================

/** 活动列表项 → 卡片条目（字段与前端契约一致） */
function parseActivityItem(item) {
  return {
    tfid: item.tfid != null ? String(item.tfid) : '',
    name: item.name || '',
    enname: item.enname || '',
    lat: item.lat != null ? Number(item.lat) : null,
    lng: item.lng != null ? Number(item.lng) : null,
    strong: item.strong || '',
    power: item.power != null ? String(item.power) : '',
    pressure: item.pressure != null ? Number(item.pressure) : null,
    speed: item.speed != null ? Number(item.speed) : null,
    moveDir: item.movedirection || '',
    moveSpeed: item.movespeed != null ? Number(item.movespeed) : null,
    radius7: item.radius7 != null ? String(item.radius7) : '',
    radius10: item.radius10 != null ? String(item.radius10) : '',
    warnLevel: item.warnlevel || '',
  };
}

/** 单台风详情 → 详情对象（含路径点与机构预报摘要） */
function parsePrimaryDetail(detail) {
  if (!detail || typeof detail !== 'object') throw new Error('详情数据格式异常');
  const points = Array.isArray(detail.points) ? detail.points : [];
  // 当前状态取 points 中时间最新的一点（时间字符串可直接字典序比较）
  let current = null;
  for (const p of points) {
    if (!current || String(p.time || '') >= String(current.time || '')) current = p;
  }
  const land = Array.isArray(detail.land) ? detail.land : [];
  const forecasts = current && Array.isArray(current.forecast) ? current.forecast : [];
  return {
    name: detail.name || '',
    enname: detail.enname || '',
    strong: (current && current.strong) || '',
    power: current && current.power != null ? String(current.power) : '',
    pressure: current && current.pressure != null ? Number(current.pressure) : null,
    speed: current && current.speed != null ? Number(current.speed) : null,
    moveDir: (current && current.movedirection) || '',
    moveSpeed: current && current.movespeed != null ? Number(current.movespeed) : null,
    radius7: (current && current.radius7 != null) ? String(current.radius7) : '',
    radius10: (current && current.radius10 != null) ? String(current.radius10) : '',
    warnLevel: detail.warnlevel || (current && current.warnlevel) || '',
    lat: detail.centerlat != null ? Number(detail.centerlat) : (current && current.lat != null ? Number(current.lat) : null),
    lng: detail.centerlng != null ? Number(detail.centerlng) : (current && current.lng != null ? Number(current.lng) : null),
    land: land.map((l) => ({
      time: l.time || '',
      lat: l.lat != null ? Number(l.lat) : null,
      lng: l.lng != null ? Number(l.lng) : null,
    })),
    points: points.map((p) => ({
      time: p.time || '',
      lat: p.lat != null ? Number(p.lat) : null,
      lng: p.lng != null ? Number(p.lng) : null,
      strong: p.strong || '',
      pressure: p.pressure != null ? Number(p.pressure) : null,
      // 2026-08-16: 路径点级风速/风圈半径（源提供时透传——hover 影响范围圈用；缺则前端风速示意）
      speed: p.speed != null ? Number(p.speed) : null,
      radius7: p.radius7 != null ? Number(p.radius7) : null,
      radius10: p.radius10 != null ? Number(p.radius10) : null,
    })),
    forecasts: forecasts.map((f) => ({
      agency: f.tm || '未知机构',
      pointCount: Array.isArray(f.forecastpoints) ? f.forecastpoints.length : 0,
      summary: buildForecastSummary(f.forecastpoints),
    })),
    // 2026-08-26: 官方预报路径坐标——主源 current.forecast 实测带 lng/lat/time/strong
    // （此前注释"官方源不提供预报坐标"不实，前端可画虚线预报线路）。取中国机构优先，
    // 缺则首个；无预报点返回空数组。
    forecastTrack: (() => {
      const fc = forecasts.find((f) => String(f.tm || '').includes('中国')) || forecasts[0];
      if (!fc || !Array.isArray(fc.forecastpoints)) return [];
      return fc.forecastpoints.map((p) => ({
        time: p.time || '',
        lat: p.lat != null ? Number(p.lat) : null,
        lng: p.lng != null ? Number(p.lng) : null,
        strong: p.strong || '',
        pressure: p.pressure != null ? Number(p.pressure) : null,
        speed: p.speed != null ? Number(p.speed) : null,
      }));
    })(),
  };
}

/** 机构预报摘要：首个预报点 → 末个预报点（"08:00 于 141.7°E,21.8°N → 20:00 于 145.3°E,22.9°N"） */
function buildForecastSummary(forecastpoints) {
  if (!Array.isArray(forecastpoints) || forecastpoints.length === 0) return '';
  const first = forecastpoints[0];
  const last = forecastpoints[forecastpoints.length - 1];
  const fmtPoint = (p) => {
    const pos = [];
    if (p.lng != null) pos.push(`${Number(p.lng)}°E`);
    if (p.lat != null) pos.push(`${Number(p.lat)}°N`);
    return pos.join(',');
  };
  const parts = [];
  if (first && first.time) parts.push(`${String(first.time).slice(5, 16)} 于 ${fmtPoint(first)}`);
  if (last && last !== first && last.time) parts.push(`${String(last.time).slice(5, 16)} 至 ${fmtPoint(last)}`);
  return parts.join(' → ');
}

// ==================== 备源（apizero.cn）解析 ====================

/** 备源活动列表 → 卡片条目（缺的强度/位置字段留空，由文本兜底说明） */
function parseBackupList(data) {
  const typhoons = data && Array.isArray(data.typhoons) ? data.typhoons : [];
  if (typhoons.length === 0) throw new Error('备源返回空列表');
  return typhoons.map((t) => ({
    tfid: String(t.tc_num || t.id || ''),
    backupId: String(t.id || ''),
    name: t.name_cn || '',
    enname: t.name_en || '',
    lat: null,
    lng: null,
    strong: '',
    power: '',
    pressure: null,
    speed: null,
    moveDir: '',
    moveSpeed: null,
    radius7: '',
    radius10: '',
    warnLevel: '',
  }));
}

/** 备源单台风详情 → 详情对象 */
function parseBackupDetail(data) {
  if (!data || typeof data !== 'object') throw new Error('备源详情格式异常');
  const cur = data.current || {};
  const points = Array.isArray(data.points) ? data.points : [];
  return {
    name: data.name_cn || '',
    enname: data.name_en || '',
    strong: cur.grade || '',
    power: '',
    pressure: cur.pressure != null ? Number(cur.pressure) : null,
    speed: cur.wind_speed != null ? Number(cur.wind_speed) : null,
    moveDir: cur.wind_dir || '',
    moveSpeed: null,
    radius7: '',
    radius10: '',
    warnLevel: '',
    lat: cur.latitude != null ? Number(cur.latitude) : null,
    lng: cur.longitude != null ? Number(cur.longitude) : null,
    land: [],
    points: points.map((p) => ({
      time: p.time_cst || p.time_utc || '',
      lat: p.latitude != null ? Number(p.latitude) : null,
      lng: p.longitude != null ? Number(p.longitude) : null,
      strong: p.grade || '',
      pressure: p.pressure != null ? Number(p.pressure) : null,
      // 2026-08-16: apizero 路径点实测带 wind_speed/wind_dir——透传供 hover 风力标注
      speed: p.wind_speed != null ? Number(p.wind_speed) : null,
      windDir: p.wind_dir || '',
    })),
    forecasts: [],
    forecastTrack: [],
  };
}

// ==================== 数据获取（双源降级链） ====================

async function fetchPrimaryActivity(fetchImpl) {
  const list = await fetchJson(PRIMARY_LIST_URL, {}, fetchImpl);
  if (!Array.isArray(list)) throw new Error('主源列表格式异常');
  return list.map(parseActivityItem);
}

async function fetchBackupActivity(fetchImpl) {
  const json = await fetchJson(BACKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', status: 'active', limit: 20 }),
  }, fetchImpl);
  if (json.code !== 0) throw new Error(`备源返回错误: ${json.msg || json.code}`);
  return parseBackupList(json.data);
}

/** 活跃台风列表：主源 → 备源 → 抛可读错误（调用方已记录详细日志） */
async function fetchActivityItems(fetchImpl) {
  const errors = [];
  try {
    return await fetchPrimaryActivity(fetchImpl);
  } catch (e) {
    errors.push(`主源: ${e.message}`);
    console.error('[typhoon-tools] 主源列表获取失败，尝试备源:', e.message || e);
  }
  try {
    return await fetchBackupActivity(fetchImpl);
  } catch (e) {
    errors.push(`备源: ${e.message}`);
    console.error('[typhoon-tools] 备源列表获取失败:', e.message || e);
  }
  throw new Error(USER_FRIENDLY_ERROR + `（${errors.join('；')}）`);
}

async function fetchPrimaryDetail(tfid, fetchImpl) {
  const json = await fetchJson(PRIMARY_DETAIL_URL + tfid, {}, fetchImpl);
  return parsePrimaryDetail(json);
}

async function fetchBackupDetail(backupId, fetchImpl) {
  const json = await fetchJson(BACKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'detail', id: backupId }),
  }, fetchImpl);
  if (json.code !== 0) throw new Error(`备源详情返回错误: ${json.msg || json.code}`);
  return parseBackupDetail(json.data);
}

// ==================== 历史台风（apizero status=all；主源无历史端点） ====================
// 2026-08-16: 历史台风入口——apizero 备源 status='all' 可列出历年停编台风
// （实测 19 条，tc_num 如 "20260015"），action='detail' 返回完整路径点
// （points[] 含 grade/经纬度/气压，与活跃台风同构）。主源（浙江水利厅）只
// 提供当前活跃，历史统一走 apizero。

/** 历史台风列表（apizero status=all，limit 50）→ { list, total } */
async function fetchBackupHistoryList(fetchImpl) {
  const json = await fetchJson(BACKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', status: 'all', limit: 50 }),
  }, fetchImpl);
  if (json.code !== 0) throw new Error(`备源返回错误: ${json.msg || json.code}`);
  const data = json.data || {};
  const typhoons = Array.isArray(data.typhoons) ? data.typhoons : [];
  if (typhoons.length === 0) throw new Error('历史台风列表为空');
  return { list: typhoons, total: data.total_count || typhoons.length };
}

/** 历史台风详情（apizero action=detail）→ 原始 data（由面板层归一化） */
async function fetchBackupHistoryDetail(id, fetchImpl) {
  const json = await fetchJson(BACKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'detail', id: String(id) }),
  }, fetchImpl);
  if (json.code !== 0) throw new Error(`备源返回错误: ${json.msg || json.code}`);
  if (!json.data || typeof json.data !== 'object') throw new Error('备源历史详情格式异常');
  return json.data;
}

/** 单台风详情：主源 → 备源 → 抛可读错误 */
async function fetchTyphoonDetail(item, fetchImpl) {
  const errors = [];
  try {
    return await fetchPrimaryDetail(item.tfid, fetchImpl);
  } catch (e) {
    errors.push(`主源: ${e.message}`);
    console.error(`[typhoon-tools] 主源详情获取失败（${item.tfid}），尝试备源:`, e.message || e);
  }
  if (item.backupId) {
    try {
      return await fetchBackupDetail(item.backupId, fetchImpl);
    } catch (e) {
      errors.push(`备源: ${e.message}`);
      console.error('[typhoon-tools] 备源详情获取失败:', e.message || e);
    }
  }
  throw new Error(USER_FRIENDLY_ERROR + `（${errors.join('；')}）`);
}

// ==================== 口语化文本 ====================

function warnLevelText(warnLevel) {
  if (!warnLevel) return '';
  return `，当前${WARN_LEVEL_CN[warnLevel] || warnLevel}`;
}

function formatPosition(lat, lng) {
  const parts = [];
  if (lng != null && !Number.isNaN(lng)) parts.push(`${lng >= 0 ? '东经' : '西经'}${Math.abs(lng).toFixed(1)}°`);
  if (lat != null && !Number.isNaN(lat)) parts.push(`${lat >= 0 ? '北纬' : '南纬'}${Math.abs(lat).toFixed(1)}°`);
  return parts.join('、');
}

function buildListText(items) {
  const lines = [];
  lines.push(`当前共有 ${items.length} 个活跃台风：`);
  items.forEach((it, i) => {
    const bits = [];
    if (it.strong) bits.push(it.strong);
    if (it.power) bits.push(`${it.power}级`);
    if (it.pressure) bits.push(`中心气压 ${it.pressure} 百帕`);
    if (it.speed) bits.push(`最大风速 ${it.speed} 米/秒`);
    const pos = formatPosition(it.lat, it.lng);
    if (pos) bits.push(`位于${pos}`);
    if (it.moveDir) {
      const speedPart = it.moveSpeed ? `（时速 ${it.moveSpeed} 公里）` : '';
      bits.push(`向${it.moveDir}方向移动${speedPart}`);
    }
    const warn = warnLevelText(it.warnLevel);
    lines.push(`${i + 1}. ${it.name}${it.enname ? `（${it.enname}，编号 ${it.tfid}）` : `（编号 ${it.tfid}）`}${bits.length ? `：${bits.join('，')}` : ''}${warn}`);
  });
  return lines.join('\n');
}

function buildDetailText(detail) {
  const lines = [];
  const idPart = detail.tfid ? `，编号 ${detail.tfid}` : '';
  const namePart = detail.enname ? `（${detail.enname}${idPart}）` : (detail.tfid ? `（编号 ${detail.tfid}）` : '');
  lines.push(`台风「${detail.name}」${namePart}`);
  const statusBits = [];
  if (detail.strong) statusBits.push(detail.strong);
  if (detail.power) statusBits.push(`${detail.power}级`);
  if (detail.pressure) statusBits.push(`中心气压 ${detail.pressure} 百帕`);
  if (detail.speed) statusBits.push(`最大风速 ${detail.speed} 米/秒`);
  if (statusBits.length) lines.push(`当前状态：${statusBits.join('，')}`);
  const pos = formatPosition(detail.lat, detail.lng);
  if (pos) lines.push(`当前位置：${pos}`);
  const moveBits = [];
  if (detail.moveDir) moveBits.push(`向${detail.moveDir}方向移动`);
  if (detail.moveSpeed) moveBits.push(`移动速度 ${detail.moveSpeed} 公里/小时`);
  if (moveBits.length) lines.push(`移动情况：${moveBits.join('，')}`);
  if (detail.radius7) lines.push(`7级风圈半径（四象限）：${detail.radius7} 公里`);
  if (detail.radius10) lines.push(`10级风圈半径（四象限）：${detail.radius10} 公里`);
  const warn = warnLevelText(detail.warnLevel);
  if (warn) lines.push(`预警等级：${warn.replace(/^，当前/, '')}`);
  if (Array.isArray(detail.points) && detail.points.length) {
    lines.push(`历史路径点：共 ${detail.points.length} 个（${detail.points[0].time} 至 ${detail.points[detail.points.length - 1].time}）`);
  }
  if (detail.land && detail.land.length) {
    lines.push(`登陆点：${detail.land.map((l) => `${l.time} ${formatPosition(l.lat, l.lng)}`).join('；')}`);
  } else {
    lines.push('登陆点：暂无');
  }
  if (detail.forecasts && detail.forecasts.length) {
    lines.push(`机构预报（${detail.forecasts.length} 家）：`);
    detail.forecasts.forEach((f) => {
      lines.push(`  - ${f.agency}：${f.summary || `共 ${f.pointCount} 个预报点`}`);
    });
  }
  return lines.join('\n');
}

// ==================== 场景卡发射 ====================

/**
 * 把卡片数据发射到 SceneStore（懒加载避免循环依赖；失败不阻塞主流程）。
 * @param {object} cardData 卡片数据 { items, detail? }
 * @param {string} [surfaceId='typhoon'] surface id；eval 测试可传独立 id 隔离并发用例
 */
function _publishTyphoonCard(cardData, surfaceId = 'typhoon') {
  try {
    const { getSceneStore } = require('../core/scene/scene-store');
    const store = getSceneStore();
    if (!store) return;
    store.upsertSurface(surfaceId, {
      kind: 'typhoon',
      data: cardData,
      intent: 'inform',
    });
  } catch (e) {
    console.error('[typhoon-tools] 台风卡片发射失败:', e.message || e);
  }
}

/** 剔除内部字段（backupId）后作为卡片 items 下发 */
function toCardItems(items) {
  return items.map((it) => {
    const { backupId, ...rest } = it; // eslint-disable-line no-unused-vars
    return rest;
  });
}

// ==================== 主处理 ====================

async function handleTyphoonQuery(params, context) {
  const query = String(params.query || '').trim();
  const fetchImpl = resolveFetch(context);
  const surfaceId = context && context._surfaceId ? context._surfaceId : 'typhoon';
  try {
    const items = await fetchActivityItems(fetchImpl);

    // 无活跃台风
    if (items.length === 0) {
      const content = `当前暂无活跃台风。\n${DISCLAIMER}`;
      if (!context?.isPrefetch) _publishTyphoonCard({ items: [] }, surfaceId);
      return { success: true, content };
    }

    // 空查询 → 列出全部活跃台风
    if (!query) {
      const content = `${buildListText(items)}\n${DISCLAIMER}`;
      if (!context?.isPrefetch) _publishTyphoonCard({ items: toCardItems(items) }, surfaceId);
      return { success: true, content };
    }

    // 按名称/英文名/编号匹配
    const q = query.toLowerCase();
    const hit = items.find((it) =>
      it.tfid === query
      || (it.name && it.name.toLowerCase().includes(q))
      || (it.enname && it.enname.toLowerCase().includes(q))
    );

    if (hit) {
      let detail = null;
      let detailErr = null;
      try {
        detail = await fetchTyphoonDetail(hit, fetchImpl);
      } catch (e) {
        detailErr = e.message || e;
        console.error('[typhoon-tools] 详情获取失败，降级为列表文本:', detailErr);
      }
      if (detail) {
        const cardDetail = { ...detail, tfid: hit.tfid };
        const content = `${buildDetailText(cardDetail)}\n${DISCLAIMER}`;
        if (!context?.isPrefetch) _publishTyphoonCard({ items: toCardItems(items), detail: cardDetail }, surfaceId);
        return { success: true, content };
      }
      const content = `${buildListText(items)}\n\n未找到「${query}」的详细路径数据（${detailErr}），以上为当前全部活跃台风。\n${DISCLAIMER}`;
      if (!context?.isPrefetch) _publishTyphoonCard({ items: toCardItems(items) }, surfaceId);
      return { success: true, content };
    }

    // 未匹配 → 列出全部活跃台风并提示
    const content = `${buildListText(items)}\n\n未找到「${query}」相关的活跃台风，以上为当前全部活跃台风。\n${DISCLAIMER}`;
    if (!context?.isPrefetch) _publishTyphoonCard({ items: toCardItems(items) }, surfaceId);
    return { success: true, content };
  } catch (e) {
    console.error('[typhoon-tools] 台风查询失败:', e.message || e);
    return { success: false, error: USER_FRIENDLY_ERROR };
  }
}

// ==================== 工具注册 ====================

registry.register({
  name: 'TyphoonQuery',
  toolset: 'web',
  category: 'information',
  description: '查询当前活跃台风及其路径、强度、预警信息，返回文本列表或单台风详情。参数 query 可传台风中文名/英文名/编号（如"202617"），留空则列出全部活跃台风。返回：活跃台风列表（数量/名称/编号/强度/当前位置/预警），或单台风详情（当前位置/强度/气压/风速/移向移速/风圈/登陆点/机构预报）。数据源为政府公益发布系统，失败自动降级备用数据源。当用户询问台风时，优先调用 ShowTyphoon 展示台风追踪面板（轨迹地图+风圈），本工具作为文本兜底。',
  schema: {
    description: '查询当前活跃台风信息（列表或单台风详情）',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '台风中文名/英文名或编号（如"浪卡"、"NANGKA"、"202617"），留空则列出全部活跃台风'
        }
      },
      required: []
    }
  },
  handler: handleTyphoonQuery,
  checkFn: () => true,
  timeout: 20000,
  isReadOnly: true,
  isDangerous: false,
  whenNotToUse: ['查询普通天气预报时（用天气工具）', '需要台风路径可视化地图/面板展示时（用 ShowTyphoon）', '关闭台风面板时（用 ShowTyphoon action=hide）'],
  riskLevel: 'low',
});

console.log('✅ 台风查询工具已注册 (TyphoonQuery: 双源降级 + 场景卡)');

module.exports = {
  handleTyphoonQuery,
  parseActivityItem,
  parsePrimaryDetail,
  parseBackupList,
  parseBackupDetail,
  buildListText,
  buildDetailText,
  fetchActivityItems,
  fetchTyphoonDetail,
  fetchBackupHistoryList,
  fetchBackupHistoryDetail,
  _publishTyphoonCard,
  resolveFetch,
};
