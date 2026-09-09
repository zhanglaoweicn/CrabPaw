/**
 * MCP Manager 集成测试（2026-08-01 新增——协议层已有单测，manager 层补齐）
 *
 * 覆盖：空配置初始化、服务器配置 CRUD 持久化闭环、错误处理、工具定义结构。
 * 数据目录隔离：CRABPAW_DATA_DIR 指向临时目录，不污染真实配置。
 */
process.env.CRABPAW_DATA_DIR = require('os').tmpdir() + '/crabpaw-mcp-test-' + Date.now();

const { MCPManager } = require('../core/mcp/mcp-manager');
const path = require('path');
const fs = require('fs');

describe('MCP Manager', () => {
  let manager;

  beforeEach(() => {
    manager = new MCPManager();
  });

  afterEach(() => {
    // 清理持久化配置，避免测试间污染（initialize 会真实连接配置中的服务器）
    try { fs.rmSync(path.join(process.env.CRABPAW_DATA_DIR, 'mcp-servers.json'), { force: true }); } catch (e) {
      /* best-effort */
      console.warn('[mcp-manager.test.js] 空 catch 补日志:', e && e.message);
    }

  });

  test('initializes with empty config without crash', async () => {
    await manager.initialize();
    expect(manager._initialized).toBe(true);
    expect(manager.getServers().length).toBe(0);
  });

  test('saveServerConfig persists and reloads', async () => {
    await manager.initialize();
    await manager.saveServerConfig('test-server', {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    });
    // 验证持久化文件（不触发真实连接——initialize 会 spawn npx）
    const manager2 = new MCPManager();
    const configs = await manager2._loadConfig();
    expect(configs['test-server'].command).toBe('npx');
    expect(configs['test-server'].args[0]).toBe('-y');
  });

  test('deleteServerConfig removes entry', async () => {
    await manager.initialize();
    await manager.saveServerConfig('temp-server', { command: 'echo' });
    await manager.deleteServerConfig('temp-server');
    const configs = await manager._loadConfig();
    expect(configs['temp-server']).toBeUndefined();
  });

  test('addServer with invalid config throws immediately', async () => {
    await manager.initialize();
    // 空配置（无 command 无 url）→ HttpTransport connect 立即抛"未配置 URL"
    await expect(manager.addServer('broken', {})).rejects.toThrow();
  });

  test('getToolDefinitions returns OpenAI-style array', async () => {
    await manager.initialize();
    const defs = manager.getToolDefinitions();
    expect(Array.isArray(defs)).toBe(true);
    for (const d of defs) {
      expect(d.type).toBe('function');
      expect(d.function.name).toBeDefined();
    }
  });

  test('_normalizeToolName converts dashes and dots', () => {
    expect(manager._normalizeToolName('my-tool.name')).toBe('my_tool_name');
  });

  afterAll(() => {
    try {
      fs.rmSync(process.env.CRABPAW_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
      /* best-effort */
      console.warn('[mcp-manager.test.js] 空 catch 补日志:', e && e.message);
    }

  });
});
