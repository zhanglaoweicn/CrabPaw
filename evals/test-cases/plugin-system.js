/**
 * E2E Test: Plugin System + MCP (P1)
 *
 * 插件体系冒烟闭环（2026-08-01 新增，此前插件/MCP 零测试覆盖）：
 * - manifest 解析与校验
 * - PluginManager 加载真实内置插件
 * - bindRegistries 后工具贡献注册
 * - UIRegistry 路由注册
 * - MCPManager 初始化（无配置不崩）
 * - MCP 协议层基本行为
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getPluginManager, PluginManager } = require('../../src/core/plugin/plugin-manager');
const { readManifest, validateManifest, PLUGIN_KINDS } = require('../../src/core/plugin/manifest');
const { getUIRegistry } = require('../../src/core/plugin/ui-registry');
const { getMCPManager } = require('../../src/core/mcp/mcp-manager');

function uniqueTag(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
}

// 创建临时测试插件目录（含 tools 贡献）
function createTempPlugin() {
  const dir = path.join(os.tmpdir(), `crabpaw-plugin-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `test-plugin-${Date.now()}`;
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), [
    `name: ${name}`,
    'version: 1.0.0',
    'kind: plugin',
    'description: "eval test plugin"',
    'contributions:',
    '  tools:',
    `    - name: ${name}_ping`,
    '      description: "eval test tool"',
    '      handler: ./handler.js',
  ].join('\n'), 'utf-8');
  fs.writeFileSync(path.join(dir, 'handler.js'), [
    'module.exports = async (params) => ({ success: true, data: { pong: params.input || "ok" } });',
  ].join('\n'), 'utf-8');
  return { dir, name };
}

module.exports = {
  name: 'Plugin System Tests',
  cases: [
    {
      id: 'plg_001',
      name: 'readManifest parses YAML manifest',
      category: 'plugin',
      tags: ['P1', 'cap:plugin', 'severity:major'],
      run: async () => {
        const { dir, name } = createTempPlugin();
        try {
          const manifest = await readManifest(dir);
          return !!manifest && manifest.name === name && manifest.version === '1.0.0';
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'plg_002',
      name: 'validateManifest rejects invalid manifest',
      category: 'plugin',
      tags: ['P1', 'cap:plugin'],
      run: () => {
        const result = validateManifest({ version: '1.0.0' }); // 缺 name
        return result.valid === false;
      },
    },
    {
      id: 'plg_003',
      name: 'PluginManager loads real builtin plugins',
      category: 'plugin',
      tags: ['P1', 'cap:plugin'],
      run: async () => {
        const pm = new PluginManager();
        await pm.initialize();
        await pm.autoLoad();
        // builtin plugins/ 目录应有至少 3 个可加载插件
        return pm.loaded.size >= 3;
      },
    },
    {
      id: 'plg_004',
      name: 'bindRegistries enables tool contributions',
      category: 'plugin',
      tags: ['P1', 'cap:plugin', 'severity:major'],
      run: async () => {
        const { dir, name } = createTempPlugin();
        const pm = new PluginManager();
        await pm.initialize();
        const { registry } = require('../../src/tools/registry');
        const { getEventBus } = require('../../src/core/events');
        pm.bindRegistries({ toolRegistry: registry, eventBus: getEventBus() });
        try {
          await pm.load(dir, { source: 'test' });
          const toolName = `${name}_ping`;
          const tool = registry.get(toolName);
          if (!tool) return false;
          const result = await tool.handler({ input: 'hello' });
          return result.success === true && result.data.pong === 'hello';
        } finally {
          pm.unload ? await pm.unload(name) : null;
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'plg_005',
      name: 'UIRegistry rejects UI contribution (deprecated since PluginBridge removal)',
      category: 'plugin',
      tags: ['P2', 'cap:plugin'],
      run: async () => {
        // 2026-08-25 S1-5: UI 贡献（routes/sidebar/settings）已弃用——
        // 前端 PluginBridge 已随 6a1d730 移除，注册即死链。契约对齐：
        // 声明 UI 贡献的插件照常可加载，但注册被拒绝（UIRegistry 保持空）。
        const dir = path.join(os.tmpdir(), `crabpaw-ui-plugin-${Date.now()}`);
        fs.mkdirSync(dir, { recursive: true });
        const routePath = `/plugin-test-${Date.now()}`;
        fs.writeFileSync(path.join(dir, 'manifest.yaml'), [
          'name: ui-test-plugin',
          'version: 1.0.0',
          'kind: plugin',
          'description: "eval ui test"',
          'contributes:',
          '  ui:',
          '    routes:',
          `      - path: ${routePath}`,
          '        component: test-page',
          '        label: 测试页',
          '        icon: Test',
        ].join('\n'), 'utf-8');
        const ui = getUIRegistry();
        const before = ui.getRoutes().length;
        const pm = new PluginManager();
        await pm.initialize();
        try {
          await pm.load(dir, { source: 'test' });
          return ui.getRoutes().length === before; // 拒绝注册：不产生死链贡献
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'mcp_001',
      name: 'MCPManager initializes without config without crash',
      category: 'plugin',
      tags: ['P1', 'cap:mcp'],
      run: async () => {
        const mcp = await getMCPManager();
        await mcp.initialize();
        return mcp._initialized === true;
      },
    },
    {
      id: 'mcp_002',
      name: 'MCP protocol createMCPServer returns server with methods',
      category: 'plugin',
      tags: ['P2', 'cap:mcp'],
      run: () => {
        const { createMCPServer } = require('../../src/core/mcp/protocol');
        const server = createMCPServer({ name: 'test-server' });
        return !!server && typeof server.handleRequest === 'function';
      },
    },
  ],
};
