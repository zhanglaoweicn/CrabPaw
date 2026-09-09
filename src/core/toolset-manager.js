/**
 * 工具集管理器 (Toolset Manager)
 *
 * - 核心工具集：按功能分组（file、terminal、web、browser 等）
 * - 复合工具集：多核心工具集组合（debugging、safe 等）
 * - 平台工具集：按部署目标自动配置（cli、api-server、lark 等）
 * - 自定义工具集：用户在 config 中定义组合
 * - MCP 动态工具集：每个 MCP 服务器自动生成 mcp-<server> 工具集
 */

const { registry } = require('../tools/registry');

// ─── 核心工具集定义 ───
const CORE_TOOLSETS = {
  file: {
    label: '文件操作',
    description: '读写文件、目录管理',
    toolsets: ['file'],
    icon: '📁',
  },
  terminal: {
    label: '终端执行',
    description: 'Shell 命令执行',
    toolsets: ['system'],
    icon: '💻',
  },
  web: {
    label: '网络搜索',
    description: '搜索、抓取网页内容',
    toolsets: ['web'],
    icon: '🔍',
  },
  browser: {
    label: '浏览器',
    description: '浏览器自动化操作',
    toolsets: ['browser'],
    icon: '🌐',
  },
  desktop: {
    label: '桌面控制',
    description: '桌面自动化、截图、窗口管理',
    toolsets: ['desktop'],
    icon: '🖥️',
  },
  multimodal: {
    label: '多模态',
    description: '图片、视频、语音处理',
    toolsets: ['multimodal', 'voice'],
    icon: '🎨',
  },
  messaging: {
    label: '消息平台',
    description: '飞书、企业微信等消息平台',
    toolsets: ['lark', 'wecom'],
    icon: '💬',
  },
  workflow: {
    label: '工作流',
    description: '任务流、工作流管理',
    toolsets: ['workflow'],
    icon: '🔄',
  },
  skills: {
    label: '技能管理',
    description: '技能生成、管理、执行',
    toolsets: ['skills'],
    icon: '⚡',
  },
  interaction: {
    label: '交互控制',
    description: '待办、提醒、澄清等交互工具',
    toolsets: ['interaction', 'reminder'],
    icon: '🎯',
  },

  calendar: {
    label: '日历日程',
    description: '创建、查询、管理日历日程',
    toolsets: ['calendar'],
    icon: '📅',
  },

  // 2026-08-16 修复：场景卡工具集从未被任何平台激活 → SceneMedia 等 22 个场景工具
  // 被 buildToolDefinitions 交集过滤（活跃集 ∩ 意图路由）滤掉，LLM 看不到 → 语音
  // "播放X视频" 意图对但只能回退浏览器。此处定义 scene 工具集名，cli 平台列表启用。
  scene: {
    label: '场景卡片',
    description: '场景卡面板（媒体/表单/图表/天气等）',
    toolsets: ['scene'],
    icon: '🃏',
  },

  // 2026-08-18 修复：面板工具集同款断层（与 scene 同因）——ShowWeather/ShowTyphoon/
  // ShowStock/HotspotMode 等 19 个 panel 工具从未被任何平台激活 → buildToolDefinitions
  // 交集过滤后 LLM 看不到 → 天气/台风/股票问题模型只能靠历史会话里的工具名硬调或
  // 走错误工具（台风问题因此落入 TyphoonQuery 小卡）。此处定义 panel 工具集名，
  // 4 个平台列表均已启用（cli/api-server/lark/wecom）。
  panel: {
    label: '面板展示',
    description: '天气/台风/股票/热点等可视化面板',
    toolsets: ['panel'],
    icon: '📊',
  },

  // 2026-08-18 修复：媒体工具集同款断层（与 scene/panel 同因）——MusicPlay/MusicControl/
  // MediaStage 等 toolset='media' 的工具从未被任何平台激活 → 音乐播放/控制工具 LLM 看不到，
  // 只剩 MusicSearch(web) 兜底（搜索+列表，无法控制播放）。此处定义 media 工具集名，
  // 4 个平台列表均已启用（cli/api-server/lark/wecom）。
  media: {
    label: '媒体播放',
    description: '音乐播放/控制、媒体舞台',
    toolsets: ['media'],
    icon: '🎵',
  },

  // 2026-08-18 P0-1 修复：以下 15 个工具集此前无 CORE_TOOLSETS 键——PLATFORM_TOOLSETS
  // 与意图路由（tool-router.js）虽引用了这些 toolset 值名（travel/data/memory/ui…），
  // 但激活时 getToolset() 找不到键 → 抛"工具集不存在"被静默吞掉 → buildToolDefinitions
  // 交集过滤（活跃集 ∩ 意图路由）把它们全部滤掉 → TrainQuery/ArchiveCompress/
  // DatabaseQuery/Memory/BrowserControl/Bash 等实测不可见。toolsets 值名与
  // src/tools/*.js 注册表逐一对齐（grep 核实：train-tools→travel、database-tools→data、
  // session-search-tools→memory、ui-control-tools→ui、trending-tools→trending、
  // tool-evolution-tools→harness、http-tools→network、archive-tools→filesystem、
  // email-tools→email、document-tools→document、platform-api-tools→platform、
  // agent-delegation-tools→agent、turn-trace-tool→observability、stock-*→stock、
  // registry 默认→general）。
  general: {
    label: '通用工具',
    description: '通用/默认分类工具',
    toolsets: ['general'],
    icon: '🧰',
  },
  stock: {
    label: '股票行情',
    description: '股票持仓、自选、行情数据',
    toolsets: ['stock'],
    icon: '📈',
  },
  travel: {
    label: '出行票务',
    description: '火车票、车次、余票查询',
    toolsets: ['travel'],
    icon: '🚄',
  },
  ui: {
    label: '界面控制',
    description: '界面元素控制、面板/布局切换',
    toolsets: ['ui'],
    icon: '🖱️',
  },
  email: {
    label: '邮件',
    description: '邮件收发与搜索',
    toolsets: ['email'],
    icon: '📧',
  },
  document: {
    label: '文档处理',
    description: 'Word/Excel/PPT/PDF 文档生成与转换',
    toolsets: ['document'],
    icon: '📄',
  },
  trending: {
    label: '热点趋势',
    description: '热搜、趋势数据抓取',
    toolsets: ['trending'],
    icon: '🔥',
  },
  platform: {
    label: '平台集成',
    description: '飞书/企微平台 API 与审批',
    toolsets: ['platform'],
    icon: '🔗',
  },
  harness: {
    label: '自进化工具',
    description: '工具进化、模板生成、技能工厂',
    toolsets: ['harness'],
    icon: '🧬',
  },
  agent: {
    label: '子代理',
    description: '子代理委派、工具发现',
    toolsets: ['agent'],
    icon: '🤖',
  },
  network: {
    label: '网络请求',
    description: 'HTTP 请求工具',
    toolsets: ['network'],
    icon: '🌍',
  },
  data: {
    label: '数据查询',
    description: '数据库查询、数据导入',
    toolsets: ['data'],
    icon: '🗄️',
  },
  filesystem: {
    label: '文件系统',
    description: '压缩解压等文件系统操作',
    toolsets: ['filesystem'],
    icon: '🗜️',
  },
  memory: {
    label: '记忆系统',
    description: '记忆读写、会话搜索',
    toolsets: ['memory'],
    icon: '🧠',
  },
  observability: {
    label: '可观测性',
    description: 'turn trace 等调试追踪',
    toolsets: ['observability'],
    icon: '📡',
  },
};

