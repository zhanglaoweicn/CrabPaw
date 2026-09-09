/**
 * Train Tools — 12306 余票查询
 *
 * 站点码表：拉取 12306 station_name.js 解析并缓存；
 * 余票：GET /otn/leftTicket/query（失败优雅降级）。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { registry } = require('./registry');
const { getDataDir } = require('../core/config');

const STATION_JS_URL = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';
const QUERY_URL = 'https://kyfw.12306.cn/otn/leftTicket/query';
const CACHE_FILE = path.join(getDataDir(), 'station-codes.json');

/** 解析 `@拼音|中文名|电报码|...@...` 站点码表 */
function parseStationCodes(js) {
  const map = new Map();
  if (!js || typeof js !== 'string') return map;
  const body = js.slice(js.indexOf('@'));
  for (const part of body.split('@')) {
    if (!part) continue;
    const seg = part.split('|');
    if (seg.length >= 3 && seg[1] && seg[2]) map.set(seg[1], seg[2]);
  }
  return map;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...headers }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

/** 加载站点码表（磁盘缓存 + 远程拉取） */
async function loadStationCodes() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (raw && typeof raw === 'object' && Object.keys(raw).length > 100) return new Map(Object.entries(raw));
    }
    const res = await httpGet(STATION_JS_URL);
    if (res.status !== 200) throw new Error(`码表 HTTP ${res.status}`);
    const map = parseStationCodes(res.data);
    if (map.size > 100) {
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(map)), 'utf8');
      } catch (e) { console.warn('[train-tools] 码表缓存失败:', e.message || e); }
    }
    return map;
  } catch (e) {
    console.warn('[train-tools] 站点码表加载失败（降级为空表）:', e.message || e);
    return new Map();
  }
}

function parseSeats(p) {
  return [
    ['商务座', p[32]], ['一等座', p[31]], ['二等座', p[30]],
    ['软卧', p[23]], ['硬卧', p[28]], ['硬座', p[29]], ['无座', p[26]],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([name, count]) => ({ name, count: String(count) }));
}

async function queryTrainTickets({ from, to, date }) {
  const codes = await loadStationCodes();
  const fromCode = codes.get(from);
  const toCode = codes.get(to);
  if (!fromCode || !toCode) {
    return { success: false, error: `未找到站点编码（${!fromCode ? from : ''}${!toCode ? to : ''}），请检查站名或稍后重试` };
  }
  const url = `${QUERY_URL}?leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}&purpose_codes=ADULT`;
  const res = await httpGet(url, { Cookie: 'RAIL_EXPIRATION=0; RAIL_DEVICEID=0' });
  if (res.status !== 200) throw new Error(`12306 HTTP ${res.status}`);
  const body = JSON.parse(res.data);
  const rows = (body && body.data && body.data.result) || [];
  const trains = rows.slice(0, 20).map((row) => {
    const p = row.split('|');
    return {
      code: p[3], from: p[6], to: p[7], depart: p[8], arrive: p[9], duration: p[10],
      seats: parseSeats(p),
    };
  }).filter((t) => t.code && t.code !== 'null');
  return { success: true, trains, count: trains.length };
}

function formatTrainsSpeech(trains) {
  if (!trains || trains.length === 0) return '没有查到可用的车次，建议换一天或改用 12306 App 查看。';
  const top = trains.slice(0, 3);
  const parts = top.map((t) => {
    const seats = t.seats && t.seats.length ? t.seats.slice(0, 2).map((s) => `${s.name}${s.count === '有' ? '有票' : s.count === '无' ? '无票' : s.count + '张'}`).join('，') : '余票未知';
    return `${t.code}次 ${t.depart} 出发 ${t.arrive} 到达，${seats}`;
  });
  return `查到 ${trains.length} 班车次：${parts.join('；')}。要选哪一班？`;
}

// 2026-08-14: 车次结果卡发射——前端 kinds/travel.tsx 的 TravelCard 早已注册
// （kinds/index.tsx travel 条目），但此前后端无任何 surface 推送点
// （"卡片等人喂数据"断点）。TrainQuery 成功后发射 scene surface 'travel-card'。
// 懒加载 scene-store 避免循环依赖；失败不阻塞主流程。
function _publishTravelCard(trains, queryLabel) {
  try {
    const { getSceneStore } = require('../core/scene/scene-store');
    const store = getSceneStore();
    if (!store) return;
    store.upsertSurface('travel-card', {
      kind: 'travel',
      data: { trains, query: queryLabel },
      intent: 'inform',
    });
  } catch (e) {
    console.error('[train-tools] 车次卡片发射失败:', e.message || e);
  }
}

async function handleTrainQuery(params) {
  const { from, to, date } = params;
  if (!from || !to || !date) return { success: false, error: '需要 from/to/date 参数' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, error: 'date 格式须为 YYYY-MM-DD' };
  try {
    const result = await queryTrainTickets({ from, to, date });
    if (result.success) _publishTravelCard(result.trains, `${from} → ${to} · ${date}`);
    return result;
  } catch (e) {
    console.error('[train-tools] 余票查询失败:', e.message || e);
    return { success: false, error: '12306 查询失败，建议打开 12306 App 查看', degraded: true };
  }
}

registry.register({
  name: 'TrainQuery',
  toolset: 'travel',
  category: 'travel',
  description: '查询 12306 火车/高铁余票。输入中文站名与日期，返回车次/时刻/座位余票。',
  whenNotToUse: ['站名为英文或拼音时（请用中文站名）', '需要订票/支付时（本工具只查询）', '查询航班时（无航班数据）'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '出发站中文名（如：北京）' },
      to: { type: 'string', description: '到达站中文名（如：上海）' },
      date: { type: 'string', description: '乘车日期 YYYY-MM-DD' },
    },
    required: ['from', 'to', 'date'],
  },
  handler: handleTrainQuery,
  timeout: 30000,
  isReadOnly: true,
});

module.exports = { parseStationCodes, loadStationCodes, formatTrainsSpeech, queryTrainTickets, handleTrainQuery };
