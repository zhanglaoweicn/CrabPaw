/**
 * OpenAI 兼容 API Server
 *
 * 将 CrabPaw 暴露为 OpenAI 兼容的 HTTP 端点。
 * 任何支持 OpenAI 格式的前端（Open WebUI、LobeChat、LibreChat、NextChat、ChatBox 等）
 * 都可以连接到 CrabPaw 并将其作为后端使用。
 *
 * 端点：
 *   POST /v1/chat/completions  — 无状态聊天（OpenAI Chat Completions 格式）
 *   POST /v1/responses         — 有状态聊天（OpenAI Responses API 格式）
 *   GET  /v1/responses/:id     — 获取已存储的响应
 *   DELETE /v1/responses/:id   — 删除已存储的响应
 *   GET  /v1/models            — 模型列表
 *   GET  /health               — 健康检查
 *   GET  /v1/health            — 健康检查（/v1/ 前缀版本）
 *
 * 认证：Bearer Token（通过 API_SERVER_KEY 环境变量配置）
 * 流式：支持 SSE token-by-token 流式 + 工具进度内联
 */

const http = require('http');
const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars
const { v4: uuidv4 } = require('crypto');
// eslint-disable-next-line no-unused-vars
const { loadConfig, DEFAULT_PORT } = require('./config');

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_API_PORT = 9876;

function getApiServerConfig() {
  return {
    enabled: process.env.API_SERVER_ENABLED === 'true',
    port: parseInt(process.env.API_SERVER_PORT, 10) || DEFAULT_API_PORT,
    host: process.env.API_SERVER_HOST || '127.0.0.1',
    apiKey: process.env.API_SERVER_KEY || '',
    corsOrigins: process.env.API_SERVER_CORS_ORIGINS || '',
    modelName: process.env.API_SERVER_MODEL_NAME || 'crabpaw-agent',
  };
}

// ============================================================================
// 会话存储（用于 Responses API）
// ============================================================================

const responseStore = new Map(); // id -> response object
const conversationStore = new Map(); // conversation name -> latest response id

function storeResponse(responseObj) {
  responseStore.set(responseObj.id, responseObj);

  // 限制存储大小
  if (responseStore.size > 1000) {
    const oldest = responseStore.keys().next().value;
    responseStore.delete(oldest);
  }
}

function getResponse(id) {
  return responseStore.get(id) || null;
}

function deleteResponse(id) {
  return responseStore.delete(id);
}

function linkConversation(name, responseId) {
  conversationStore.set(name, responseId);
}

function getConversationLatest(name) {
  const id = conversationStore.get(name);
  return id ? responseStore.get(id) : null;
}

// ============================================================================
// 工具进度追踪
// ============================================================================

const TOOL_ICONS = {
  terminal: '💻',
  read_file: '📖',
  write_file: '✏️',
  search: '🔍',
  web_search: '🔍',
  browser: '🌐',
  execute_code: '⚡',
  memory: '🧠',
};

function getToolIcon(toolName) {
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (toolName.includes(key)) return icon;
  }
  return '🔧';
}

// ============================================================================
// OpenAI 兼容 API Server
// ============================================================================

class OpenAICompatProxy extends EventEmitter {
  constructor(config = {}) {
    super();
    this.port = config.port || DEFAULT_API_PORT;
    this.host = config.host || '127.0.0.1';
    this.config = config.config || loadConfig();
    this._server = null;
    this._running = false;
    this._requestHandler = config.requestHandler || null;
    this._chatHandler = config.chatHandler || null; // CrabPaw chatStream handler
  }

  /**
   * 设置 CrabPaw 聊天处理器
   * @param {Function} handler - async (messages, options) => { content, usage, toolProgress }
   */
  setChatHandler(handler) {
    this._chatHandler = handler;
  }