// ─── 复合工具集定义 ───
const COMPOSITE_TOOLSETS = {
  debugging: {
    label: '调试模式',
    description: '文件 + 终端 + 搜索，适合调试场景',
    toolsets: ['file', 'system', 'web'],
    icon: '🐛',
  },
  safe: {
    label: '安全模式',
    description: '只读操作 + 多模态，无写入无执行',
    toolsets: ['web', 'multimodal', 'voice'],
    readOnly: true,
    icon: '🔒',
  },
  full: {
    label: '完整模式',
    description: '所有核心工具集',
    toolsets: Object.keys(CORE_TOOLSETS),
    icon: '🚀',
  },
  minimal: {
    label: '最小模式',
    description: '仅交互和搜索',
    toolsets: ['interaction', 'web'],
    icon: '✨',
  },
  coding: {
    label: '编码模式',
    description: '文件 + 终端 + 技能，适合编码场景',
    toolsets: ['file', 'system', 'skills'],
    icon: '👨‍💻',
  },
};

// ─── 平台工具集定义 ───
// 2026-08-18 P0-1 修复：以下列表只引用 CORE_TOOLSETS 键名。
// 此前混用"核心键名"与"toolset 值名"（system/voice/reminder/lark/wecom 不是
// CORE_TOOLSETS 的键，对应键是 terminal/multimodal/interaction/messaging）→
// activateToolset 抛"工具集不存在"被 buildToolDefinitions 静默吞掉 → Bash 及
// 46 个 system 工具、全部 lark/wecom 工具不可见。voice/reminder 键已分别含在
// multimodal/interaction 中；lark/wecom 渠道统一走 messaging（messaging.toolsets
// = ['lark','wecom']，渠道隔离为已记录的遗留问题 P1-8，不在本轮范围）。
const PLATFORM_TOOLSETS = {
  cli: {
    label: 'CLI 平台',
    description: '命令行界面可用工具集',
    toolsets: ['file', 'terminal', 'web', 'browser', 'desktop', 'multimodal', 'workflow', 'skills', 'interaction', 'calendar', 'scene', 'panel', 'media', 'general', 'stock', 'travel', 'ui', 'email', 'document', 'trending', 'platform', 'harness', 'agent', 'network', 'data', 'filesystem', 'memory', 'observability'],
  },
  'api-server': {
    label: 'API Server 平台',
    description: 'OpenAI 兼容端点可用工具集',
    toolsets: ['file', 'terminal', 'web', 'workflow', 'skills', 'interaction', 'calendar', 'scene', 'panel', 'media', 'general', 'stock', 'travel', 'ui', 'email', 'document', 'trending', 'platform', 'harness', 'agent', 'network', 'data', 'filesystem', 'memory', 'observability'],
  },
  lark: {
    label: '飞书平台',
    description: '飞书消息平台可用工具集',
    toolsets: ['file', 'web', 'messaging', 'workflow', 'skills', 'interaction', 'calendar', 'scene', 'panel', 'media', 'general', 'stock', 'travel', 'ui', 'email', 'document', 'trending', 'platform', 'harness', 'agent', 'network', 'data', 'filesystem', 'memory', 'observability'],
  },
  wecom: {
    label: '企业微信平台',
    description: '企业微信平台可用工具集',
    toolsets: ['file', 'web', 'messaging', 'workflow', 'skills', 'interaction', 'calendar', 'scene', 'panel', 'media', 'general', 'stock', 'travel', 'ui', 'email', 'document', 'trending', 'platform', 'harness', 'agent', 'network', 'data', 'filesystem', 'memory', 'observability'],
  },
};

