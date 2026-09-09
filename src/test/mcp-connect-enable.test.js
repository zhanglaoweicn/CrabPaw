/**
 * CK1 修复回归——disabled MCP 服务器「连接/启用」链路（2026-08-28 管理舱审计）
 *
 * 旧实现：handleMCPServerConnect 只查运行态（initialize 跳过 enabled===false）→
 * disabled 服务器点「连接」恒 404「服务器不存在」——B1 幽灵配置修复只兑现「可见」
 * 未兑现「可启停」。修复后：盘上有配置 → 落盘 enabled:true + addServer 装载。
 * handleMCPServerUpdate 对 disabled 服务器只落盘、如实返回 status:'disabled'。
 */
jest.mock('../core/mcp/mcp-manager', () => ({
  getMCPManager: () => mockManager,
}));

const mockManager = {
  _runtime: {},
  getServer(name) { return this._runtime[name] ? { name, status: 'connected', error: null } : null; },
  async _loadConfig() { return this._disk; },
  async saveServerConfig(name, cfg) { this._disk[name] = cfg; },
  async addServer(name, cfg) { this._runtime[name] = true; this._added = { name, cfg }; },
  async reconnectServer(name) { this._reconnected = name; },
};

const { createMCPHandlers } = require('../cli/handlers/mcp-handlers');

function mockRes() {
  return {
    statusCode: null, body: null,
    writeHead(code) { this.statusCode = code; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
}

function mockReq(method, bodyObj) {
  // readRequestBody 是事件型（data/end）——同步注册后异步发射
  const chunks = bodyObj !== undefined ? [JSON.stringify(bodyObj)] : [];
  return {
    method,
    on(ev, cb) {
      if (ev === 'data') setImmediate(() => chunks.forEach(c => cb(c)));
      if (ev === 'end') setImmediate(() => cb());
      return this;
    },
    removeListener() {},
  };
}

const sendJson = (res, code, payload) => { res.writeHead(code); res.end(JSON.stringify(payload)); };
const handlers = createMCPHandlers(sendJson);

beforeEach(() => {
  mockManager._runtime = {};
  mockManager._disk = {
    ghost: { command: 'npx', args: ['-y', '@demo/server'], enabled: false },
    live: { command: 'npx', args: ['-y', '@demo/live'] },
  };
  mockManager._added = null;
  mockManager._reconnected = null;
});

describe('handleMCPServerConnect — disabled 服务器启用链（CK1）', () => {
  test('disabled 服务器：落盘 enabled:true + addServer 装载（不再 404）', async () => {
    const res = mockRes();
    await handlers.handleMCPServerConnect(mockReq('POST', { name: 'ghost' }), res, {});
    expect(res.statusCode).toBe(200);
    expect(mockManager._disk.ghost.enabled).toBe(true);          // 持久化启用
    expect(mockManager._added).toEqual({ name: 'ghost', cfg: expect.objectContaining({ enabled: true }) });
    expect(mockManager._reconnected).toBeNull();                  // addServer 已连接, 不重复 reconnect
    expect(res.body.data.status).toBe('connected');
  });

  test('盘上无配置：仍 404（真不存在）', async () => {
    const res = mockRes();
    await handlers.handleMCPServerConnect(mockReq('POST', { name: 'nope' }), res, {});
    expect(res.statusCode).toBe(404);
    expect(mockManager._added).toBeNull();
  });

  test('运行态服务器：原路径 reconnect 保持不变', async () => {
    mockManager._runtime.live = true;
    const res = mockRes();
    await handlers.handleMCPServerConnect(mockReq('POST', { name: 'live' }), res, {});
    expect(res.statusCode).toBe(200);
    expect(mockManager._reconnected).toBe('live');
    expect(mockManager._added).toBeNull();
  });

  test('缺 name：400', async () => {
    const res = mockRes();
    await handlers.handleMCPServerConnect(mockReq('POST', {}), res, {});
    expect(res.statusCode).toBe(400);
  });
});

describe('handleMCPServerUpdate — disabled 服务器编辑（CK1）', () => {
  test('disabled 服务器：落盘保存 + 如实返回 status:disabled（不再伪装 error）', async () => {
    const res = mockRes();
    await handlers.handleMCPServerUpdate(mockReq('POST', { name: 'ghost', tools: { allow: ['a'] } }), res, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('disabled');
    expect(mockManager._reconnected).toBeNull();
    // B3 合并语义保持: 盘上既有字段不丢
    expect(mockManager._disk.ghost.command).toBe('npx');
    expect(mockManager._disk.ghost.tools).toEqual({ allow: ['a'] });
  });

  test('运行态服务器：保存后 reconnect（原语义）', async () => {
    mockManager._runtime.live = true;
    const res = mockRes();
    await handlers.handleMCPServerUpdate(mockReq('POST', { name: 'live', tools: { allow: ['b'] } }), res, {});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('connected');
    expect(mockManager._reconnected).toBe('live');
  });
});
