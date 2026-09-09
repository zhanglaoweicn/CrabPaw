/**
 * MCP Protocol - Model Context Protocol 协议支持
 * 
 * 基于 Deer-Flow 的 MCP 实现，提供:
 * 1. 多传输类型支持 (stdio, sse, http)
 * 2. 工具发现和注册
 * 3. 资源管理
 * 4. 提示模板
 */

const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

const TRANSPORT_TYPES = {
  STDIO: 'stdio',
  SSE: 'sse',
  HTTP: 'http',
  WEBSOCKET: 'websocket'
};

const MESSAGE_TYPES = {
  REQUEST: 'request',
  RESPONSE: 'response',
  NOTIFICATION: 'notification',
  ERROR: 'error'
};

class MCPError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = 'MCPError';
  }
}

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  CONNECTION_CLOSED: -32001,
  TIMEOUT: -32002
};

class MCPTool {
  constructor(config = {}) {
    this.name = config.name || '';
    this.description = config.description || '';
    this.inputSchema = config.inputSchema || { type: 'object', properties: {} };
    this.handler = config.handler || null;
    this.metadata = config.metadata || {};
  }

  async execute(args, context) {
    if (!this.handler) {
      throw new MCPError(ERROR_CODES.METHOD_NOT_FOUND, `Tool ${this.name} has no handler`);
    }
    return await this.handler(args, context);
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema
    };
  }
}

class MCPResource {
  constructor(config = {}) {
    this.uri = config.uri || '';
    this.name = config.name || '';
    this.description = config.description || '';
    this.mimeType = config.mimeType || 'text/plain';
    this.handler = config.handler || null;
  }

  async read() {
    if (!this.handler) {
      throw new MCPError(ERROR_CODES.METHOD_NOT_FOUND, `Resource ${this.uri} has no handler`);
    }
    return await this.handler();
  }

  toJSON() {
    return {
      uri: this.uri,
      name: this.name,
      description: this.description,
      mimeType: this.mimeType
    };
  }
}

class MCPPrompt {
  constructor(config = {}) {
    this.name = config.name || '';
    this.description = config.description || '';
    this.arguments = config.arguments || [];
    this.template = config.template || '';
    this.handler = config.handler || null;
  }

  async render(args = {}) {
    if (this.handler) {
      return await this.handler(args);
    }
    
    let result = this.template;
    for (const [key, value] of Object.entries(args)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
    }
    return result;
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      arguments: this.arguments
    };
  }
}