class ToolsetManager {
  constructor(config = {}) {
    this._coreToolsets = { ...CORE_TOOLSETS };
    this._compositeToolsets = { ...COMPOSITE_TOOLSETS };
    this._platformToolsets = { ...PLATFORM_TOOLSETS };
    this._customToolsets = {};
    this._mcpToolsets = {};
    this._activeToolsets = new Set();
    this._activePlatform = config.platform || 'cli';

    // 加载自定义工具集
    if (config.customToolsets) {
      for (const [name, ts] of Object.entries(config.customToolsets)) {
        this._customToolsets[name] = {
          label: ts.label || name,
          description: ts.description || '',
          toolsets: ts.toolsets || [],
          tools: ts.tools || [],
          icon: ts.icon || '🔧',
        };
      }
    }

    // 根据平台激活默认工具集
    this._activatePlatformDefaults();
  }

  // ─── 工具集查询 ───

  /**
   * 获取所有工具集定义（合并核心+复合+自定义+MCP）
   */
  getAllToolsets() {
    return {
      core: { ...this._coreToolsets },
      composite: { ...this._compositeToolsets },
      platform: { ...this._platformToolsets },
      custom: { ...this._customToolsets },
      mcp: { ...this._mcpToolsets },
    };
  }

  /**
   * 获取工具集详情
   */
  getToolset(name) {
    return this._coreToolsets[name]
      || this._compositeToolsets[name]
      || this._platformToolsets[name]
      || this._customToolsets[name]
      || this._mcpToolsets[name]
      || null;
  }

