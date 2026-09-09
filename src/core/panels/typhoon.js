/**
 * Typhoon Panel — 台风追踪数据模块（2026-08-14 二次修复）
 *
 * 数据源策略（数据诚实化纪律）：不再内置高仿真 demo 台风——改用
 * typhoon-tools 的真实双源降级链（浙江水利厅台风路径实时发布系统主源 +
 * apizero.cn 备源，AbortController 10s 超时），把真实活跃台风映射为面板
 * 数据结构。数据源全部失败时抛可读错误，由 ShowTyphoon 工具如实告知用户，
 * 绝不虚构台风/路径/登陆点。
 *
 * 面板数据模型（surface 'typhoon-panel' data，前端 TyphoonPanel 契约）：
 * { id, name, nameEn, level, levelCode, centerPressure, maxWindSpeed,
 *   moveDir, moveSpeed, position{lat,lon}|null, windRadii{r7,r10}|null,
 *   history[{time,lat,lon,level}], forecast[],
 *   landfall{time,place}|null, alerts[]（通用防御提示，非数据源内容）,
 *   warnLevel, updatedAt, disclaimer }
 */

// 60s 内存缓存——面板反复打开不重复打数据源（数据源 3-6 小时更新一次）
let _cache = { at: 0, data: null };
const CACHE_TTL_MS = 60 * 1000;

const LEVEL_CODE = {
  '热带低压': 7, '热带风暴': 9, '强热带风暴': 11, '台风': 13, '强台风': 15, '超强台风': 17,
};

// 通用防御提示（防台风常识，与具体台风无关，非数据源内容）
const GENERIC_ALERTS = [
  '沿海地区加固门窗、塔吊、广告牌等易坠物，收回阳台杂物',
  '海上作业船只回港避风，低洼地段防范内涝',
  '减少外出，远离海边、河口与高空作业区域',
];

/**
 * 风圈半径字符串 → 数值（公里）。真实数据为四象限字符串
 * （如 "260,240,230,280" 或 "NE:260;SE:240;..."），取均值近似为圆形半径；
 * 解析失败返回 null（前端隐藏风圈环）。
 */
