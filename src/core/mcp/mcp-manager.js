/**
 * MCP 管理器 — 服务器生命周期、工具发现与注册、工具过滤
 *
 * 职责：
 * 1. 管理多个 MCP 服务器连接（Stdio / HTTP）
 * 2. 启动时自动发现并注册工具
 * 3. 支持工具过滤（include / exclude / prompts / resources）
 * 4. 工具调用路由
 * 5. 动态工具变更通知
 * 6. MCP 采样代理
 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;
const { StdioTransport } = require('./stdio-transport');
const { HttpTransport } = require('./http-transport');
const config = require('../config');

const MCP_CONFIG_PATH = path.join(config.DATA_DIR, 'mcp-servers.json');

class MCPManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, { transport: StdioTransport|HttpTransport, config: object, tools: Array, resources: Array, prompts: Array, status: string }>} */
    this._servers = new Map();
    /** @type {Map<string, { serverName: string, originalName: string, tool: object }>} */
    this._registeredTools = new Map();
    this._initialized = false;
  }

  /**
   * 初始化：加载配置并连接所有已启用的服务器
   */
  async initialize() {
    if (this._initialized) return;

    const serverConfigs = await this._loadConfig();
    for (const [name, serverConfig] of Object.entries(serverConfigs)) {
      if (serverConfig.enabled === false) continue;
      try {
        await this.addServer(name, serverConfig);
      } catch (e) {
        console.error(`🔌 MCP 服务器 ${name} 连接失败:`, e.message);
      }
    }

    this._initialized = true;
    console.log(`🔌 MCP 管理器初始化完成，${this._servers.size} 个服务器已连接`);
  }

  /**
   * 添加 MCP 服务器
   */
  async addServer(name, serverConfig) {
    if (this._servers.has(name)) {
      await this.removeServer(name);
    }

    const transport = this._createTransport(serverConfig, name);
    const entry = {
      transport,
      config: serverConfig,
      tools: [],
      resources: [],
      prompts: [],
      status: 'connecting',
    };

    this._servers.set(name, entry);

    try {
      // 连接
      await transport.connect();
      entry.status = 'connected';

      // 如果是 Stdio，需要先 initialize
      if (serverConfig.command) {
        const initResult = await transport.sendRequest('initialize', {
          clientInfo: { name: 'CrabPaw MCP Client', version: '1.0.0' },
          capabilities: { tools: {}, resources: {}, prompts: {} },
        });
        transport.sendNotification('notifications/initialized', {});

        // 保存服务器声明的能力
        entry.capabilities = initResult?.capabilities || {};
      } else {
        // HTTP 传输默认假设支持所有能力
        entry.capabilities = { tools: {}, resources: {}, prompts: {} };
      }

      // 发现工具
      await this._discoverTools(name);

      // 发现资源
      await this._discoverResources(name);

      // 发现提示
      await this._discoverPrompts(name);

      // 监听动态工具变更
      transport.on('notification', (msg) => {
        if (msg.method === 'notifications/tools/list_changed') {
          this._discoverTools(name).catch(e => console.debug('[mcp] Discovery failed:', e?.message));
        }
        if (msg.method === 'notifications/resources/list_changed') {
          this._discoverResources(name).catch(e => console.debug('[mcp] Discovery failed:', e?.message));
        }
        if (msg.method === 'notifications/prompts/list_changed') {
          this._discoverPrompts(name).catch(e => console.debug('[mcp] Discovery failed:', e?.message));
        }
      });

      // 2026-08-15 P2 修复: stdio 子进程死亡后 transport 仅置 _connected=false,
      // manager entry.status 仍谎报 'connected'。断开回调同步状态(最小改动,
      // 不引入重连——重连属新功能)。
      transport.on('disconnected', () => {
        if (this._servers.get(name) === entry && entry.status !== 'error') {
          entry.status = 'disconnected';
          console.warn(`[mcp] 服务器 ${name} 连接已断开`);
        }
      });

      this.emit('server:connected', { name });
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      this.emit('server:error', { name, error: e.message });
      throw e;
    }
  }

  /**
   * 移除 MCP 服务器
   */
  async removeServer(name) {
    const entry = this._servers.get(name);
    if (!entry) return;

    try {
      await entry.transport.disconnect();
    } catch (e) { console.warn(`[mcp] 服务器 ${name} 断开失败:`, e?.message || e); }

    // 移除已注册的工具
    for (const [toolKey, toolEntry] of this._registeredTools.entries()) {
      if (toolEntry.serverName === name) {
        this._registeredTools.delete(toolKey);
      }
    }

    // 2026-08-15 P2 修复: 移除 LLM ToolRegistry 中的 MCP 工具(此前仅清理内部
    // _registeredTools,registry 里的 mcp_<server>_* 工具残留 → LLM 仍看到已
    // 删除服务器的工具,调用必报"服务器未连接")。registry.js:468 已实现该清理。
    try {
      const { registry } = require('../../tools/registry');
      registry.unregisterBySource(`mcp:${name}`);
    } catch (e) {
      console.warn(`[mcp] 清理 LLM 注册表工具失败 (${name}):`, e?.message || e);
    }

    this._servers.delete(name);
    this.emit('server:disconnected', { name });
  }

  /**
   * 重新加载所有 MCP 服务器
   */
  async reload() {
    const names = [...this._servers.keys()];
    for (const name of names) {
      await this.removeServer(name);
    }
    this._initialized = false;
    await this.initialize();
  }

  /**
   * 重新连接指定服务器
   */
  async reconnectServer(name) {
    const entry = this._servers.get(name);
    if (!entry) throw new Error(`服务器 ${name} 不存在`);

    await this.removeServer(name);
    await this.addServer(name, entry.config);
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(toolName, args = {}, options = {}) {
    const toolEntry = this._registeredTools.get(toolName);
    if (!toolEntry) {
      throw new Error(`MCP 工具 ${toolName} 不存在`);
    }

    const entry = this._servers.get(toolEntry.serverName);
    if (!entry || entry.status !== 'connected') {
      throw new Error(`MCP 服务器 ${toolEntry.serverName} 未连接`);
    }

    // 参数摘要：仅记录键名，不记录完整参数值（防敏感信息入审计）
    const argsSummary = args && typeof args === 'object' ? Object.keys(args).join(',') : '';

    const startTime = Date.now();

    // 审计：执行前（pending 状态，确保崩溃前至少有预记录）
    try {
      const { writeAuditEntry } = require('../audit-log-v2');
      writeAuditEntry({
        event: 'tool_execute',
        actor: options.userId || 'system',
        resource: toolName,
        resourceType: 'mcp_tool',
        action: 'execute',
        result: 'pending',
        metadata: {
          serverName: toolEntry.serverName,
          originalName: toolEntry.originalName,
          argsSummary,
          argsCount: args && typeof args === 'object' ? Object.keys(args).length : 0,
        },
      });
    } catch (auditErr) {
      console.error('[mcp] 审计日志写入失败(pre):', auditErr.message);
    }

    try {
      const result = await entry.transport.sendRequest('tools/call', {
        name: toolEntry.originalName,
        arguments: args,
      });

      const duration = Date.now() - startTime;
      this.emit('tool:called', { toolName, serverName: toolEntry.serverName, duration });

      // 审计：执行成功
      try {
        const { writeAuditEntry } = require('../audit-log-v2');
        writeAuditEntry({
          event: 'tool_execute',
          actor: options.userId || 'system',
          resource: toolName,
          resourceType: 'mcp_tool',
          action: 'execute',
          result: 'success',
          durationMs: duration,
          metadata: {
            serverName: toolEntry.serverName,
            originalName: toolEntry.originalName,
            argsSummary,
          },
        });
      } catch (auditErr) {
        console.error('[mcp] 审计日志写入失败(post-success):', auditErr.message);
      }

      return result;
    } catch (e) {
      const duration = Date.now() - startTime;
      this.emit('tool:error', { toolName, serverName: toolEntry.serverName, duration, error: e.message });

      // 审计：执行失败
      try {
        const { writeAuditEntry } = require('../audit-log-v2');
        writeAuditEntry({
          event: 'tool_execute',
          actor: options.userId || 'system',
          resource: toolName,
          resourceType: 'mcp_tool',
          action: 'execute',
          result: 'failed',
          durationMs: duration,
          reason: this.redactReason(e.message),
          errorCode: e.code || null,
          metadata: {
            serverName: toolEntry.serverName,
            originalName: toolEntry.originalName,
            argsSummary,
          },
        });
      } catch (auditErr) {
        console.error('[mcp] 审计日志写入失败(post-fail):', auditErr.message);
      }

      throw e;
    }
  }

  /**
   * 读取 MCP 资源
   */
  async readResource(serverName, uri) {
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }

    return await entry.transport.sendRequest('resources/read', { uri });
  }

  /**
   * 获取 MCP 提示
   */
  async getPrompt(serverName, name, args = {}) {
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') {
      throw new Error(`MCP 服务器 ${serverName} 未连接`);
    }

    return await entry.transport.sendRequest('prompts/get', { name, arguments: args });
  }

  /**
   * MCP 采样 — MCP 服务器请求 LLM 推理
   */
  async handleSampling(serverName, params) {
    const entry = this._servers.get(serverName);
    if (!entry) throw new Error(`服务器 ${serverName} 不存在`);

    const samplingConfig = entry.config.sampling || {};
    if (samplingConfig.enabled === false) {
      throw new Error(`服务器 ${serverName} 的采样功能已禁用`);
    }

    // 速率限制
    const maxRpm = samplingConfig.maxRpm || 10;
    if (!this._checkRateLimit(serverName, maxRpm)) {
      throw new Error(`服务器 ${serverName} 采样速率超限 (${maxRpm} RPM)`);
    }

    // 最大 token 限制
    const maxTokensCap = samplingConfig.maxTokensCap || 4096;
    const requestedTokens = params.maxTokens || 1024;
    const cappedTokens = Math.min(requestedTokens, maxTokensCap);

    // 超时
    const timeout = samplingConfig.timeout || 30;

    // 模型白名单
    const allowedModels = samplingConfig.allowedModels || [];
    if (allowedModels.length > 0 && params.model && !allowedModels.includes(params.model)) {
      throw new Error(`模型 ${params.model} 不在白名单中`);
    }

    // 调用 LLM
    const { getModelRouter } = require('../model-router');
    // eslint-disable-next-line no-unused-vars -- getModelRouter() 调用可能有副作用不可删
    const router = getModelRouter();

    // 2026-08-15 P2 清理: 删除未使用的 AbortController/timer(controller.abort()
    // 从未接线——超时由 callLlm 的 timeout 参数负责);taskType 硬编码 'translation'
    // 会劫持用户为翻译任务配置的 aux provider,删除后走通用 fallback chain(chat)。
    try {
      const { getAuxiliaryClient } = require('../auxiliary-client');
      const client = getAuxiliaryClient();
      if (!client) {
        throw new Error('辅助客户端未配置');
      }

      const result = await client.callLlm({
        messages: params.messages,
        maxTokens: cappedTokens,
        temperature: params.temperature || 0.7,
        timeout: timeout * 1000,
      });

      return {
        role: 'assistant',
        content: { type: 'text', text: typeof result === 'string' ? result : result?.content || '' },
        model: result?.model || '',
      };
    } catch (e) {
      console.error('[mcp] 采样 LLM 调用失败:', e?.message || e);
      throw e;
    }
  }

  // ===== 安全分级 =====

  /**
   * 推断 MCP 工具是否危险。
   *
   * 优先级：
   * 1. serverConfig.tools.dangerous 数组显式白名单（工具名精确匹配）
   * 2. 工具名/描述关键词推断（exec|delete|drop|remove|update|write|send|create|upload）
   *
   * @param {string} toolName - 原始工具名
   * @param {string} description - 工具描述
   * @param {object} serverConfig - 服务器配置
   * @returns {boolean}
   */
  _inferIsDangerous(toolName, description, serverConfig) {
    // 1. 配置显式声明 dangerous 数组
    const dangerousList = serverConfig?.tools?.dangerous;
    if (Array.isArray(dangerousList) && dangerousList.includes(toolName)) {
      return true;
    }

    // 2. 关键词推断（在非显式声明时生效）
    const DANGEROUS_KEYWORDS = /(?:^|[_.\-\s])(exec|delete|drop|remove|update|write|send|create|upload)(?=$|[_.\-\s])/i;
    // 描述匹配仅针对首句（按句号/换行截断），避免"Get system status updates"等过宽误判
    const firstSentence = (description || '').split(/[.\n\r]/)[0];
    if (DANGEROUS_KEYWORDS.test(toolName) || DANGEROUS_KEYWORDS.test(firstSentence)) {
      return true;
    }

    return false;
  }

  // ===== 审计辅助 =====

  /**
   * 审计 reason 脱敏 + 截断，防止 MCP server 错误回显敏感参数值。
   * - 截断至 ≤200 字符
   * - 正则脱敏 Bearer token、key=secret 等常见凭证模式
   * @param {string} msg
   * @returns {string}
   */
  redactReason(msg) {
    if (!msg) return '';
    let sanitized = msg.length > 200 ? msg.slice(0, 200) + '...' : msg;
    // Bearer token
    sanitized = sanitized.replace(/(?:bearer\s+)\S+/gi, 'Bearer [REDACTED]');
    // key=secret / token:value 等模式
    sanitized = sanitized.replace(/\b(?:token|secret|api_?key|password|credential)\s*[=:]\s*\S+/gi, (m) => {
      const sep = m.match(/[=:]/)[0];
      const key = m.slice(0, m.indexOf(sep));
      return key + sep + '[REDACTED]';
    });
    return sanitized;
  }

  // ===== 工具发现 =====

  /**
   * 规范化工具名称：连字符/点号转下划线
   */
  _normalizeToolName(name) {
    return name.replace(/[-.]/g, '_');
  }

  async _discoverTools(serverName) {
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') return;

    // 能力感知：检查服务器是否声明了 tools 能力
    const serverCapabilities = entry.capabilities || {};
    if (serverCapabilities.tools === false) {
      entry.tools = [];
      console.log(`🔌 MCP ${serverName}: 服务器未声明 tools 能力，跳过工具发现`);
      return;
    }

    try {
      const result = await entry.transport.sendRequest('tools/list');
      const tools = result.tools || [];

      // 应用过滤
      const filtered = this._filterTools(serverName, tools);
      entry.tools = filtered;

      // 注册到全局工具表（名称规范化）
      for (const tool of filtered) {
        const normalizedName = this._normalizeToolName(tool.name);
        const registeredName = `mcp_${serverName}_${normalizedName}`;
        this._registeredTools.set(registeredName, {
          serverName,
          originalName: tool.name,
          normalizedOriginalName: normalizedName,
          tool,
        });
      }

      // 2026-08-01: 注册到 ToolRegistry — MCP 工具此前从未进入 LLM 工具链
      // （ai.js 用 registry.getAll()，MCP 工具不在其中，LLM 无法调用）。
      try {
        const { registry } = require('../../tools/registry');
        for (const tool of filtered) {
          const normalizedName = this._normalizeToolName(tool.name);
          const registeredName = `mcp_${serverName}_${normalizedName}`;
          registry.register({
            name: registeredName,
            toolset: `mcp-${serverName}`,
            category: 'mcp',
            description: `[MCP:${serverName}] ${tool.description || tool.name}`,
            schema: {
              type: 'object',
              properties: tool.inputSchema?.properties || {},
              required: tool.inputSchema?.required || [],
              additionalProperties: false,
            },
            handler: async (params) => {
              const res = await this.callTool(registeredName, params);
              // MCP 响应适配：content 数组转纯文本（LLM 友好）
              if (res && Array.isArray(res.content)) {
                const text = res.content.map(c => (c && c.text) || '').filter(Boolean).join('\n');
                return { success: true, content: text, data: res };
              }
              return { success: true, data: res };
            },
            isDangerous: this._inferIsDangerous(tool.name, tool.description, entry.config),
            isReadOnly: !this._inferIsDangerous(tool.name, tool.description, entry.config),
            source: `mcp:${serverName}`,
          });

          // 2026-08-08: 动态契约注册 — 用 MCP 工具的 inputSchema 生成 TOOL_CONTRACTS 条目
          // 为每个 MCP 工具自动注册契约，支持参数校验与安全治理
          try {
            const { registerToolContract } = require('../tool-contract');
            const contractName = `mcp_${serverName}_${normalizedName}`;
            registerToolContract(contractName, {
              description: `[MCP:${serverName}] ${tool.description || tool.name}`,
              schema: {
                type: 'object',
                properties: tool.inputSchema?.properties || {},
                required: tool.inputSchema?.required || [],
                additionalProperties: false,
              },
              riskLevel: this._inferIsDangerous(tool.name, tool.description, entry.config) ? 'high' : 'medium',
              whenNotToUse: `Auto-registered MCP tool contract (server: ${serverName})`,
            });
          } catch (contractErr) {
            console.warn(`🔌 MCP ${serverName}: 注册工具契约 ${tool.name} 失败: ${contractErr.message}`);
          }
        }
      } catch (e) {
        console.warn(`🔌 MCP ${serverName}: 注册工具到 ToolRegistry 失败: ${e.message}`);
      }

      // 注册到工具集管理器
      try {
        const { getToolsetManager } = require('../toolset-manager');
        const tsm = getToolsetManager();
        tsm.registerMCPToolset(serverName, filtered.map(t => `mcp_${serverName}_${this._normalizeToolName(t.name)}`));
        // 2026-08-21: 注册即激活——用户配置并连接的服务器工具默认对 LLM 可见。
        // 此前仅注册不激活: buildToolDefinitions 按活跃集过滤时 MCP 工具被滤掉
        //（AIGoHotel 实测: 工具已注册但 LLM 看不到）
        tsm.activateToolset(`mcp-${serverName}`);
      } catch (e) { console.warn(`[mcp] 注册工具集失败 (${serverName}):`, e?.message || e); }

      this.emit('tools:discovered', { serverName, count: filtered.length });
      console.log(`🔌 MCP ${serverName}: 发现 ${filtered.length} 个工具 (共 ${tools.length} 个)`);
    } catch (e) {
      // 服务器可能不支持工具(或工具发现失败)——此前静默置空无从排查,改为告警
      console.warn(`🔌 MCP ${serverName}: 工具发现失败:`, e?.message || e);
      entry.tools = [];
    }
  }

  async _discoverResources(serverName) {
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') return;

    // 能力感知：检查是否声明了 resources 能力
    const serverCapabilities = entry.capabilities || {};
    if (serverCapabilities.resources === false) {
      entry.resources = [];
      return;
    }

    const toolsConfig = entry.config.tools || {};
    if (toolsConfig.resources === false) {
      entry.resources = [];
      return;
    }

    try {
      const result = await entry.transport.sendRequest('resources/list');
      entry.resources = result.resources || [];
    } catch (e) {
      console.warn(`🔌 MCP ${serverName}: 资源发现失败:`, e?.message || e);
      entry.resources = [];
    }

    // 注册资源实用工具
    if (entry.resources.length > 0) {
      const listName = `mcp_${serverName}_list_resources`;
      const readName = `mcp_${serverName}_read_resource`;

      this._registeredTools.set(listName, {
        serverName,
        originalName: '__list_resources__',
        tool: {
          name: listName,
          description: `列出 ${serverName} 服务器的可用资源`,
          inputSchema: { type: 'object', properties: {} },
        },
      });

      this._registeredTools.set(readName, {
        serverName,
        originalName: '__read_resource__',
        tool: {
          name: readName,
          description: `读取 ${serverName} 服务器的资源`,
          inputSchema: {
            type: 'object',
            properties: {
              uri: { type: 'string', description: '资源 URI' },
            },
            required: ['uri'],
          },
        },
      });
    }
  }

  async _discoverPrompts(serverName) {
    const entry = this._servers.get(serverName);
    if (!entry || entry.status !== 'connected') return;

    // 能力感知：检查是否声明了 prompts 能力
    const serverCapabilities = entry.capabilities || {};
    if (serverCapabilities.prompts === false) {
      entry.prompts = [];
      return;
    }

    const toolsConfig = entry.config.tools || {};
    if (toolsConfig.prompts === false) {
      entry.prompts = [];
      return;
    }

    try {
      const result = await entry.transport.sendRequest('prompts/list');
      entry.prompts = result.prompts || [];
    } catch (e) {
      console.warn(`🔌 MCP ${serverName}: 提示发现失败:`, e?.message || e);
      entry.prompts = [];
    }

    // 注册提示实用工具
    if (entry.prompts.length > 0) {
      const listName = `mcp_${serverName}_list_prompts`;
      const getName = `mcp_${serverName}_get_prompt`;

      this._registeredTools.set(listName, {
        serverName,
        originalName: '__list_prompts__',
        tool: {
          name: listName,
          description: `列出 ${serverName} 服务器的可用提示`,
          inputSchema: { type: 'object', properties: {} },
        },
      });

      this._registeredTools.set(getName, {
        serverName,
        originalName: '__get_prompt__',
        tool: {
          name: getName,
          description: `获取 ${serverName} 服务器的提示`,
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '提示名称' },
              arguments: { type: 'object', description: '提示参数' },
            },
            required: ['name'],
          },
        },
      });
    }
  }

  // ===== 工具过滤 =====

  _filterTools(serverName, tools) {
    const toolsConfig = this._servers.get(serverName)?.config?.tools || {};
    const include = toolsConfig.include;
    const exclude = toolsConfig.exclude;

    let filtered = tools;

    if (include && Array.isArray(include)) {
      // 白名单模式
      const includeSet = new Set(include);
      filtered = tools.filter(t => includeSet.has(t.name));
    } else if (exclude && Array.isArray(exclude)) {
      // 黑名单模式
      const excludeSet = new Set(exclude);
      filtered = tools.filter(t => !excludeSet.has(t.name));
    }

    // include 优先级高于 exclude
    return filtered;
  }

  // ===== 速率限制 =====

  _rateLimitCounters = new Map();

  _checkRateLimit(serverName, maxRpm) {
    const now = Date.now();
    const key = serverName;
    const counter = this._rateLimitCounters.get(key) || { count: 0, windowStart: now };

    // 重置窗口
    if (now - counter.windowStart > 60000) {
      counter.count = 0;
      counter.windowStart = now;
    }

    counter.count++;
    this._rateLimitCounters.set(key, counter);

    return counter.count <= maxRpm;
  }

  // ===== 传输层创建 =====

  _createTransport(serverConfig, serverName) {
    if (serverConfig.command) {
      return new StdioTransport({
        command: serverConfig.command,
        args: serverConfig.args || [],
        env: serverConfig.env || {},
        timeout: serverConfig.timeout || 30000,
        connectTimeout: serverConfig.connectTimeout || 10000,
      });
    } else if (serverConfig.url) {
      // 2026-08-15 P1-6: 此前不传 oauth/serverId → http-transport 的 Bearer 注入
      // 分支永不可达。serverId 统一用服务器名作为 token 存储键。
      return new HttpTransport({
        url: serverConfig.url,
        headers: serverConfig.headers || {},
        timeout: serverConfig.timeout || 30000,
        connectTimeout: serverConfig.connectTimeout || 10000,
        oauth: serverConfig.oauth || null,
        serverId: serverName || serverConfig.oauth?.serverId || null,
      });
    } else {
      throw new Error('MCP 服务器配置必须包含 command (Stdio) 或 url (HTTP)');
    }
  }

  // ===== 配置持久化 =====

  async _loadConfig() {
    try {
      const data = await fs.readFile(MCP_CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.debug('[mcp] 无 MCP 服务器配置(或解析失败),返回空配置:', e?.message || e);
      return {};
    }
  }

  async _saveConfig(serverConfigs) {
    await fs.mkdir(path.dirname(MCP_CONFIG_PATH), { recursive: true });
    await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(serverConfigs, null, 2), 'utf-8');
  }

  async saveServerConfig(name, serverConfig) {
    const configs = await this._loadConfig();
    configs[name] = serverConfig;
    await this._saveConfig(configs);
  }

  async deleteServerConfig(name) {
    const configs = await this._loadConfig();
    delete configs[name];
    await this._saveConfig(configs);
  }

  // ===== 查询接口 =====

  getServers() {
    const result = [];
    for (const [name, entry] of this._servers.entries()) {
      result.push({
        name,
        type: entry.config.command ? 'stdio' : 'http',
        status: entry.status,
        error: entry.error || null,
        toolCount: entry.tools.length,
        resourceCount: entry.resources.length,
        promptCount: entry.prompts.length,
        config: {
          command: entry.config.command || null,
          url: entry.config.url || null,
          enabled: entry.config.enabled !== false,
          tools: entry.config.tools || {},
          sampling: entry.config.sampling || {},
        },
      });
    }
    return result;
  }

  getServer(name) {
    const entry = this._servers.get(name);
    if (!entry) return null;
    return {
      name,
      type: entry.config.command ? 'stdio' : 'http',
      status: entry.status,
      error: entry.error || null,
      tools: entry.tools,
      resources: entry.resources,
      prompts: entry.prompts,
      config: entry.config,
    };
  }

  getRegisteredTools() {
    const result = [];
    for (const [name, entry] of this._registeredTools.entries()) {
      result.push({
        name,
        serverName: entry.serverName,
        originalName: entry.originalName,
        description: entry.tool.description || '',
        inputSchema: entry.tool.inputSchema || { type: 'object', properties: {} },
      });
    }
    return result;
  }

  /**
   * 获取工具定义列表（供 LLM function calling 使用）
   */
  getToolDefinitions() {
    return this.getRegisteredTools().map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  getStats() {
    return {
      servers: this._servers.size,
      connectedServers: [...this._servers.values()].filter(s => s.status === 'connected').length,
      registeredTools: this._registeredTools.size,
    };
  }
}

// 单例
let _instance = null;

function getMCPManager() {
  if (!_instance) {
    _instance = new MCPManager();
  }
  return _instance;
}

module.exports = { MCPManager, getMCPManager };