  /**
   * 列出所有工具集名称和元信息
   */
  listToolsets() {
    const result = [];
    for (const [name, ts] of Object.entries(this._coreToolsets)) {
      result.push({ name, type: 'core', label: ts.label, description: ts.description, icon: ts.icon });
    }
    for (const [name, ts] of Object.entries(this._compositeToolsets)) {
      result.push({ name, type: 'composite', label: ts.label, description: ts.description, icon: ts.icon });
    }
    for (const [name, ts] of Object.entries(this._platformToolsets)) {
      result.push({ name, type: 'platform', label: ts.label, description: ts.description });
    }
    for (const [name, ts] of Object.entries(this._customToolsets)) {
      result.push({ name, type: 'custom', label: ts.label, description: ts.description, icon: ts.icon });
    }
    for (const [name, ts] of Object.entries(this._mcpToolsets)) {
      result.push({ name, type: 'mcp', label: ts.label, description: ts.description });
    }
    return result;
  }

  /**
   * 展开工具集为具体的 toolset 名称列表
   */
  resolveToolsetNames(name) {
    const ts = this.getToolset(name);
    if (!ts) return [];

    // 递归展开复合工具集
    const resolved = new Set();
    const queue = [...(ts.toolsets || [])];

    while (queue.length > 0) {
      const current = queue.shift();
      const subTs = this._coreToolsets[current];
      if (subTs && subTs.toolsets) {
        // 核心工具集可能引用其他核心工具集
        for (const t of subTs.toolsets) {
          if (!resolved.has(t)) {
            resolved.add(t);
          }
        }
      } else {
        resolved.add(current);
      }
    }

    return [...resolved];
  }

  /**
   * 获取工具集包含的所有工具名称
   */
  resolveToolNames(name) {
    const ts = this.getToolset(name);
    if (!ts) return [];

    const toolsetNames = this.resolveToolsetNames(name);
    const toolNames = new Set();

    // 从注册表获取每个 toolset 下的工具
    for (const tsName of toolsetNames) {
      const tools = registry.getByToolset(tsName);
      for (const tool of tools) {
        toolNames.add(tool.name);
      }
    }

    // 添加自定义工具集中直接指定的工具
    if (ts.tools && ts.tools.length > 0) {
      for (const toolName of ts.tools) {
        toolNames.add(toolName);
      }
    }

    return [...toolNames];
  }

  // ─── 激活管理 ───

  /**
   * 激活工具集
   */
  activateToolset(name) {
    const ts = this.getToolset(name);
    if (!ts) {
      throw new Error(`工具集不存在: ${name}`);
    }
    this._activeToolsets.add(name);
    return this;
  }

  /**
   * 停用工具集
   */
  deactivateToolset(name) {
    this._activeToolsets.delete(name);
    return this;
  }

  /**
   * 设置当前活跃的工具集列表
   */
  setActiveToolsets(names) {
    this._activeToolsets.clear();
    for (const name of names) {
      this._activeToolsets.add(name);
    }
    return this;
  }

  /**
   * 获取当前活跃的工具集
   */
  getActiveToolsets() {
    return [...this._activeToolsets];
  }

  /**
   * 根据当前活跃工具集获取可用工具列表（OpenAI 格式）
   */
  getActiveToolsOpenAI() {
    if (this._activeToolsets.size === 0) {
      // 没有设置活跃工具集时，返回所有工具
      return registry.toOpenAIFormat();
    }

    const toolsetNames = new Set();
    for (const name of this._activeToolsets) {
      for (const resolved of this.resolveToolsetNames(name)) {
        toolsetNames.add(resolved);
      }
    }

    return registry.toOpenAIFormat([...toolsetNames]);
  }