function parseRadiusString(s) {
  if (typeof s !== 'string') return null;
  const nums = (s.match(/-?\d+(\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  if (nums.length === 0) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/**
 * 2026-08-15 P0: 四象限风圈半径数组 [NE, SE, SW, NW]（公里）。
 * 真实数据为四象限（东北/东南/西南/西北各不同）——圆形是损失信息的近似;
 * 前端画非对称风圈 + 左侧四象限数值表。不足 4 值按末值补齐, 解析失败 null。
 */
function parseQuadrantRadii(s) {
  if (typeof s !== 'string') return null;
  const nums = (s.match(/-?\d+(\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  if (nums.length === 0) return null;
  while (nums.length < 4) nums.push(nums[nums.length - 1]);
  return nums.slice(0, 4).map(Math.round);
}

function fmtPosition(lat, lng) {
  const parts = [];
  if (lng != null && !Number.isNaN(lng)) parts.push(`${lng >= 0 ? '东经' : '西经'}${Math.abs(lng).toFixed(1)}°`);
  if (lat != null && !Number.isNaN(lat)) parts.push(`${lat >= 0 ? '北纬' : '南纬'}${Math.abs(lat).toFixed(1)}°`);
  return parts.join('、');
}

/** 真实列表条目 + 详情（可为 null）→ 面板数据结构。
 *  @param {Array} [allItems] 2026-08-15 P1: 全部活跃台风列表(多台风切换 tab 数据源) */
function mapToPanelData(item, detail, allItems) {
  const d = detail || {};
  // 2026-08-26: 当前位置以最新路径点为准——实测源 centerlat/centerlng 明显滞后
  // （202618: center 22.8/141.0，而最新路径点 27.4/128.1，两点相距 ~1300km）。
  // 已存在点按时间取最新，与路径终点对齐（风圈/位置标记不再漂离路线）。
  const points = Array.isArray(d.points) ? d.points : [];
  let latest = null;
  for (const p of points) {
    if (!latest || String(p.time || '') >= String(latest.time || '')) latest = p;
  }
  const lat = latest && latest.lat != null ? Number(latest.lat) : (d.lat != null ? d.lat : item.lat);
  const lng = latest && latest.lng != null ? Number(latest.lng) : (d.lng != null ? d.lng : item.lng);
  const level = d.strong || item.strong || '';
  const r7 = parseRadiusString(d.radius7 || item.radius7);
  const r10 = parseRadiusString(d.radius10 || item.radius10);
  // 2026-08-15 P0: 四象限风圈(非对称画图 + 数值表)——真实数据本就四象限
  const q7 = parseQuadrantRadii(d.radius7 || item.radius7);
  const q10 = parseQuadrantRadii(d.radius10 || item.radius10);
  // 2026-08-15 理想面板: 雨圈/云图字段——数据源提供时透传(容忍常见字段名),
  // 不提供则 undefined(前端雨圈按风圈推算示意、云图图层缺省), 绝不编造
  const rainR = parseRadiusString(d.rainRadius || d.rain || d.rainCircle);
  const cloudUrl = (typeof d.cloudUrl === 'string' && d.cloudUrl)
    || (typeof d.satellite === 'string' && d.satellite)
    || undefined;
  const land = Array.isArray(d.land) ? d.land : [];
  const land0 = land[0] || null;
  // 2026-08-26: 官方预报路径点（中国机构优先）——源 current.forecast 实测带坐标，
  // 前端画虚线预报线路（与路径不脱节）。
  const forecastTrack = Array.isArray(d.forecastTrack) ? d.forecastTrack : [];

  return {
    id: String(item.tfid || ''),
    name: d.name || item.name || '',
    nameEn: d.enname || item.enname || '',
    level,
    levelCode: LEVEL_CODE[level] || 12,
    centerPressure: d.pressure != null ? Number(d.pressure) : (item.pressure != null ? Number(item.pressure) : null),
    maxWindSpeed: d.speed != null ? Number(d.speed) : (item.speed != null ? Number(item.speed) : null),
    moveDir: d.moveDir || item.moveDir || '',
    moveSpeed: d.moveSpeed != null ? Number(d.moveSpeed) : (item.moveSpeed != null ? Number(item.moveSpeed) : null),
    position: lat != null && lng != null ? { lat: Number(lat), lon: Number(lng) } : null,
    windRadii: r7 != null || r10 != null ? { r7, r10 } : null,
    // 2026-08-15 P0: 四象限风圈数组 [NE, SE, SW, NW](真实数据; 缺省 null 前端画圆)
    windQuadrants: q7 || q10 ? { r7: q7, r10: q10 } : null,
    rainRadius: rainR != null ? rainR : undefined,       // 真实雨圈(数据源提供时)
    cloudImageUrl: cloudUrl,                              // 真实云图 URL(数据源提供时)
    // 历史路径点来自数据源; 2026-08-16: 路径点带气压/风速/风圈半径——hover 标注用
    history: points.map(p => ({
      time: p.time || '',
      lat: p.lat != null ? Number(p.lat) : null,
      lon: p.lng != null ? Number(p.lng) : null,
      level: p.strong || '',
      pressure: p.pressure != null ? Number(p.pressure) : null,
      speed: p.speed != null ? Number(p.speed) : null,
      radius7: p.radius7 != null ? Number(p.radius7) : null,
      radius10: p.radius10 != null ? Number(p.radius10) : null,
    })),
    // 2026-08-26: 官方预报路径坐标(中国机构)透传——前端虚线线路与参考图同款
    forecast: forecastTrack.map(p => ({
      time: p.time || '',
      lat: p.lat != null ? Number(p.lat) : null,
      lon: p.lng != null ? Number(p.lng) : null,
      level: p.strong || '',
      pressure: p.pressure != null ? Number(p.pressure) : null,
      speed: p.speed != null ? Number(p.speed) : null,
    })),
    landfall: land0 ? { time: land0.time || '', place: fmtPosition(land0.lat, land0.lng) || '沿海地区' } : null,
    alerts: GENERIC_ALERTS,
    warnLevel: d.warnLevel || item.warnLevel || '',
    updatedAt: new Date().toISOString(),
    disclaimer: '台风信息以官方发布为准。',
    // 2026-08-15 P1: 机构预报对比(文字摘要, 数据源提供) + 多台风切换列表
    forecastAgencies: Array.isArray(d.forecasts) ? d.forecasts.map(f => ({
      agency: f.agency || '未知机构',
      summary: f.summary || `共 ${f.pointCount || 0} 个预报点`,
    })) : [],
    siblings: Array.isArray(allItems) ? allItems
      .filter(it => String(it.tfid) !== String(item.tfid))
      .map(it => ({ tfid: String(it.tfid || ''), name: it.name || '', level: it.strong || '', warnLevel: it.warnLevel || '' }))
      : [],
    currentTfid: String(item.tfid || ''),
  };
}

/**
 * 获取台风面板数据。主源/备源全部失败（或当前无活跃台风）时抛可读错误——
 * 调用方如实反馈，不返回任何虚构数据。
 * 2026-08-26: 返回结构增加 `tracks` 数组——每个活跃台风的完整面板数据
 * （同源同契约），前端同图渲染全部台风路径（用户参考同类台风地图：双台风+
 * 各带完整路径线）。主数据仍为选中台风（targetTfid 或默认选择）。
 * @param {object} [context] 可携带 _fetchImpl（eval 测试注入点，与 typhoon-tools 同款）
 * @param {boolean} [force] 2026-08-15: true=绕过 60s 缓存（面板手动刷新用）
 * @param {string} [targetTfid] 2026-08-15 P1: 指定台风编号(多台风切换 tab)
 */
async function getTyphoon(context, force = false, targetTfid = null) {
  const now = Date.now();
  const cacheKey = targetTfid || 'default';
  if (!force && _cache.data && now - _cache.at < CACHE_TTL_MS && _cache.key === cacheKey) return _cache.data;

  // 函数内懒加载：避免 panels → tools 的模块加载期循环依赖
  const { fetchActivityItems, fetchTyphoonDetail } = require('../../tools/typhoon-tools');
  // 2026-08-15 修复: context=null 时 `context && context._fetchImpl` 返回 null——
  // fetchJson 的默认参数(global.fetch)只在 undefined 时生效, 传 null 直接炸
  // "fetchImpl is not a function"(/panels/typhoon 端点实测)。用 ?. 归一为 undefined。
  const fetchImpl = context ? context._fetchImpl : undefined;

  const items = await fetchActivityItems(fetchImpl);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('当前暂无活跃台风。');
  }

  // 2026-08-26: 全部活跃台风详情并行拉取（每个失败不致命——列表字段兜底），
  // tracks 供前端同图渲染（双台风各有完整路径线/位置/风圈）。
  const detailMap = new Map();
  await Promise.all(items.map(async (it) => {
    try {
      detailMap.set(String(it.tfid), await fetchTyphoonDetail(it, fetchImpl));
    } catch (e) {
      console.warn(`[typhoon-panel] ${it.tfid} 详情获取失败，列表数据兜底:`, e.message || e);
    }
  }));

  // 2026-08-15 P1: 指定编号 → 优先该台风; 否则有预警的; 否则列表第一个
  const target = (targetTfid && items.find(it => String(it.tfid) === String(targetTfid)))
    || items.find(it => it.warnLevel)
    || items[0];

  const data = mapToPanelData(target, detailMap.get(String(target.tfid)) || null, items);
  // 2026-08-26: 全台风 tracks（含主台风自身; 主台风=已选台风，siblings 留存兼容）
  const tracks = items.map((it) => mapToPanelData(it, detailMap.get(String(it.tfid)) || null, items));
  data.tracks = tracks;
  _cache = { at: now, data, key: cacheKey };
  return data;
}

// ==================== 历史台风（2026-08-16 新增：历史入口） ====================
// 主源（浙江水利厅）只提供当前活跃台风；历史走 apizero status=all（实测 19 条
// 历年停编台风）。历史数据不变 → 60min 缓存；详情按 id 独立缓存。

const HISTORY_CACHE_TTL_MS = 60 * 60 * 1000;
let _historyListCache = { at: 0, data: null };
const _historyDetailCache = new Map();

/** 历史列表原始条目（apizero）→ 面板条目（供前端历史入口列表渲染） */
function mapHistoryListItem(it) {
  const state = it.state || '';
  return {
    id: String(it.id || ''),
    tcNum: String(it.tc_num || ''),
    name: it.name_cn || '',
    nameEn: it.name_en || '',
    state,                                    // 原文（stop/active…）
    isActive: !!it.is_active,
    // 中文状态标签（诚实映射，未知状态显示原文）
    stateLabel: state === 'stop' ? '已停编'
      : state === 'active' ? '活跃中'
      : state === 'cancel' ? '已取消'
      : state || '',
  };
}

/**
 * 历史详情（apizero）→ 面板数据契约（与 mapToPanelData 同款模型，前端 TyphoonData）。
 * 历史台风无风圈/四象限/预警/登陆点/机构预报 → 如实置空，绝不编造。
 * time_cst（"2026-08-01 20:00"）归一化为 ISO 格式（"2026-08-01T20:00"），
 * 与主源 time 一致，前端 label 切片统一处理。
 */
function mapHistoryDetailToPanelData(detail) {
  const cur = detail.current || {};
  const points = Array.isArray(detail.points) ? detail.points : [];
  const normTime = (t) => String(t || '').replace(' ', 'T');
  const level = cur.grade || (points.length > 0 ? (points[points.length - 1].grade || '') : '');
  const lat = cur.latitude != null ? Number(cur.latitude) : null;
  const lon = cur.longitude != null ? Number(cur.longitude) : null;
  // 按时间正序（数据源可能乱序，面板/地图按时间先后画路径）
  const sorted = points
    .filter(p => p.latitude != null && p.longitude != null)
    .sort((a, b) => String(a.time_cst || '').localeCompare(String(b.time_cst || '')));
  return {
    id: String(detail.tc_num || detail.id || ''),
    name: detail.name_cn || '',
    nameEn: detail.name_en || '',
    level,
    levelCode: LEVEL_CODE[level] || 12,
    centerPressure: cur.pressure != null ? Number(cur.pressure) : null,
    maxWindSpeed: cur.wind_speed != null ? Number(cur.wind_speed) : null,
    moveDir: cur.wind_dir || '',
    moveSpeed: null,                          // apizero 无移速
    position: lat != null && lon != null ? { lat, lon } : null,
    windRadii: null,                          // apizero 无风圈数据
    windQuadrants: null,
    rainRadius: undefined,
    cloudImageUrl: undefined,
    history: sorted.map(p => ({
      time: normTime(p.time_cst),
      lat: Number(p.latitude),
      lon: Number(p.longitude),
      level: p.grade || '',
      pressure: p.pressure != null ? Number(p.pressure) : null,
      // 双字段兼容：解析层已转 speed；直接喂原始 apizero 结构时读 wind_speed
      speed: p.speed != null ? Number(p.speed) : (p.wind_speed != null ? Number(p.wind_speed) : null),
    })),
    forecast: [],
    landfall: null,
    alerts: GENERIC_ALERTS,                   // 通用防御提示（非数据源内容）
    warnLevel: '',
    updatedAt: new Date().toISOString(),
    disclaimer: '历史台风信息来源于公开数据，仅供参考。',
    forecastAgencies: [],
    siblings: [],
    currentTfid: '',
    isHistory: true,                          // 前端识别历史视图
  };
}

/**
 * 历史台风列表（供前端历史入口）。
 * @param {object} [context] 可携带 _fetchImpl（测试注入点）
 * @param {boolean} [force] 绕过 60min 缓存
 */
async function getTyphoonHistory(context, force = false) {
  const now = Date.now();
  if (!force && _historyListCache.data && now - _historyListCache.at < HISTORY_CACHE_TTL_MS) {
    return _historyListCache.data;
  }
  const { fetchBackupHistoryList } = require('../../tools/typhoon-tools');
  const fetchImpl = context ? context._fetchImpl : undefined;
  try {
    const { list, total } = await fetchBackupHistoryList(fetchImpl);
    const data = {
      list: list.map(mapHistoryListItem),
      total,
      fetchedAt: now,
    };
    _historyListCache = { at: now, data };
    return data;
  } catch (e) {
    // 失败不缓存——下次请求自动重试（历史源不可用是暂时的，不污染数据）
    console.warn('[typhoon-panel] 历史台风列表获取失败:', e.message || e);
    throw new Error('历史台风数据源暂不可用，请稍后再试。');
  }
}

/**
 * 历史台风详情（供前端历史入口选择后渲染完整数据列 + 地图路径）。
 * @param {object} [context]
 * @param {string} id apizero 历史台风 id（列表条目中的 id 字段）
 * @param {boolean} [force]
 */
async function getTyphoonHistoryDetail(context, id, force = false) {
  if (!id) throw new Error('缺少历史台风 id。');
  const now = Date.now();
  const cached = _historyDetailCache.get(String(id));
  if (!force && cached && now - cached.at < HISTORY_CACHE_TTL_MS) return cached.data;
  const { fetchBackupHistoryDetail } = require('../../tools/typhoon-tools');
  const fetchImpl = context ? context._fetchImpl : undefined;
  try {
    const raw = await fetchBackupHistoryDetail(id, fetchImpl);
    const data = mapHistoryDetailToPanelData(raw);
    _historyDetailCache.set(String(id), { at: now, data });
    return data;
  } catch (e) {
    console.warn(`[typhoon-panel] 历史台风详情获取失败(${id}):`, e.message || e);
    throw new Error('历史台风详情获取失败，请稍后再试。');
  }
}

/** 终端渲染（ShowTyphoon 工具文本输出） */
function render(t) {
  const lines = [];
  lines.push(`🌀 台风 ${t.id ? t.id + '号' : ''}「${t.name}」${t.nameEn ? `（${t.nameEn}）` : ''}${t.level ? ` — ${t.level}` : ''}`);
  const statusBits = [];
  if (t.centerPressure != null) statusBits.push(`中心气压 ${t.centerPressure} hPa`);
  if (t.maxWindSpeed != null) statusBits.push(`最大风速 ${t.maxWindSpeed} m/s`);
  if (statusBits.length) lines.push(`   ${statusBits.join(' | ')}`);
  if (t.position) lines.push(`   位置 (${t.position.lat}°N, ${t.position.lon}°E)${t.moveDir ? ` | 向${t.moveDir}${t.moveSpeed != null ? ` ${t.moveSpeed} km/h` : ''}移动` : ''}`);
  if (t.landfall) lines.push(`   预计登陆: ${t.landfall.place} @ ${new Date(t.landfall.time).toLocaleString('zh-CN')}`);
  else lines.push('   登陆点: 暂无数据');
  if (t.warnLevel) lines.push(`   预警: ${t.warnLevel}`);
  if (t.history.length) lines.push(`   路径点: 共 ${t.history.length} 个（${t.history[0].time} 至 ${t.history[t.history.length - 1].time}）`);
  lines.push(t.disclaimer || '台风信息以官方发布为准。');
  return lines.join('\n');
}

class TyphoonPanel {
  getTyphoon(context) { return getTyphoon(context) }
  getTyphoonHistory(context, force) { return getTyphoonHistory(context, force) }
  getTyphoonHistoryDetail(context, id, force) { return getTyphoonHistoryDetail(context, id, force) }
  render(t) { return render(t) }
}

const globalTyphoonPanel = new TyphoonPanel()

module.exports = {
  globalTyphoonPanel, getTyphoon, getTyphoonHistory, getTyphoonHistoryDetail,
  render, mapToPanelData, mapHistoryListItem, mapHistoryDetailToPanelData,
  parseRadiusString, parseQuadrantRadii,
}
