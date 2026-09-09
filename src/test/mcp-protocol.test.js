/**
 * MCP 协议层单元测试（2026-08-01 新增——此前 MCP 零测试覆盖）
 *
 * 覆盖：MCPServer 请求处理（initialize/tools/list/tools/call/ping）、
 * MCPTool 定义、JSON-RPC 错误处理、MCPClient 请求构造。
 */
const { createMCPServer, MCPServer, MCPClient, MCPTool } = require('../core/mcp/protocol');

describe('MCP Protocol', () => {
  describe('MCPTool', () => {
    test('constructs from plain object', () => {
      const tool = new MCPTool({ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } });
      expect(tool.name).toBe('echo');
      expect(tool.description).toBe('Echo input');
    });

    test('toJSON exposes function-calling shape', () => {
      const tool = new MCPTool({ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } });
      const json = tool.toJSON();
      expect(json.name).toBe('echo');
      expect(json.inputSchema.properties.text.type).toBe('string');
    });
  });

  describe('MCPServer', () => {
    test('createMCPServer factory returns server', () => {
      const server = createMCPServer({ name: 'test-server' });
      expect(server).toBeInstanceOf(MCPServer);
      expect(server.name).toBe('test-server');
    });

    test('handles initialize request', async () => {
      const server = createMCPServer({ name: 'test' });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      expect(res.id).toBe(1);
      expect(res.result.serverInfo.name).toBe('test');
    });

    test('tools/list returns registered tools', async () => {
      const server = createMCPServer({ name: 'test' });
      server.registerTool({ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: async (p) => `echo:${p.text || ''}` });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      // createMCPServer 工厂预注册内置工具，断言包含新注册的 echo
      expect(res.result.tools.some(t => t.name === 'echo')).toBe(true);
    });

    test('tools/call invokes tool handler', async () => {
      const server = createMCPServer({ name: 'test' });
      server.registerTool({ name: 'echo', description: 'Echo', inputSchema: {}, handler: async (p) => `echo:${p.text}` });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello' } } });
      expect(res.result.content[0].text).toBe('echo:hello');
    });

    test('tools/call unknown tool returns error', async () => {
      const server = createMCPServer({ name: 'test' });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
      expect(res.error).toBeDefined();
      expect(res.error.code).toBeDefined();
    });

    test('ping returns empty result', async () => {
      const server = createMCPServer({ name: 'test' });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 5, method: 'ping' });
      expect(res.result).toEqual({});
    });

    test('unknown method returns method-not-found error', async () => {
      const server = createMCPServer({ name: 'test' });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 6, method: 'bogus/method' });
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32601);
    });

    test('malformed request (no method) returns error', async () => {
      const server = createMCPServer({ name: 'test' });
      const res = await server.handleRequest({ jsonrpc: '2.0', id: 7 });
      expect(res.error).toBeDefined();
    });
  });

  describe('MCPClient', () => {
    test('constructs with config', () => {
      const client = new MCPClient({ serverUrl: 'http://localhost:9999' });
      expect(client.serverUrl).toBe('http://localhost:9999');
      expect(client.timeout).toBe(30000);
      expect(typeof client.sendRequest).toBe('function');
    });

    test('sendRequest builds JSON-RPC envelope and resolves via _send', async () => {
      // 2026-08-15 P2 修复: 旧断言引用不存在的 client._buildRequest,用例永远
      // 空转"通过"。改为断言真实行为: sendRequest → _send 捕获请求信封 →
      // _handleResponse 解析响应。
      const client = new MCPClient({ name: 'client', serverUrl: 'http://localhost:9999' });
      client._connected = true;
      let captured = null;
      client._send = (request) => {
        captured = request;
        setImmediate(() => client._handleResponse({ jsonrpc: '2.0', id: request.id, result: { ok: true } }));
      };
      const result = await client.sendRequest('tools/list', {});
      expect(captured).not.toBeNull();
      expect(captured.jsonrpc).toBe('2.0');
      expect(captured.method).toBe('tools/list');
      expect(captured.id).toBeDefined();
      expect(result).toEqual({ ok: true });
    });

    test('sendRequest rejects on error response', async () => {
      const client = new MCPClient({ serverUrl: 'http://localhost:9999' });
      client._connected = true;
      client._send = (request) => {
        setImmediate(() => client._handleResponse({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }));
      };
      await expect(client.sendRequest('bogus/method', {})).rejects.toThrow('Method not found');
    });
  });
});