class MCPServer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.name = config.name || 'CrabPaw MCP Server';
    this.version = config.version || '1.0.0';
    this.transportType = config.transportType || TRANSPORT_TYPES.STDIO;
    
    this._tools = new Map();
    this._resources = new Map();
    this._prompts = new Map();
    this._sessions = new Map();
    this._requestHandlers = new Map();
    
    this._setupDefaultHandlers();
  }

  _setupDefaultHandlers() {
    this._requestHandlers.set('initialize', this._handleInitialize.bind(this));
    this._requestHandlers.set('tools/list', this._handleToolsList.bind(this));
    this._requestHandlers.set('tools/call', this._handleToolsCall.bind(this));
    this._requestHandlers.set('resources/list', this._handleResourcesList.bind(this));
    this._requestHandlers.set('resources/read', this._handleResourcesRead.bind(this));
    this._requestHandlers.set('prompts/list', this._handlePromptsList.bind(this));
    this._requestHandlers.set('prompts/get', this._handlePromptsGet.bind(this));
    this._requestHandlers.set('ping', this._handlePing.bind(this));
  }

  registerTool(tool) {
    if (!(tool instanceof MCPTool)) {
      tool = new MCPTool(tool);
    }
    this._tools.set(tool.name, tool);
    this.emit('tool:registered', tool);
    return this;
  }

  unregisterTool(name) {
    const tool = this._tools.get(name);
    if (tool) {
      this._tools.delete(name);
      this.emit('tool:unregistered', tool);
    }
    return this;
  }

  registerResource(resource) {
    if (!(resource instanceof MCPResource)) {
      resource = new MCPResource(resource);
    }
    this._resources.set(resource.uri, resource);
    this.emit('resource:registered', resource);
    return this;
  }

  unregisterResource(uri) {
    const resource = this._resources.get(uri);
    if (resource) {
      this._resources.delete(uri);
      this.emit('resource:unregistered', resource);
    }
    return this;
  }

  registerPrompt(prompt) {
    if (!(prompt instanceof MCPPrompt)) {
      prompt = new MCPPrompt(prompt);
    }
    this._prompts.set(prompt.name, prompt);
    this.emit('prompt:registered', prompt);
    return this;
  }

  unregisterPrompt(name) {
    const prompt = this._prompts.get(name);
    if (prompt) {
      this._prompts.delete(name);
      this.emit('prompt:unregistered', prompt);
    }
    return this;
  }

  async handleRequest(request) {
    const { id, method, params } = request;
    
    try {
      const handler = this._requestHandlers.get(method);
      
      if (!handler) {
        throw new MCPError(ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
      
      const result = await handler(params || {});
      
      return {
        jsonrpc: '2.0',
        id,
        result
      };
    } catch (error) {
      const mcpError = error instanceof MCPError 
        ? error 
        : new MCPError(ERROR_CODES.INTERNAL_ERROR, error.message);
      
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: mcpError.code,
          message: mcpError.message,
          data: mcpError.data
        }
      };
    }
  }

  async _handleInitialize(params) {
    // 2026-08-15 P2: _sessions 加 TTL——此前会话只增不减(Map 无上限增长)。
    // 每次 initialize 前清理过期会话(24h),server 无重连状态机,过期即视为失效。
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const [sid, session] of this._sessions.entries()) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        this._sessions.delete(sid);
      }
    }

    const sessionId = uuidv4();

    this._sessions.set(sessionId, {
      createdAt: now,
      clientInfo: params.clientInfo || {},
      capabilities: params.capabilities || {}
    });

    return {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: this.name,
        version: this.version
      },
      capabilities: {
        tools: { listChanged: true },
        // 2026-08-15 P2: 下线 subscribe 声明——未实现 resources/subscribe 处理器
        resources: { listChanged: true },
        prompts: { listChanged: true }
      },
      sessionId
    };
  }

  async _handleToolsList(_params) {
    const tools = Array.from(this._tools.values()).map(t => t.toJSON());
    return { tools };
  }

  async _handleToolsCall(params) {
    const { name, arguments: args } = params;
    
    const tool = this._tools.get(name);
    if (!tool) {
      throw new MCPError(ERROR_CODES.METHOD_NOT_FOUND, `Tool not found: ${name}`);
    }
    
    const context = { server: this, timestamp: Date.now() };
    const result = await tool.execute(args || {}, context);
    
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }
      ]
    };
  }

  async _handleResourcesList(_params) {
    const resources = Array.from(this._resources.values()).map(r => r.toJSON());
    return { resources };
  }

  async _handleResourcesRead(params) {
    const { uri } = params;
    
    const resource = this._resources.get(uri);
    if (!resource) {
      throw new MCPError(ERROR_CODES.METHOD_NOT_FOUND, `Resource not found: ${uri}`);
    }
    
    const contents = await resource.read();
    
    return {
      contents: [
        {
          uri,
          mimeType: resource.mimeType,
          text: typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2)
        }
      ]
    };
  }

  async _handlePromptsList(_params) {
    const prompts = Array.from(this._prompts.values()).map(p => p.toJSON());
    return { prompts };
  }

  async _handlePromptsGet(params) {
    const { name, arguments: args } = params;
    
    const prompt = this._prompts.get(name);
    if (!prompt) {
      throw new MCPError(ERROR_CODES.METHOD_NOT_FOUND, `Prompt not found: ${name}`);
    }
    
    const rendered = await prompt.render(args || {});
    
    return {
      description: prompt.description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: rendered
          }
        }
      ]
    };
  }

  async _handlePing(_params) {
    return {};
  }

  getTools() {
    return Array.from(this._tools.values());
  }

  getResources() {
    return Array.from(this._resources.values());
  }

  getPrompts() {
    return Array.from(this._prompts.values());
  }

  getStats() {
    return {
      tools: this._tools.size,
      resources: this._resources.size,
      prompts: this._prompts.size,
      sessions: this._sessions.size
    };
  }
}