  async start() {
    if (this._running) return;

    const serverConfig = getApiServerConfig();
    this.port = serverConfig.port;
    this.host = serverConfig.host;
    this._apiKey = serverConfig.apiKey;
    this._corsOrigins = serverConfig.corsOrigins;
    this._modelName = serverConfig.modelName;

    // 2026-08-07 (M1 安全): API_SERVER_KEY 未配置时端点对一切请求（含本机）401，
    // 启动时显式警告，避免"空 key 即开放"的静默风险
    if (!this._apiKey) {
      console.warn('⚠️ OpenAI 兼容 API Server 未配置 API_SERVER_KEY——所有请求将被拒绝（401），请设置环境变量 API_SERVER_KEY 后重启');
    }

    this._server = http.createServer(async (req, res) => {
      await this._handleRequest(req, res);
    });

    await new Promise((resolve, reject) => {
      this._server.listen(this.port, this.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    this._running = true;
    this.emit('started', { port: this.port, host: this.host });
    console.log(`🚀 OpenAI 兼容 API Server 已启动: http://${this.host}:${this.port}/v1`);
  }

  async stop() {
    if (!this._running || !this._server) return;

    await new Promise((resolve) => {
      this._server.close(resolve);
    });

    this._running = false;
    this._server = null;
    this.emit('stopped');
    console.log('🛑 OpenAI 兼容 API Server 已停止');
  }

  get isRunning() {
    return this._running;
  }

  // ========================================================================
  // 请求路由
  // ========================================================================

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // CORS
    this._setCORSHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 认证检查（/health 除外）
    if (pathname !== '/health' && pathname !== '/v1/health') {
      if (!this._checkAuth(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error' } }));
        return;
      }
    }

    // 路由
    if (req.method === 'GET' && pathname === '/v1/models') {
      return this._handleModels(res);
    }
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/v1/health')) {
      return this._handleHealth(res);
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      return await this._handleChatCompletions(req, res);
    }
    if (req.method === 'POST' && pathname === '/v1/responses') {
      return await this._handleResponses(req, res);
    }
    if (req.method === 'GET' && pathname.startsWith('/v1/responses/')) {
      const id = pathname.replace('/v1/responses/', '');
      return this._handleGetResponse(res, id);
    }
    if (req.method === 'DELETE' && pathname.startsWith('/v1/responses/')) {
      const id = pathname.replace('/v1/responses/', '');
      return this._handleDeleteResponse(res, id);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
  }

  // ========================================================================
  // CORS
  // ========================================================================

  _setCORSHeaders(req, res) {
    const origin = req.headers.origin || '';
    let allowOrigin = '';

    if (this._corsOrigins) {
      const allowed = this._corsOrigins.split(',').map(s => s.trim());
      if (allowed.includes(origin) || allowed.includes('*')) {
        allowOrigin = origin;
      }
    } else if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
          allowOrigin = origin;
        }
      } catch (e) {
        /* 忽略错误 */
        console.warn('[openai-compat-proxy.js] 空 catch 补日志:', e && e.message);
      }

    }

    res.setHeader('Access-Control-Allow-Origin', allowOrigin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  // ========================================================================
  // 认证
  // ========================================================================

  _checkAuth(req) {
    // 2026-08-07 (M1 安全修复): 此前未配置 API Key 时放行一切请求——任何可触达
    // 端口者可直接使用 LLM/工具能力。现改为 fail-closed：
    // - 未配置 key：一律拒绝（含本机），须显式设置 API_SERVER_KEY；
    // - 配置后：请求必须携带 Bearer/Authorization，且与配置比对（时序安全）。
    if (!this._apiKey) return false;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return false;
    const expected = Buffer.from(this._apiKey, 'utf8');
    const provided = Buffer.from(token, 'utf8');
    if (expected.length !== provided.length) return false;
    return require('crypto').timingSafeEqual(expected, provided);
  }

  // ========================================================================
  // GET /v1/models
  // ========================================================================

  _handleModels(res) {
    const serverConfig = getApiServerConfig();
    const modelName = serverConfig.modelName;
    const provider = this.config.models?.currentProvider || 'crabpaw';

    const models = {
      object: 'list',
      data: [
        {
          id: modelName,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: provider,
        },
      ],
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(models));
  }

  // ========================================================================
  // GET /health & /v1/health
  // ========================================================================

  _handleHealth(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }

  // ========================================================================
  // POST /v1/chat/completions
  // ========================================================================

  async _handleChatCompletions(req, res) {
    const body = await this._readBody(req);
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
      return;
    }

    const messages = request.messages || [];
    const stream = request.stream || false;
    const model = request.model || this._modelName || 'crabpaw-agent';
    // 从 messages 中提取用户消息
    const userMessage = this._extractUserMessage(messages);
    const systemPrompt = this._extractSystemPrompt(messages);

    if (!userMessage) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No user message found', type: 'invalid_request_error' } }));
      return;
    }

    const chatInput = systemPrompt ? `[附加指令: ${systemPrompt}]\n\n${userMessage}` : userMessage;

    try {
      if (stream) {
        await this._handleChatStream(res, model, chatInput);
      } else {
        await this._handleChatNonStream(res, model, chatInput);
      }
    } catch (e) {
      console.error('❌ API Server 聊天处理失败:', e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      }
    }
  }

