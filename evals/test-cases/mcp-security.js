/**
 * Eval Suite: MCP Security（P1 — Task 4）
 *
 * 覆盖：工具安全分级（isDangerous 推断/配置覆盖）、callTool 审计日志、动态契约注册。
 */
const { MCPManager } = require('../../src/core/mcp/mcp-manager');
const { writeAuditEntry, queryAuditLog } = require('../../src/core/audit-log-v2');
const { registerToolContract, getToolContract } = require('../../src/core/tool-contract');

module.exports = {
  name: 'MCP Security',
  cases: [
    // =========================================================================
    // ms_001 — Dangerous 推断规则（工具名/描述关键词）
    // =========================================================================
    {
      id: 'ms_001',
      name: 'dangerous inference from tool name/description keywords',
      category: 'mcp_security',
      run: () => {
        const manager = new MCPManager();
        // 危险关键词命中
        const r1 = manager._inferIsDangerous('file_exec', 'Execute a file', {});
        const r2 = manager._inferIsDangerous('delete_record', 'Delete user record', {});
        const r3 = manager._inferIsDangerous('drop_table', 'Drop table from db', {});
        const r4 = manager._inferIsDangerous('remove_user', 'Remove user from group', {});
        const r5 = manager._inferIsDangerous('update_config', 'Update config values', {});
        const r6 = manager._inferIsDangerous('write_file', 'Write data to file', {});
        const r7 = manager._inferIsDangerous('send_message', 'Send message to channel', {});
        const r8 = manager._inferIsDangerous('create_account', 'Create new account', {});
        const r9 = manager._inferIsDangerous('upload_doc', 'Upload document', {});

        // 非危险工具（不应命中）
        const r10 = manager._inferIsDangerous('list_files', 'List files in directory', {});
        const r11 = manager._inferIsDangerous('read_config', 'Read configuration', {});
        const r12 = manager._inferIsDangerous('get_status', 'Get server status', {});
        const r13 = manager._inferIsDangerous('search_docs', 'Search documentation', {});

        // 描述中含危险关键词也命中
        const r14 = manager._inferIsDangerous('manage_users', 'Tool to delete and update users', {});

        return r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9
          && !r10 && !r11 && !r12 && !r13 && r14;
      },
    },

    // =========================================================================
    // ms_002 — 审计调用记录（callTool 集成 writeAuditEntry）
    // =========================================================================
    {
      id: 'ms_002',
      name: 'callTool writes audit entries before and after execution',
      category: 'mcp_security',
      run: async () => {
        const manager = new MCPManager();

        // 手动搭建最小假状态（无需真实 MCP 服务器）
        manager._servers.set('audit-test-server', {
          transport: {
            sendRequest: async () => {
              throw new Error('mock transport — audit test');
            },
          },
          config: {},
          tools: [],
          status: 'connected',
        });
        manager._registeredTools.set('mcp_audit_test_server_test_tool', {
          serverName: 'audit-test-server',
          originalName: 'test_tool',
          tool: {
            name: 'test_tool',
            description: 'Test tool for audit',
            inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
          },
        });

        // 调用 — 预期抛异常但审计已写入
        let callErr = null;
        try {
          await manager.callTool('mcp_audit_test_server_test_tool', { input: 'hello' });
        } catch (e) {
          callErr = e;
        }

        if (!callErr) return false;

        // 查审计日志：应有至少一条 tool_execute 记录（pending 或 failed）
        const entries = queryAuditLog({
          resource: 'mcp_audit_test_server_test_tool',
          limit: 10,
        });

        // 至少有一条 pending + 一条 failed
        const pendingEntries = entries.filter(e => e.result === 'pending');
        const failedEntries = entries.filter(e => e.result === 'failed');
        const hasArgsSummary = entries.some(e => {
          const md = e.metadata || {};
          return typeof md.argsSummary === 'string' && md.argsSummary.includes('input');
        });
        const noArgValues = entries.every(e => {
          const metaStr = JSON.stringify(e.metadata || {});
          // 参数摘要中不应出现完整参数值 "hello"
          return !metaStr.includes('"hello"');
        });

        return pendingEntries.length >= 1 && failedEntries.length >= 1 && hasArgsSummary && noArgValues;
      },
    },

    // =========================================================================
    // ms_003 — 动态契约注册（registerToolContract from inputSchema）
    // =========================================================================
    {
      id: 'ms_003',
      name: 'dynamic tool contract registration from MCP inputSchema',
      category: 'mcp_security',
      run: () => {
        // 模拟 _discoverTools 中的动态注册逻辑：用 MCP 工具的 inputSchema 注册契约
        const contractName = 'mcp_test_srv_dynamic_tool';
        registerToolContract(contractName, {
          description: '[MCP:test-srv] Dynamic tool for contract test',
          schema: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number' } },
            required: ['query'],
            additionalProperties: false,
          },
          riskLevel: 'medium',
          whenNotToUse: 'Auto-registered MCP tool contract',
        });

        const contract = getToolContract(contractName);
        if (!contract) return false;

        // 校验有效输入通过
        const validResult = contract.validate({ query: 'test', limit: 10 });
        // 校验缺失必填字段拦截
        const invalidResult = contract.validate({ limit: 5 });

        return !!contract && validResult && !invalidResult;
      },
    },

    // =========================================================================
    // ms_004 — 配置覆盖（tools.dangerous 配置优先于推断）
    // =========================================================================
    {
      id: 'ms_004',
      name: 'config tools.dangerous array overrides inference',
      category: 'mcp_security',
      run: () => {
        const manager = new MCPManager();

        // 无配置时：list_files 不算危险
        const r1 = manager._inferIsDangerous('list_files', 'List files', {});
        if (r1) return false; // 无配置时不应判为危险

        // 配置了 tools.dangerous 数组：list_files 被显式标记为危险
        const config = { tools: { dangerous: ['list_files', 'read_config'] } };
        const r2 = manager._inferIsDangerous('list_files', 'List files', config);
        const r3 = manager._inferIsDangerous('read_config', 'Read config', config);
        // delete_record 不在 dangerous 数组中，但名称推断仍应命中
        const r4 = manager._inferIsDangerous('delete_record', 'Delete record', config);

        // 空数组不应改变推断行为
        const emptyConfig = { tools: { dangerous: [] } };
        const r5 = manager._inferIsDangerous('list_files', 'List files', emptyConfig);

        return r2 && r3 && r4 && !r5;
      },
    },
  ],
};
