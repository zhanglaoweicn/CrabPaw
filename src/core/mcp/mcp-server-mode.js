/**
 * MCP 服务器模式 — 将 CrabPaw 的工具暴露为 MCP 服务器
 *
 * 允许其他 MCP 兼容的 Agent 通过 MCP 协议调用 CrabPaw 的工具
 * 支持 HTTP 传输，端点: /mcp
 */

const { MCPServer, MCPTool, MCPResource, MCPPrompt } = require('./protocol');
const { readJsonBody } = require('../../handlers/http-utils');

/**
 * 创建 CrabPaw MCP 服务器
 * 将 CrabPaw 的内置工具、技能等暴露为 MCP 工具
 */
let _cachedServer = null;

function createCrabPawMCPServer() {
  // 2026-08-01: 服务器是纯静态注册（工具/资源/提示固定，无会话状态），
  // 此前每请求重建导致重复注册与性能浪费。缓存单例。
  if (_cachedServer) return _cachedServer;

  const server = new MCPServer({
    name: 'CrabPaw MCP Server',
    version: '1.0.0',
  });

  // 注册 CrabPaw 核心工具
  registerCoreTools(server);
  registerCoreResources(server);
  registerCorePrompts(server);

  _cachedServer = server;
  return server;
}

/**
 * 注册核心工具
 */
function registerCoreTools(server) {
  // Web 搜索
  server.registerTool(new MCPTool({
    name: 'web_search',
    description: '使用搜索引擎搜索互联网信息',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        maxResults: { type: 'number', description: '最大结果数（默认5）' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const { SearchBackendManager } = require('../search/search-backend-manager');
        const manager = new SearchBackendManager();
        const results = await manager.search(args.query, { maxResults: args.maxResults || 5 });
        return results;
      } catch (e) {
        return { error: e.message };
      }
    },
  }));

  // 网页抓取
  server.registerTool(new MCPTool({
    name: 'web_fetch',
    description: '抓取网页内容并提取文本',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页 URL' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      try {
        // 2026-08-01: SSRF 加固——阻止回环/私网/链路本地地址抓取
        const blocked = /^(https?:\/\/)?(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|localhost|\[::1\]|::1)/i;
        if (blocked.test(String(args.url || ''))) {
          return { error: '不允许访问内网/回环地址' };
        }
        const resp = await fetch(args.url, {
          headers: { 'User-Agent': 'CrabPaw/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        const html = await resp.text();
        // 简单提取文本
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 10000);
        return { url: args.url, content: text };
      } catch (e) {
        return { error: e.message };
      }
    },
  }));

  // 代码执行
  server.registerTool(new MCPTool({
    name: 'execute_code',
    description: '在沙箱中执行代码',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的代码' },
        language: { type: 'string', description: '编程语言（javascript/python）', enum: ['javascript', 'python'] },
      },
      required: ['code'],
    },
    handler: async (args) => {
      try {
        const { sandboxExecuteHandler } = require('../sandbox/sandbox-tool');
        const result = await sandboxExecuteHandler({
          command: args.code,
          language: args.language === 'python' ? 'python' : 'node',
          timeout_ms: 30000,
        });
        return result;
      } catch (e) {
        // sandboxExecuteHandler 内部已捕获并返回失败对象，此处仅兜意外异常；
        // 不再附加"需要 Docker"误导性说明（Docker 缺失时 handler 会诚实返回 stderr）
        return { error: e.message };
      }
    },
  }));

  // 浏览器控制
  // 2026-08-15 P1-5 修复: 此前 require('../../browser-control') 取到模块对象后
  // 直接调 .navigate()/.screenshot()——模块顶层并无这两个导出(实际导出的是
  // getBrowserControlManager 管理器工厂),两个工具恒抛 TypeError。
  // 改为走真实导出: getBrowserControlManager().navigate(url)/.screenshot(profile, options);
  // 并先探测浏览器可用性,不可用时诚实返回能力不可用错误(不虚报能力面)。
  server.registerTool(new MCPTool({
    name: 'browser_navigate',
    description: '使用浏览器导航到指定 URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL' },
      },
      required: ['url'],
    },
    handler: async (args) => {
      try {
        const { getBrowserControlManager, isAnyBrowserAvailable } = require('../browser-control');
        if (!isAnyBrowserAvailable()) {
          return { error: '本机未检测到可用浏览器（Playwright 环境未就绪），浏览器控制能力暂不可用' };
        }
        const result = await getBrowserControlManager().navigate(args.url);
        return result;
      } catch (e) {
        console.error('[mcp-server-mode] browser_navigate 失败:', e.message);
        return { error: e.message, note: '浏览器控制不可用' };
      }
    },
  }));

  // 浏览器截图
  server.registerTool(new MCPTool({
    name: 'browser_screenshot',
    description: '对当前浏览器页面截图',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器（可选，截取特定元素）' },
      },
    },
    handler: async (args) => {
      try {
        const { getBrowserControlManager, isAnyBrowserAvailable } = require('../browser-control');
        if (!isAnyBrowserAvailable()) {
          return { error: '本机未检测到可用浏览器（Playwright 环境未就绪），浏览器控制能力暂不可用' };
        }
        const options = args.selector ? { selector: args.selector } : {};
        const result = await getBrowserControlManager().screenshot(undefined, options);
        return result;
      } catch (e) {
        console.error('[mcp-server-mode] browser_screenshot 失败:', e.message);
        return { error: e.message, note: '浏览器控制不可用' };
      }
    },
  }));

  // 记忆搜索
  server.registerTool(new MCPTool({
    name: 'memory_search',
    description: '搜索 CrabPaw 的记忆存储',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '最大结果数' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      try {
        const { memoryManager } = require('../memory-system');
        const results = await memoryManager.searchMemories(args.query, args.limit || 5);
        return results;
      } catch (e) {
        return { error: e.message };
      }
    },
  }));

  // 系统状态
  server.registerTool(new MCPTool({
    name: 'system_status',
    description: '获取 CrabPaw 系统状态',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async () => {
      return {
        version: '1.0.0',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        mcpServers: require('./mcp-manager').getMCPManager().getStats(),
      };
    },
  }));
}