class MCPClient extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.serverUrl = config.serverUrl || null;
    this.transportType = config.transportType || TRANSPORT_TYPES.STDIO;
    this.timeout = config.timeout || 30000;
    
    this._sessionId = null;
    this._requestId = 0;
    this._pendingRequests = new Map();
    this._connected = false;
  }

  async connect() {
    if (this.transportType === TRANSPORT_TYPES.STDIO) {
      this._connected = true;
    } else if (this.transportType === TRANSPORT_TYPES.HTTP || this.transportType === TRANSPORT_TYPES.SSE) {
      if (!this.serverUrl) {
        throw new MCPError(ERROR_CODES.INVALID_REQUEST, 'Server URL required for HTTP/SSE transport');
      }
      this._connected = true;
    }
    
    this.emit('connected');
    return this._connected;
  }

  async disconnect() {
    this._connected = false;
    this._sessionId = null;
    this._pendingRequests.clear();
    this.emit('disconnected');
  }

  async sendRequest(method, params = {}) {
    if (!this._connected) {
      throw new MCPError(ERROR_CODES.CONNECTION_CLOSED, 'Not connected');
    }
    
    const id = ++this._requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };
    
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new MCPError(ERROR_CODES.TIMEOUT, `Request ${id} timed out`));
      }, this.timeout);
      
      this._pendingRequests.set(id, { resolve, reject, timeoutId });
      
      this._send(request);
    });
  }

  _send(request) {
    const json = JSON.stringify(request);
    
    if (this.transportType === TRANSPORT_TYPES.STDIO) {
      process.stdout.write(json + '\n');
    } else if (this.transportType === TRANSPORT_TYPES.HTTP) {
      this._sendHttp(request);
    } else if (this.transportType === TRANSPORT_TYPES.SSE) {
      this._sendSse(request);
    }
  }

  async _sendHttp(request) {
    const http = require('http');
    const url = new URL(this.serverUrl);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(request))
      }
    };
    
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            this._handleResponse(response);
            resolve(response);
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on('error', reject);
      req.write(JSON.stringify(request));
      req.end();
    });
  }

  async _sendSse(request) {
    this.emit('sse:send', request);
  }

  _handleResponse(response) {
    const { id, result, error } = response;
    
    const pending = this._pendingRequests.get(id);
    if (!pending) return;
    
    clearTimeout(pending.timeoutId);
    this._pendingRequests.delete(id);
    
    if (error) {
      pending.reject(new MCPError(error.code, error.message, error.data));
    } else {
      pending.resolve(result);
    }
  }

  async initialize() {
    const result = await this.sendRequest('initialize', {
      clientInfo: {
        name: 'CrabPaw MCP Client',
        version: '1.0.0'
      },
      capabilities: {}
    });
    
    this._sessionId = result.sessionId;
    return result;
  }

  async listTools() {
    return await this.sendRequest('tools/list');
  }

  async callTool(name, args = {}) {
    return await this.sendRequest('tools/call', { name, arguments: args });
  }

  async listResources() {
    return await this.sendRequest('resources/list');
  }

  async readResource(uri) {
    return await this.sendRequest('resources/read', { uri });
  }

  async listPrompts() {
    return await this.sendRequest('prompts/list');
  }

  async getPrompt(name, args = {}) {
    return await this.sendRequest('prompts/get', { name, arguments: args });
  }

  get isConnected() {
    return this._connected;
  }

  get sessionId() {
    return this._sessionId;
  }
}

function createMCPServer(config = {}) {
  const server = new MCPServer(config);
  
  server.registerTool({
    name: 'echo',
    description: 'Echo back the input message',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to echo'
        }
      },
      required: ['message']
    },
    handler: async (args) => {
      return { echo: args.message };
    }
  });
  
  server.registerTool({
    name: 'get_time',
    description: 'Get current server time',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      return {
        time: new Date().toISOString(),
        timestamp: Date.now()
      };
    }
  });
  
  server.registerResource({
    uri: 'info://server',
    name: 'Server Information',
    description: 'Information about the MCP server',
    mimeType: 'application/json',
    handler: async () => {
      return {
        name: server.name,
        version: server.version,
        stats: server.getStats()
      };
    }
  });
  
  server.registerPrompt({
    name: 'greeting',
    description: 'A greeting prompt template',
    arguments: [
      {
        name: 'name',
        description: 'Name to greet',
        required: true
      }
    ],
    template: 'Hello, {name}! How can I help you today?'
  });
  
  return server;
}

module.exports = {
  MCPServer,
  MCPClient,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPError,
  ERROR_CODES,
  TRANSPORT_TYPES,
  MESSAGE_TYPES,
  createMCPServer
};