  /**
   * 根据当前活跃工具集获取可用工具列表（Claude 格式）
   */
  getActiveToolsClaude() {
    if (this._activeToolsets.size === 0) {
      return registry.toClaudeFormat();
    }

    const toolsetNames = new Set();
    for (const name of this._activeToolsets) {
      for (const resolved of this.resolveToolsetNames(name)) {
        toolsetNames.add(resolved);
      }
    }

    return registry.toClaudeFormat([...toolsetNames]);
  }

  /**
   * 获取当前活跃工具集下的所有工具名称
   */
  getActiveToolNames() {
    if (this._activeToolsets.size === 0) {
      return registry.getNames();
    }

    const names = new Set();
    for (const name of this._activeToolsets) {
      for (const toolName of this.resolveToolNames(name)) {
        names.add(toolName);
      }
    }
    return [...names];
  }

  /**
   * 获取最近执行过的工具名（工具链连续性用）
   * 2026-08-18 修复：此前 tool-definitions.js L58 调用 tsm.getRecentToolNames(5)
   * 但本类无此方法 → 恒 []（恒 undefined 由调用方兜底为 []）。优先读注册表执行日志
   * （registry._logExecution 全量记录），无日志时降级取活跃工具集前 N 个。
   * @param {number} [limit=5]
   * @returns {string[]} 最近执行/激活的工具名数组（不抛错）
   */
  getRecentToolNames(limit = 5) {
    try {
      // P0-6：优先尾段直读（免 1 万条执行日志全量拷贝）；旧路径保留为兼容
      if (registry && typeof registry.getRecentToolNames === 'function') {
        const names = registry.getRecentToolNames(limit);
        if (names.length > 0) return names;
      }
      if (registry && typeof registry.getExecutionLog === 'function') {
        const logs = registry.getExecutionLog();
        const names = [];
        const seen = new Set();
        for (let i = logs.length - 1; i >= 0 && names.length < limit; i--) {
          const n = logs[i] && logs[i].tool;
          if (n && !seen.has(n)) {
            seen.add(n);
            names.push(n);
          }
        }
        if (names.length > 0) return names;
      }
    } catch (e) {
      console.warn('[ToolsetManager] getRecentToolNames 读执行日志失败，降级取活跃工具集:', e.message);
    }
    // 降级：取活跃工具集前 limit 个（进程刚启动、无执行日志时保证非空）
    try {
      return this.getActiveToolNames().slice(0, limit);
    } catch (e) {
      console.warn('[ToolsetManager] getRecentToolNames 降级失败:', e.message);
      return [];
    }
  }

  /**
   * 检查工具是否在当前活跃工具集中
   */
  isToolActive(toolName) {
    if (this._activeToolsets.size === 0) return true;

    const tool = registry.get(toolName);
    if (!tool) return false;

    const activeToolsetNames = new Set();
    for (const name of this._activeToolsets) {
      for (const resolved of this.resolveToolsetNames(name)) {
        activeToolsetNames.add(resolved);
      }
    }

    return activeToolsetNames.has(tool.toolset);
  }

  // ─── 平台管理 ───

  /**
   * 设置当前平台
   */
  setPlatform(platform) {
    if (!this._platformToolsets[platform]) {
      throw new Error(`未知平台: ${platform}。可用: ${Object.keys(this._platformToolsets).join(', ')}`);
    }
    this._activePlatform = platform;
    this._activatePlatformDefaults();
    return this;
  }

  /**
   * 获取当前平台
   */
  getPlatform() {
    return this._activePlatform;
  }

  _activatePlatformDefaults() {
    const platformTs = this._platformToolsets[this._activePlatform];
    if (platformTs) {
      // 平台工具集定义了该平台可用的核心工具集
      // 不直接激活，而是作为过滤条件
    }
  }

  /**
   * 获取当前平台可用的工具集名称
   */
  getPlatformToolsetNames() {
    const platformTs = this._platformToolsets[this._activePlatform];
    if (!platformTs) return Object.keys(this._coreToolsets);
    return platformTs.toolsets;
  }

  // ─── MCP 动态工具集 ───

  /**
   * 注册 MCP 服务器工具集
   */
  registerMCPToolset(serverName, toolNames) {
    this._mcpToolsets[`mcp-${serverName}`] = {
      label: `MCP: ${serverName}`,
      description: `MCP 服务器 ${serverName} 提供的工具`,
      toolsets: [],
      tools: toolNames,
      icon: '🔌',
    };
  }

