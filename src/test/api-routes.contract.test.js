/**
 * API 路由契约测试
 *
 * 防止回归：前端 Automation / Settings / SearchSection 页面依赖的 /api/* 端点
 * 必须在后端路由表中可解析。此前 Automation 页面所有 /api/tasks/* 与
 * /api/schedules 调用均 404（路由未接线），本测试锁定修复结果。
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { resolveRoute, LOCAL_HANDLERS } = require('../cli/request-handler');
const { createMCPHandlers } = require('../cli/handlers/mcp-handlers');
const collab = require('../core/experts/collaboration');

describe('API 路由契约（前端依赖端点必须可解析）', () => {
  // 辅助：断言某 (method, pathname) 解析到非空 handler 函数
  function expectRoute(method, pathname) {
    const handler = resolveRoute(method, pathname);
    expect(handler).toBeTruthy();
    expect(typeof handler).toBe('function');
    return handler;
  }

  describe('/api/schedules 别名（Automation 任务 CRUD）', () => {
    test('GET /api/schedules 解析到 handleSchedules', () => {
      expectRoute('GET', '/api/schedules');
    });
    test('POST /api/schedules 解析', () => {
      expectRoute('POST', '/api/schedules');
    });
    test('PATCH /api/schedules/:taskId 解析', () => {
      expectRoute('PATCH', '/api/schedules/tsk_123');
    });
    test('DELETE /api/schedules/:taskId 解析', () => {
      expectRoute('DELETE', '/api/schedules/tsk_123');
    });
  });

  describe('/api/tasks/* 增强端点（Automation 页面）', () => {
    test('GET /api/tasks/templates 解析', () => {
      expectRoute('GET', '/api/tasks/templates');
    });
    test('GET /api/tasks/history 解析', () => {
      expectRoute('GET', '/api/tasks/history');
    });
    test('GET /api/tasks/workflows 解析', () => {
      expectRoute('GET', '/api/tasks/workflows');
    });
    test('GET /api/tasks/versions/:taskId 解析', () => {
      expectRoute('GET', '/api/tasks/versions/tsk_abc');
    });
    test('POST /api/tasks/cancel 解析', () => {
      expectRoute('POST', '/api/tasks/cancel');
    });
  });

  describe('既有路由无回归', () => {
    test('GET /schedules 仍可解析（原始别名保留）', () => {
      expectRoute('GET', '/schedules');
    });
    test('GET /tasks/history 仍可解析', () => {
      expectRoute('GET', '/tasks/history');
    });
    // 2026-08-27: 原 GET /api/news/sources 断言随 RSS 资讯链移除(ef4cad5)一并删除——
    // 前端已无此调用, 保留会导致契约测试恒红(端点与调用都已不存在)。

    test('GET /api/profiles/:id/diff 仍可解析（Settings）', () => {
      expectRoute('GET', '/api/profiles/default/diff');
    });
    test('GET /api/profiles/:id/export 仍可解析（Settings）', () => {
      expectRoute('GET', '/api/profiles/default/export');
    });
  });

  // 2026-08-01: ExpertsPanel 端点契约（此前 /api/experts/* 不在路由测试中，
  // handler 意外移除会导致 GUI 404 无测试拦截）
  describe('/api/experts/*（ExpertsPanel）', () => {
    test('GET /api/experts 可解析', () => {
      expectRoute('GET', '/api/experts');
    });
    test('GET /api/experts/:id 可解析', () => {
      expectRoute('GET', '/api/experts/default');
    });
    test('POST /api/experts 可解析（创建）', () => {
      expectRoute('POST', '/api/experts');
    });
    test('PUT /api/experts/:id 可解析（更新）', () => {
      expectRoute('PUT', '/api/experts/default');
    });
    test('DELETE /api/experts/:id 可解析', () => {
      expectRoute('DELETE', '/api/experts/default');
    });
    test('POST /api/experts/route 可解析（消息路由）', () => {
      expectRoute('POST', '/api/experts/route');
    });
    test('POST /api/experts/chain 可解析（协作链推荐）', () => {
      expectRoute('POST', '/api/experts/chain');
    });
    test('POST /api/experts/session 可解析（会话记录）', () => {
      expectRoute('POST', '/api/experts/session');
    });
    test('GET /api/experts/categories 可解析', () => {
      expectRoute('GET', '/api/experts/categories');
    });
  });

  describe('handleApiTaskVersions 路径改写正确性', () => {
    test('GET /api/tasks/versions/:id 解析的 handler 应为 versions 包装器', () => {
      const handler = resolveRoute('GET', '/api/tasks/versions/tsk_x');
      // 包装器名为 handleApiTaskVersions
      expect(handler.name).toBe('handleApiTaskVersions');
    });
    test('GET /api/tasks/templates 解析的 handler 应为 templates 委派', () => {
      const handler = resolveRoute('GET', '/api/tasks/templates');
      expect(handler.name).toBe('handleApiTaskTemplates');
    });
    test('GET /api/tasks/workflows 解析的 handler 应为空状态返回器', () => {
      const handler = resolveRoute('GET', '/api/tasks/workflows');
      expect(handler.name).toBe('handleApiTaskWorkflows');
    });
  });

  describe('CrabPaw 路由审计新增本地 handler', () => {
    test('GET /stats resolves', () => {
      expectRoute('GET', '/stats');
    });
    test('GET /errors resolves', () => {
      expectRoute('GET', '/errors');
    });
    test('GET /commands resolves', () => {
      expectRoute('GET', '/commands');
    });
    test('GET /api/health/status resolves', () => {
      expectRoute('GET', '/api/health/status');
    });
    test('GET /api/health/history resolves', () => {
      expectRoute('GET', '/api/health/history');
    });
    test('GET /api/perf resolves', () => {
      expectRoute('GET', '/api/perf');
    });
    test('GET /api/diag-report resolves', () => {
      expectRoute('GET', '/api/diag-report');
    });
    test('GET /api/perception/status resolves', () => {
      expectRoute('GET', '/api/perception/status');
    });
    test('GET /api/sandbox/status resolves', () => {
      expectRoute('GET', '/api/sandbox/status');
    });
    test('POST /api/kg/evolve resolves', () => {
      expectRoute('POST', '/api/kg/evolve');
    });
    test('POST /api/tools/TextToSpeech resolves', () => {
      expectRoute('POST', '/api/tools/TextToSpeech');
    });
    test('GET /api/tasks/evolution/status resolves', () => {
      expectRoute('GET', '/api/tasks/evolution/status');
    });
    test('GET /api/cache/stats resolves', () => {
      expectRoute('GET', '/api/cache/stats');
    });
  });
});

// ─── G1 服务端请求上下文契约（2026-08-13 审计修复）────────────────────────
// 审计发现 ctx.parsedBody / req.body / ctx.query / ctx.pathname 从未被赋值，
// 导致 MCP 写操作 / collab / config-versions 恒 400/404/500。
// 本组测试锁定修复：body 统一走 readJsonBody(req)，query/pathname 由 ctx getter 提供。

function mockRes() {
  const r = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: '',
    writeHead(code) { r.statusCode = code; },
    end(d) { r.body = d; r.writableEnded = true; },
    json() { try { return JSON.parse(r.body); } catch (e) { return null; } },
  };
  return r;
}

// 模拟带 JSON body 的 POST 请求：handler 内 readJsonBody 同步注册监听后，由 _feed 触发 data/end
function reqWithBody(json, url = '/') {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = url;
  req.headers = {};
  req._feed = () => {
    req.emit('data', Buffer.from(JSON.stringify(json)));
    req.emit('end');
  };
  return req;
}

function makeStubSendJson() {
  const calls = [];
  const fn = (res, status, data) => { calls.push({ status, data }); return data; };
  fn.calls = calls;
  return fn;
}

describe('G1 服务端请求上下文契约（MCP/collab/config-versions body 修复）', () => {
  function expectRoute(method, pathname) {
    const handler = resolveRoute(method, pathname);
    expect(handler).toBeTruthy();
    expect(typeof handler).toBe('function');
    return handler;
  }

  describe('路由解析', () => {
    test('POST /api/mcp/servers/add 解析到 handleMCPServerAdd', () => {
      expect(expectRoute('POST', '/api/mcp/servers/add').name).toBe('handleMCPServerAdd');
    });
    test('POST /api/experts/collab/start 解析', () => {
      expectRoute('POST', '/api/experts/collab/start');
    });
    test('GET /api/experts/collab/status 解析', () => {
      expectRoute('GET', '/api/experts/collab/status');
    });
    test('GET /api/experts/activity 解析', () => {
      expectRoute('GET', '/api/experts/activity');
    });
    test('POST /api/experts/activity 解析', () => {
      expectRoute('POST', '/api/experts/activity');
    });
    test('POST /api/config-versions 解析', () => {
      expectRoute('POST', '/api/config-versions');
    });
    test('POST /api/request/cancel 解析', () => {
      expectRoute('POST', '/api/request/cancel');
    });
  });

  describe('MCP 写操作 body 解析', () => {
    test('add server 经 readJsonBody 解析 body（name 被取出，走 command/url 校验）', async () => {
      const stub = makeStubSendJson();
      const handlers = createMCPHandlers(stub);
      const req = reqWithBody({ name: 'x-only' });
      const p = handlers.handleMCPServerAdd(req, {}, {});
      req._feed();
      await p;
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0].status).toBe(400);
      // 若 body 未解析，name 为空会返回「缺少服务器名称」；能走到 command/url 校验证明解析成功
      expect(stub.calls[0].data.message).toContain('command');
    });

    test('空 body 优雅降级为 400（不崩溃、不静默）', async () => {
      const stub = makeStubSendJson();
      const handlers = createMCPHandlers(stub);
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/';
      req.headers = {};
      const p = handlers.handleMCPServerAdd(req, {}, {});
      req.emit('end');
      await p;
      expect(stub.calls[0].status).toBe(400);
      expect(stub.calls[0].data.message).toBe('缺少服务器名称');
    });

    test('mcp-handlers 源码不再引用 ctx.parsedBody', () => {
      const src = fs.readFileSync(path.join(__dirname, '../cli/handlers/mcp-handlers.js'), 'utf8');
      expect(src).not.toContain('ctx.parsedBody');
    });
  });

  describe('ctx query/pathname getter', () => {
    test('request-handler ctx 组装包含 query/pathname getter（防回归删除）', () => {
      const src = fs.readFileSync(path.join(__dirname, '../cli/request-handler.js'), 'utf8');
      expect(src).toMatch(/get query\(\) \{ return Object\.fromEntries\(this\.url\.searchParams\.entries\(\)\); \}/);
      expect(src).toMatch(/get pathname\(\) \{ return this\.url\.pathname; \}/);
    });

    test('collab status 经 ctx.query 取 id', async () => {
      const orig = collab.getCollabStatus;
      let capturedId = null;
      collab.getCollabStatus = (id) => { capturedId = id; return { id, status: 'running' }; };
      try {
        const res = mockRes();
        const url = new URL('http://localhost/api/experts/collab/status?id=collab_42');
        const ctx = {
          url,
          get query() { return Object.fromEntries(this.url.searchParams.entries()); },
        };
        await LOCAL_HANDLERS.handleCollabStatus({ method: 'GET', url: url.pathname + '?id=collab_42', headers: {} }, res, ctx);
        expect(capturedId).toBe('collab_42');
        expect(res.json().success).toBe(true);
        // 2026-08-13(Task3 遗留A): 响应必须包 data 键(GUI getCollabStatus 读 res.data)
        expect(res.json().data).toEqual({ id: 'collab_42', status: 'running' });
      } finally {
        collab.getCollabStatus = orig;
      }
    });
  });

  describe('collab / config-versions / activity', () => {
    test('collab start 经 readJsonBody 传递 goal/tasks', async () => {
      const orig = collab.startCollaboration;
      let captured = null;
      collab.startCollaboration = async (params) => { captured = params; return { collabId: 'collab_test', tasks: [] }; };
      try {
        const res = mockRes();
        const req = reqWithBody({ goal: 'g1', tasks: [{ expertId: 'a', prompt: 'p' }, { expertId: 'b', prompt: 'q' }] });
        const p = LOCAL_HANDLERS.handleCollabStart(req, res, {});
        req._feed();
        await p;
        expect(captured).toBeTruthy();
        expect(captured.goal).toBe('g1');
        expect(captured.tasks.length).toBe(2);
        expect(res.json().success).toBe(true);
        // 2026-08-13(Task3 遗留A): 响应必须包 data 键(GUI startCollab 读 res.data.collabId)
        expect(res.json().data).toEqual({ collabId: 'collab_test', tasks: [] });
      } finally {
        collab.startCollaboration = orig;
      }
    });

    test('config-versions POST 解析 body.action', async () => {
      const res = mockRes();
      const req = reqWithBody({ action: 'zzz' });
      const p = LOCAL_HANDLERS.handleConfigVersions(req, res, {});
      req._feed();
      await p;
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('未知 action: zzz');
    });

    test('activity GET 返回 data 数组并透传 limit（G3）', async () => {
      const orig = collab.getActivities;
      let capturedLimit = null;
      collab.getActivities = (lim) => { capturedLimit = lim; return [{ id: 'a1', type: 'x', content: 'y', ts: 1 }]; };
      try {
        const res = mockRes();
        await LOCAL_HANDLERS.handleExpertActivityGet({ method: 'GET', url: '/api/experts/activity?limit=7', headers: {} }, res, {});
        const body = res.json();
        expect(capturedLimit).toBe(7);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBe(1);
      } finally {
        collab.getActivities = orig;
      }
    });

    test('activity POST 经 readJsonBody 记录活动', async () => {
      const orig = collab.recordActivity;
      let captured = null;
      collab.recordActivity = (a) => { captured = a; return []; };
      try {
        // 2026-08-13(Task3 遗留B): GUI postActivity 发 { expertId, expertName, expertIcon, action, message },
        // 服务端必须映射为 recordActivity 的 type/expertId/content 并透传 expertName/expertIcon。
        {
          const res = mockRes();
          const req = reqWithBody({ expertId: 'e1', expertName: 'E1', expertIcon: 'Brain', action: 'summoned', message: 'hi' });
          const p = LOCAL_HANDLERS.handleExpertActivityPost(req, res, {});
          req._feed();
          await p;
          expect(captured).toEqual({ type: 'summoned', expertId: 'e1', content: 'hi', expertName: 'E1', expertIcon: 'Brain' });
          expect(res.json().success).toBe(true);
        }
        // 旧字段形状(type/content)保持兼容
        {
          captured = null;
          const res = mockRes();
          const req = reqWithBody({ type: 'custom', expertId: 'e2', content: 'legacy' });
          const p = LOCAL_HANDLERS.handleExpertActivityPost(req, res, {});
          req._feed();
          await p;
          expect(captured).toEqual({ type: 'custom', expertId: 'e2', content: 'legacy', expertName: null, expertIcon: null });
          expect(res.json().success).toBe(true);
        }
      } finally {
        collab.recordActivity = orig;
      }
    });

    test('request cancel 经 readJsonBody 取 userId（简报外同根因补充修复）', async () => {
      const ri = require('../core/request-interrupt');
      const orig = ri.globalRequestInterrupt.abort;
      let capturedUser = null;
      ri.globalRequestInterrupt.abort = (u) => { capturedUser = u; return true; };
      try {
        const res = mockRes();
        const req = reqWithBody({ userId: 'u99' });
        const p = LOCAL_HANDLERS.handleRequestCancel(req, res, {});
        req._feed();
        await p;
        expect(capturedUser).toBe('u99');
        expect(res.json().success).toBe(true);
      } finally {
        ri.globalRequestInterrupt.abort = orig;
      }
    });
  });
});