  async _handleChatNonStream(res, model, chatInput) {
    const result = await this._callChat(chatInput);

    const response = {
      id: 'chatcmpl-' + this._generateId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: result.content || '',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: result.usage?.prompt_tokens || 0,
        completion_tokens: result.usage?.completion_tokens || 0,
        total_tokens: result.usage?.total_tokens || 0,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  async _handleChatStream(res, model, chatInput) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const chatId = 'chatcmpl-' + this._generateId();
    const created = Math.floor(Date.now() / 1000);

    // 发送 role delta
    this._writeSSE(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });

    // 调用聊天并流式输出
    try {
      const result = await this._callChatStream(chatInput, (chunk) => {
        if (chunk.content) {
          this._writeSSE(res, {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
          });
        }
        // 工具进度内联
        if (chunk.toolProgress) {
          const icon = getToolIcon(chunk.toolProgress.name);
          const label = chunk.toolProgress.label || chunk.toolProgress.name;
          this._writeSSE(res, {
            id: chatId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: ` ${icon} ${label} ` }, finish_reason: null }],
          });
        }
      });

      // 发送 finish
      this._writeSSE(res, {
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });

      // 发送 usage（如果可用）
      if (result?.usage) {
        this._writeSSE(res, {
          id: chatId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: result.usage,
        });
      }
    } catch (e) {
      // 流式中间错误，发送错误内容
      this._writeSSE(res, {
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: `\n\n[错误: ${e.message}]` }, finish_reason: null }],
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ========================================================================
  // POST /v1/responses (OpenAI Responses API)
  // ========================================================================

  async _handleResponses(req, res) {
    const body = await this._readBody(req);
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
      return;
    }

    const input = request.input || '';
    const instructions = request.instructions || '';
    const previousResponseId = request.previous_response_id || '';
    const conversation = request.conversation || '';
    const store = request.store !== false; // 默认存储

    // 重建对话上下文
    let contextMessages = [];
    if (previousResponseId) {
      const prev = getResponse(previousResponseId);
      if (prev) {
        contextMessages = prev._contextMessages || [];
      }
    } else if (conversation) {
      const latest = getConversationLatest(conversation);
      if (latest) {
        contextMessages = latest._contextMessages || [];
      }
    }

    // 构建聊天输入
    const chatInput = instructions
      ? `[附加指令: ${instructions}]\n\n${input}`
      : input;

    try {
      const result = await this._callChat(chatInput);

      const responseId = 'resp_' + this._generateId();
      const output = [];

      // 工具调用（如果有）
      if (result.toolCalls && result.toolCalls.length > 0) {
        for (const tc of result.toolCalls) {
          output.push({
            type: 'function_call',
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            call_id: tc.id || 'call_' + this._generateId(),
          });
          output.push({
            type: 'function_call_output',
            call_id: tc.id || 'call_' + this._generateId(),
            output: tc.result || '',
          });
        }
      }

      // 消息输出
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: result.content || '' }],
      });

      const responseObj = {
        id: responseId,
        object: 'response',
        status: 'completed',
        model: this._modelName || 'crabpaw-agent',
        output,
        usage: {
          input_tokens: result.usage?.prompt_tokens || 0,
          output_tokens: result.usage?.completion_tokens || 0,
          total_tokens: result.usage?.total_tokens || 0,
        },
        created_at: Math.floor(Date.now() / 1000),
        _contextMessages: [...contextMessages, { role: 'user', content: input }, { role: 'assistant', content: result.content || '' }],
      };

      if (store) {
        storeResponse(responseObj);
        if (conversation) {
          linkConversation(conversation, responseId);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseObj));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
    }
  }

  // ========================================================================
  // GET /v1/responses/:id
  // ========================================================================

  _handleGetResponse(res, id) {
    const response = getResponse(id);
    if (!response) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Response not found', type: 'not_found' } }));
      return;
    }

    // 返回时移除内部字段
    const publicResponse = { ...response };
    delete publicResponse._contextMessages;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(publicResponse));
  }

  // ========================================================================
  // DELETE /v1/responses/:id
  // ========================================================================

  _handleDeleteResponse(res, id) {
    const deleted = deleteResponse(id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, deleted, object: 'response.deleted' }));
  }

  // ========================================================================
  // 聊天调用
  // ========================================================================

  async _callChat(message) {
    // 优先使用 CrabPaw chatHandler
    if (this._chatHandler) {
      return await this._chatHandler(message, { stream: false });
    }

    // 回退到旧的 requestHandler
    if (this._requestHandler) {
      return await this._requestHandler({
        messages: [{ role: 'user', content: message }],
        model: this._modelName,
        stream: false,
      });
    }

    throw new Error('No chat handler configured');
  }

  async _callChatStream(message, onChunk) {
    if (this._chatHandler) {
      return await this._chatHandler(message, { stream: true, onChunk });
    }

    if (this._requestHandler) {
      const result = await this._requestHandler({
        messages: [{ role: 'user', content: message }],
        model: this._modelName,
        stream: true,
      });
      // 旧 handler 不支持真正的流式，一次性输出
      onChunk({ content: result.content || '' });
      return result;
    }

    throw new Error('No chat handler configured');
  }

  // ========================================================================
  // 工具方法
  // ========================================================================

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
      // 限制请求体大小 10MB
      req.setTimeout(30000, () => {
        reject(new Error('Request timeout'));
      });
    });
  }

  _writeSSE(res, data) {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {

      // 连接可能已关闭

      console.warn('[openai-compat-proxy.js] 空 catch 补日志:', e && e.message);
    }

  }

  _generateId() {
    return Date.now().toString(36) + crypto.randomBytes(4).toString("hex").slice(0, 8);
  }

  _extractUserMessage(messages) {
    // 取最后一条 user 消息
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        }
      }
    }
    return '';
  }

  _extractSystemPrompt(messages) {
    const sysMsgs = messages.filter(m => m.role === 'system');
    if (sysMsgs.length === 0) return '';
    return sysMsgs.map(m => m.content).join('\n');
  }
}

// ============================================================================
// 单例
// ============================================================================

let _instance = null;

function getOpenAICompatProxy(config) {
  if (!_instance) {
    _instance = new OpenAICompatProxy(config);
  }
  return _instance;
}

module.exports = {
  OpenAICompatProxy,
  getOpenAICompatProxy,
  getApiServerConfig,
};
