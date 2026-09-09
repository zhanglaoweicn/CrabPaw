/**
 * proactive-ack-route.test.js — "今日不再提醒"回传 HTTP 链路回归（2026-09-07）
 *
 * 实机：用户点通知卡"今日不再提醒"，告警仍全天每 30 分钟重复播报。
 * 排查：GUI 回传正常、ROUTE_TABLE 命中 handlePanelRoute、运行日志
 *   `POST /api/proactive/ack 404`（Panel Not Found）——请求进了 handlePanelApi
 *   却被入口守卫 `startsWith('/panels') || startsWith('/api/filegen')` 挡回 false，
 *   panel-handler 内的 ack 分支成死代码。服务层测试（risk-alert-ack.test.js）
 *   全绿但没测 HTTP 入口，此洞漏网。
 * 修复：守卫补放行 /api/proactive。本文件锁 HTTP 层——handlePanelApi 必须真实
 *   处理 ack 回传并落盘，守卫回归立刻红。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

// config 在 require 时读 CRABPAW_DATA_DIR——必须先于任何模块加载指向临时目录，
// 避免测试把确认状态写进真实数据目录
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'paw-ack-route-test-'));
process.env.CRABPAW_DATA_DIR = TMP_DATA_DIR;

const { EventEmitter } = require('events');
const { handlePanelApi } = require('../handlers/panel-handler');
const ackStore = require('../core/proactive/ack-store');

function mockReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  const res = { statusCode: 0, body: null, writeHead(code) { this.statusCode = code; }, end(text) { this.body = text; } };
  const p = handlePanelApi(req, res, url);
  if (body !== undefined) req.emit('data', JSON.stringify(body));
  req.emit('end');
  return { p, res };
}

describe('POST /api/proactive/ack HTTP 链路（守卫回归）', () => {
  afterEach(() => {
    ackStore._reset();
  });

  test('入口守卫放行 /api/proactive——ack 回传 200 且落盘当日确认', async () => {
    const TEXT = '注意：有 1 笔应收款已逾期，合计约 8,800 元。';
    const { p, res } = mockReq('POST', '/api/proactive/ack', { trigger: 'risk_alert', text: TEXT });
    const handled = await p;
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    // 服务层消费同一存储：risk-alert-service 下轮巡检据此跳过同内容告警
    expect(ackStore.isAckedToday('risk_alert', TEXT)).toBe(true);
  });

  test('缺 trigger/text → 200 success:false（参数校验仍可达）', async () => {
    const { p, res } = mockReq('POST', '/api/proactive/ack', { trigger: 'risk_alert' });
    const handled = await p;
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(false);
  });
});
