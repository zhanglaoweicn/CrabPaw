/**
 * MCP 请求处理器 - 从 request-handler.js 提取
 *
 * 处理所有 MCP（Model Context Protocol）相关的 API 请求
 */

const { getMCPManager } = require('../../core/mcp/mcp-manager');
const { handleMCPServerRequest } = require('../../core/mcp/mcp-server-mode');
const { readJsonBody } = require('../../handlers/http-utils');

/**
 * 创建 MCP 处理器集合
 * @param {Function} sendJson - JSON 响应发送函数
 * @returns {Object} MCP 处理器映射
 */
function createMCPHandlers(sendJson) {
  function _getMCP() {
    return getMCPManager();
  }

  return {
    async handleMCPServers(req, res, _ctx) {
      try {
        const manager = _getMCP();
        let servers = manager.getServers();
        // 2026-08-26 审计 B1: enabled:false 的服务器被 initialize 跳过→getServers 只返
        // 运行态, UI 列表里完全消失且无启停入口(幽灵配置: 重启后又出现)。
        // 合并盘上未加载配置, 以 status:'disabled' 入列表, 前端可见可启停。
        try {
          const disk = await manager._loadConfig();
          const known = new Set(servers.map(s => s.name));
          for (const [name, cfg] of Object.entries(disk || {})) {
            if (known.has(name)) continue;
            servers = servers.concat({
              name,
              command: cfg.command || '', url: cfg.url || '',
              type: cfg.type || 'stdio', enabled: cfg.enabled !== false,
              tools: cfg.tools || { allow: [], block: [] }, sampling: cfg.sampling || null,
              config: cfg,
              status: 'disabled',
            });
          }
        } catch (e) { console.warn('[mcp] 合并盘上配置失败(不影响运行态):', e?.message || e); }
        const stats = manager.getStats();
        return sendJson(res, 200, { success: true, data: { servers, stats } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerAdd(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { name, ...serverConfig } = body;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        if (!serverConfig.command && !serverConfig.url) {
          return sendJson(res, 400, { success: false, message: '必须配置 command (Stdio) 或 url (HTTP)' });
        }

        const manager = _getMCP();
        await manager.saveServerConfig(name, serverConfig);

        try {
          await manager.addServer(name, serverConfig);
          return sendJson(res, 200, { success: true, data: { name, status: 'connected' } });
        } catch (e) {
          return sendJson(res, 200, { success: true, data: { name, status: 'error', error: e.message } });
        }
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerUpdate(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { name, ...serverConfig } = body;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        // 2026-08-26 审计 B3(数据破坏级): 此前 saveServerConfig(name, serverConfig)
        // 整条替换盘上配置——工具过滤/采样编辑器只发 {tools}/{sampling} 补丁,
        // 保存后盘上条目只剩补丁(缺 type/url/command/enabled), 重载/重启后服务器消失。
        // 改为合并补丁: 保留既有字段, 仅覆盖 body 携带的键。
        try {
          const existing = await manager._loadConfig();
          await manager.saveServerConfig(name, { ...(existing[name] || {}), ...serverConfig });
        } catch (e) {
          console.warn('[mcp] 合并服务器配置失败(退回补丁保存):', e?.message || e);
          await manager.saveServerConfig(name, serverConfig);
        }

        try {
          // 2026-08-28 审计 CK1: disabled 服务器不在运行态——编辑工具过滤/采样不应
          // 顺带报 error(旧实现 reconnectServer 抛「不存在」被吞成 status:'error')。
          // 仅运行态服务器才 reconnect; disabled 保持停用态如实返回。
          if (manager.getServer(name)) {
            await manager.reconnectServer(name);
            return sendJson(res, 200, { success: true, data: { name, status: 'connected' } });
          }
          return sendJson(res, 200, { success: true, data: { name, status: 'disabled' } });
        } catch (e) {
          return sendJson(res, 200, { success: true, data: { name, status: 'error', error: e.message } });
        }
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerDelete(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { name } = body;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        await manager.removeServer(name);
        await manager.deleteServerConfig(name);

        return sendJson(res, 200, { success: true, data: { name } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerConnect(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { name } = body;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        // 2026-08-28 审计 CK1: disabled 服务器不在运行态(initialize 跳过 enabled===false),
        // 旧实现 getServer 恒 null → 404「服务器不存在」死循环——B1 幽灵配置修复只兑现了
        // 「可见」没兑现「可启停」。此处补启用链: 盘上有配置 → 落盘 enabled:true + addServer。
        let server = manager.getServer(name);
        if (!server) {
          const disk = await manager._loadConfig();
          const cfg = disk && disk[name];
          if (!cfg) {
            return sendJson(res, 404, { success: false, message: `服务器 ${name} 不存在` });
          }
          const enabledCfg = { ...cfg, enabled: true };
          await manager.saveServerConfig(name, enabledCfg);
          await manager.addServer(name, enabledCfg);
          // addServer 自带连接——如实返回装载后状态(失败时为 error + error 字段)
          server = manager.getServer(name);
          return sendJson(res, 200, { success: true, data: { name, status: server?.status || 'connected', error: server?.error || null } });
        }

        await manager.reconnectServer(name);
        return sendJson(res, 200, { success: true, data: { name, status: server?.status || 'connected' } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerDisconnect(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { name } = body;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        await manager.removeServer(name);
        return sendJson(res, 200, { success: true, data: { name } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerTools(req, res, ctx) {
      try {
        const match = ctx.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/tools$/);
        const name = match ? match[1] : null;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        const server = manager.getServer(name);
        if (!server) {
          return sendJson(res, 404, { success: false, message: `服务器 ${name} 不存在` });
        }

        return sendJson(res, 200, { success: true, data: { tools: server.tools || [] } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerResources(req, res, ctx) {
      try {
        const match = ctx.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/resources$/);
        const name = match ? match[1] : null;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        const server = manager.getServer(name);
        if (!server) {
          return sendJson(res, 404, { success: false, message: `服务器 ${name} 不存在` });
        }

        return sendJson(res, 200, { success: true, data: { resources: server.resources || [] } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerPrompts(req, res, ctx) {
      try {
        const match = ctx.pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/prompts$/);
        const name = match ? match[1] : null;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        const server = manager.getServer(name);
        if (!server) {
          return sendJson(res, 404, { success: false, message: `服务器 ${name} 不存在` });
        }

        return sendJson(res, 200, { success: true, data: { prompts: server.prompts || [] } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPReload(req, res, _ctx) {
      try {
        const manager = _getMCP();
        await manager.reload();
        return sendJson(res, 200, { success: true, data: manager.getStats() });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPToolCall(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { name, arguments: args } = body;

        if (!name) {
          return sendJson(res, 400, { success: false, message: '缺少工具名称' });
        }

        const manager = _getMCP();
        const result = await manager.callTool(name, args || {});
        return sendJson(res, 200, { success: true, data: result });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPToolDefinitions(req, res, _ctx) {
      try {
        const manager = _getMCP();
        const definitions = manager.getToolDefinitions();
        const tools = manager.getRegisteredTools();
        return sendJson(res, 200, { success: true, data: { definitions, tools } });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPSampling(req, res, _ctx) {
      try {
        let body = {};
        try { body = await readJsonBody(req); } catch (e) { console.warn('[mcp] body 解析失败:', e?.message || e); }
        const { serverName, params } = body;

        if (!serverName) {
          return sendJson(res, 400, { success: false, message: '缺少服务器名称' });
        }

        const manager = _getMCP();
        const result = await manager.handleSampling(serverName, params || {});
        return sendJson(res, 200, { success: true, data: result });
      } catch (e) {
        return sendJson(res, 500, { success: false, message: e.message });
      }
    },

    async handleMCPServerModeEndpoint(req, res, ctx) {
      await handleMCPServerRequest(req, res, ctx);
    },
  };
}

module.exports = { createMCPHandlers };
