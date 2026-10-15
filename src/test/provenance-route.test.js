/**
 * provenance-route.test.js — 数据出处链端点契约（2026-09-30，P2）
 *
 * 两层断言：
 *   1. 路由契约：GET /api/business/provenance 必须能解析到处理函数
 *      （前端按名字调用，路由漏接就是 404——本项目有过整页 404 的先例）
 *   2. 响应契约：ok:false 用 200 返回（业务上取不到数不是 HTTP 错误），
 *      且**必须带 unavailableReason**——前端要靠它区分"没有数据"与"取不到数据"
 */
const { resolveRoute } = require('../cli/request-handler');
const { handleBusinessProvenance, ALLOWED_METRICS } = require('../handlers/local-handlers/provenance-handler');

/** 假 res：捕获 sendJson 写出的状态码与 body */
function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    headersSent: false,
    writableEnded: false,
    writeHead(code) { res.statusCode = code; res.headersSent = true; return res },
    end(payload) { res.writableEnded = true; res.body = payload },
  };
  return res;
}

function parse(res) {
  try { return JSON.parse(res.body) } catch { return null }
}

describe('路由契约', () => {
  test('GET /api/business/provenance 解析到处理函数', () => {
    const h = resolveRoute('GET', '/api/business/provenance');
    expect(typeof h).toBe('function');
  })

  test('带 query 也能解析（正则锚定 $ 不吃 query 之外的内容）', () => {
    expect(typeof resolveRoute('GET', '/api/business/provenance')).toBe('function');
  })
})

describe('响应契约：诚实降级', () => {
  test('库不存在 → 200 + ok:false + unavailableReason（不是 500，也不是 rows:0）', async () => {
    // 通过未配置的库路径触发不可用分支
    const res = mockRes();
    await handleBusinessProvenance(
      { url: '/api/business/provenance?metric=revenue', headers: {} },
      res,
      {},
    );
    const body = parse(res);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toBeTruthy();
    expect(body.data.metric).toBe('revenue');
    // 本机可能真有数据也可能没有，但**若**取不到，必须给出原因
    if (!body.data.ok) {
      expect(body.data.unavailableReason).toBeTruthy();
      expect(body.data.rows).toBeNull();
    }
  })

  test('非法指标 → 400 + 可用指标清单（防任意串进查询）', async () => {
    const res = mockRes();
    await handleBusinessProvenance(
      { url: '/api/business/provenance?metric=; DROP TABLE x', headers: {} },
      res,
      {},
    );
    const body = parse(res);
    expect(res.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain('不支持的指标');
    for (const m of ALLOWED_METRICS) expect(body.error).toContain(m);
  })

  test('缺 metric → 默认 revenue（不报错，给最常用的）', async () => {
    const res = mockRes();
    await handleBusinessProvenance({ url: '/api/business/provenance', headers: {} }, res, {});
    const body = parse(res);
    expect(res.statusCode).toBe(200);
    expect(body.data.metric).toBe('revenue');
  })

  test('指标大小写不敏感（语音/手工输入常有大小写差异）', async () => {
    const res = mockRes();
    await handleBusinessProvenance({ url: '/api/business/provenance?metric=REVENUE', headers: {} }, res, {});
    const body = parse(res);
    expect(body.data.metric).toBe('revenue');
  })

  test('每个白名单指标都能安全调用（不抛、结构完整）', async () => {
    for (const metric of ALLOWED_METRICS) {
      const res = mockRes();
      await expect(handleBusinessProvenance(
        { url: `/api/business/provenance?metric=${metric}`, headers: {} }, res, {},
      )).resolves.toBeUndefined();
      const body = parse(res);
      expect(res.statusCode).toBe(200);
      expect(body.data.metric).toBe(metric);
      expect(Array.isArray(body.data.sources)).toBe(true);
      expect(Array.isArray(body.data.notes)).toBe(true);
    }
  })

  test('返回体含前端渲染所需字段（view/rows/nulls/sources/notes）', async () => {
    const res = mockRes();
    await handleBusinessProvenance({ url: '/api/business/provenance?metric=receivable', headers: {} }, res, {});
    const d = parse(res).data;
    expect(d).toHaveProperty('view');
    expect(d).toHaveProperty('rows');
    expect(d).toHaveProperty('nulls');
    expect(d).toHaveProperty('sources');
    expect(d).toHaveProperty('notes');
    expect(d).toHaveProperty('ok');
  })
})