/**
 * 注册核心资源
 */
function registerCoreResources(server) {
  server.registerResource(new MCPResource({
    uri: 'crabpaw://config',
    name: 'CrabPaw 配置',
    description: '当前 CrabPaw 配置信息',
    mimeType: 'application/json',
    handler: async () => {
      const config = require('../config');
      return {
        model: config.defaultModel,
        providers: Object.keys(config.providers || {}),
      };
    },
  }));

  server.registerResource(new MCPResource({
    uri: 'crabpaw://skills',
    name: 'CrabPaw 技能列表',
    description: '已安装的技能列表',
    mimeType: 'application/json',
    handler: async () => {
      try {
        const skillSystem = require('../skill-system');
        const skills = await skillSystem.listSkills?.() || [];
        return skills;
      } catch (e) {
        console.warn('[mcp-server-mode] 技能列表读取失败:', e?.message || e);
        return [];
      }
    },
  }));
}

/**
 * 注册核心提示
 */
function registerCorePrompts(server) {
  server.registerPrompt(new MCPPrompt({
    name: 'crabpaw_assistant',
    description: 'CrabPaw 助手提示模板',
    arguments: [
      { name: 'task', description: '任务描述', required: true },
    ],
    handler: async (args) => {
      return `你是 CrabPaw 助手。请帮助完成以下任务：${args.task || ''}\n\n你可以使用搜索、浏览器控制、代码执行等工具来完成任务。`;
    },
  }));
}

/**
 * 处理 MCP HTTP 请求
 * 用于 /mcp 端点
 */
async function handleMCPServerRequest(req, res, ctx) {
  const server = createCrabPawMCPServer();

  try {
    let body;
    if (req.method === 'POST') {
      try { body = await readJsonBody(req); } catch (e) { body = {}; console.warn('[mcp] body 解析失败:', e?.message || e); }
    } else {
      // GET 请求返回服务器信息
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: server.name,
        version: server.version,
        capabilities: {
          tools: { listChanged: true },
          // 2026-08-15 P2: 下线 subscribe 声明——无 resources/subscribe 处理器
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
      }));
      return;
    }

    const response = await server.handleRequest(body);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Mcp-Session-Id': ctx.sessionId || 'default',
    });
    res.end(JSON.stringify(response));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: e.message },
      id: null,
    }));
  }
}

module.exports = {
  createCrabPawMCPServer,
  handleMCPServerRequest,
};