  /**
   * 移除 MCP 服务器工具集
   */
  removeMCPToolset(serverName) {
    delete this._mcpToolsets[`mcp-${serverName}`];
  }

  // ─── 自定义工具集 ───

  /**
   * 添加自定义工具集
   */
  addCustomToolset(name, definition) {
    if (this._coreToolsets[name] || this._compositeToolsets[name]) {
      throw new Error(`不能覆盖内置工具集: ${name}`);
    }
    this._customToolsets[name] = {
      label: definition.label || name,
      description: definition.description || '',
      toolsets: definition.toolsets || [],
      tools: definition.tools || [],
      icon: definition.icon || '🔧',
    };
    return this;
  }

  /**
   * 移除自定义工具集
   */
  removeCustomToolset(name) {
    if (!this._customToolsets[name]) {
      throw new Error(`自定义工具集不存在: ${name}`);
    }
    delete this._customToolsets[name];
    this._activeToolsets.delete(name);
    return this;
  }

  // ─── 统计 ───

  getStats() {
    const registryStats = registry.getStats();
    return {
      totalTools: registryStats.totalTools,
      coreToolsets: Object.keys(this._coreToolsets).length,
      compositeToolsets: Object.keys(this._compositeToolsets).length,
      platformToolsets: Object.keys(this._platformToolsets).length,
      customToolsets: Object.keys(this._customToolsets).length,
      mcpToolsets: Object.keys(this._mcpToolsets).length,
      activeToolsets: this._activeToolsets.size,
      activeTools: this.getActiveToolNames().length,
      platform: this._activePlatform,
      byToolset: registryStats.byToolset,
    };
  }

  /**
   * 生成工具集摘要（用于 /tools 命令）
   */
  getSummary() {
    const lines = ['📦 工具集概览\n'];

    lines.push('核心工具集:');
    for (const [name, ts] of Object.entries(this._coreToolsets)) {
      const toolCount = this.resolveToolNames(name).length;
      const active = this._activeToolsets.has(name) ? '✅' : '⬜';
      lines.push(`  ${active} ${ts.icon} ${name} (${ts.label}) — ${toolCount} 工具`);
    }

    lines.push('\n复合工具集:');
    for (const [name, ts] of Object.entries(this._compositeToolsets)) {
      const toolCount = this.resolveToolNames(name).length;
      const active = this._activeToolsets.has(name) ? '✅' : '⬜';
      lines.push(`  ${active} ${ts.icon} ${name} (${ts.label}) — ${toolCount} 工具`);
    }

    if (Object.keys(this._customToolsets).length > 0) {
      lines.push('\n自定义工具集:');
      for (const [name, ts] of Object.entries(this._customToolsets)) {
        const toolCount = this.resolveToolNames(name).length;
        const active = this._activeToolsets.has(name) ? '✅' : '⬜';
        lines.push(`  ${active} ${ts.icon} ${name} (${ts.label}) — ${toolCount} 工具`);
      }
    }

    if (Object.keys(this._mcpToolsets).length > 0) {
      lines.push('\nMCP 工具集:');
      for (const [name, ts] of Object.entries(this._mcpToolsets)) {
        const toolCount = (ts.tools || []).length;
        lines.push(`  🔌 ${name} (${ts.label}) — ${toolCount} 工具`);
      }
    }

    lines.push(`\n当前平台: ${this._activePlatform}`);
    lines.push(`活跃工具集: ${this._activeToolsets.size > 0 ? [...this._activeToolsets].join(', ') : '(全部)'}`);
    lines.push(`可用工具: ${this.getActiveToolNames().length}`);

    return lines.join('\n');
  }
}

// 全局单例
let _instance = null;

function getToolsetManager(config) {
  if (!_instance) {
    _instance = new ToolsetManager(config);
  }
  return _instance;
}

function resetToolsetManager() {
  _instance = null;
}

module.exports = {
  ToolsetManager,
  CORE_TOOLSETS,
  COMPOSITE_TOOLSETS,
  PLATFORM_TOOLSETS,
  getToolsetManager,
  resetToolsetManager,
};
