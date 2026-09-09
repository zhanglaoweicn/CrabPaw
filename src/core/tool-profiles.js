/**
 * Tool Profile System - 工具配置系统
 */

const TOOL_PROFILES = {
  minimal: {
    allow: ['read', 'session_status'],
    deny: [],
    description: '最小权限，仅读取和状态查看',
  },
  coding: {
    allow: ['read', 'write', 'edit', 'exec', 'web_search', 'memory_search', 'image'],
    deny: [],
    description: '编程助手，包含文件操作和执行权限',
  },
  messaging: {
    allow: ['message', 'sessions_list', 'sessions_send', 'sessions_history'],
    deny: ['exec', 'write'],
    description: '消息助手，专注于会话管理',
  },
  full: {
    allow: [],
    deny: [],
    description: '完整权限，无限制',
  },
};

const TOOL_GROUPS = {
  'group:fs': ['read', 'write', 'edit', 'apply_patch'],
  'group:runtime': ['exec', 'process', 'code_execution'],
  'group:web': ['web_search', 'web_fetch', 'x_search'],
  'group:memory': ['memory_search', 'memory_get'],
  'group:sessions': ['sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn'],
  'group:messaging': ['message'],
  'group:automation': ['cron', 'gateway'],
  'group:nodes': ['nodes'],
  'group:agents': ['agents_list'],
  'group:media': ['image', 'image_generate', 'tts'],
  'group:full-access': [
    'read', 'write', 'edit', 'exec', 'web_search', 'web_fetch',
    'memory_search', 'sessions_list', 'sessions_history', 'sessions_send',
    'message', 'cron', 'image', 'image_generate',
  ],
};

const TOOL_SECTIONS = [
  { id: 'fs', label: 'Files', tools: ['read', 'write', 'edit', 'apply_patch'] },
  { id: 'runtime', label: 'Runtime', tools: ['exec', 'process', 'code_execution'] },
  { id: 'web', label: 'Web', tools: ['web_search', 'web_fetch', 'x_search'] },
  { id: 'memory', label: 'Memory', tools: ['memory_search', 'memory_get'] },
  { id: 'sessions', label: 'Sessions', tools: ['sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn'] },
  { id: 'ui', label: 'UI', tools: ['browser', 'canvas'] },
  { id: 'messaging', label: 'Messaging', tools: ['message'] },
  { id: 'automation', label: 'Automation', tools: ['cron', 'gateway'] },
  { id: 'nodes', label: 'Nodes', tools: ['nodes'] },
  { id: 'agents', label: 'Agents', tools: ['agents_list'] },
  { id: 'media', label: 'Media', tools: ['image', 'image_generate', 'tts'] },
];

const TOOL_DEFINITIONS = [
  { id: 'read', label: 'read', description: 'Read file contents', sectionId: 'fs', profiles: ['coding'] },
  { id: 'write', label: 'write', description: 'Create or overwrite files', sectionId: 'fs', profiles: ['coding'] },
  { id: 'edit', label: 'edit', description: 'Make precise edits', sectionId: 'fs', profiles: ['coding'] },
  { id: 'apply_patch', label: 'apply_patch', description: 'Patch files', sectionId: 'fs', profiles: ['coding'] },
  { id: 'exec', label: 'exec', description: 'Run shell commands', sectionId: 'runtime', profiles: ['coding'] },
  { id: 'process', label: 'process', description: 'Manage background processes', sectionId: 'runtime', profiles: ['coding'] },
  { id: 'code_execution', label: 'code_execution', description: 'Run sandboxed remote analysis', sectionId: 'runtime', profiles: ['coding'] },
  { id: 'web_search', label: 'web_search', description: 'Search the web', sectionId: 'web', profiles: ['coding'] },
  { id: 'web_fetch', label: 'web_fetch', description: 'Fetch web content', sectionId: 'web', profiles: ['coding'] },
  { id: 'x_search', label: 'x_search', description: 'Search X posts', sectionId: 'web', profiles: ['coding'] },
  { id: 'memory_search', label: 'memory_search', description: 'Semantic search', sectionId: 'memory', profiles: ['coding'] },
  { id: 'memory_get', label: 'memory_get', description: 'Read memory files', sectionId: 'memory', profiles: ['coding'] },
  { id: 'sessions_list', label: 'sessions_list', description: 'List sessions', sectionId: 'sessions', profiles: ['coding', 'messaging'] },
  { id: 'sessions_history', label: 'sessions_history', description: 'Session history', sectionId: 'sessions', profiles: ['coding', 'messaging'] },
  { id: 'sessions_send', label: 'sessions_send', description: 'Send to session', sectionId: 'sessions', profiles: ['coding', 'messaging'] },
  { id: 'sessions_spawn', label: 'sessions_spawn', description: 'Spawn sub-agent', sectionId: 'sessions', profiles: ['coding'] },
  { id: 'browser', label: 'browser', description: 'Control web browser', sectionId: 'ui', profiles: [] },
  { id: 'canvas', label: 'canvas', description: 'Control canvases', sectionId: 'ui', profiles: [] },
  { id: 'message', label: 'message', description: 'Send messages', sectionId: 'messaging', profiles: ['messaging'] },
  { id: 'cron', label: 'cron', description: 'Schedule tasks', sectionId: 'automation', profiles: ['coding'] },
  { id: 'gateway', label: 'gateway', description: 'Gateway control', sectionId: 'automation', profiles: [] },
  { id: 'nodes', label: 'nodes', description: 'Nodes + devices', sectionId: 'nodes', profiles: [] },
  { id: 'agents_list', label: 'agents_list', description: 'List agents', sectionId: 'agents', profiles: [] },
  { id: 'image', label: 'image', description: 'Image understanding', sectionId: 'media', profiles: ['coding'] },
  { id: 'image_generate', label: 'image_generate', description: 'Image generation', sectionId: 'media', profiles: ['coding'] },
  { id: 'tts', label: 'tts', description: 'Text-to-speech conversion', sectionId: 'media', profiles: [] },
];

const TOOL_BY_ID = new Map(TOOL_DEFINITIONS.map(tool => [tool.id, tool]));

const OWNER_ONLY_TOOLS = new Set([
  'exec',
  'write',
  'edit',
  'apply_patch',
  'cron',
  'gateway',
  'sessions_spawn',
  'process',
]);

const OWNER_ONLY_ALLOWLIST_DEFAULT = [
  'session_status',
  'read',
];

class ToolPolicyManager {
  constructor() {
    this.customProfiles = new Map();
    this.pluginTools = new Map();
  }

  resolveToolProfilePolicy(profile) {
    if (!profile) return undefined;
    
    const resolved = TOOL_PROFILES[profile] || this.customProfiles.get(profile);
    if (!resolved) return undefined;
    
    if (!resolved.allow && !resolved.deny) return undefined;
    
    return {
      allow: resolved.allow ? [...resolved.allow] : undefined,
      deny: resolved.deny ? [...resolved.deny] : undefined,
    };
  }

  expandToolGroups(list) {
    if (!list || list.length === 0) return list;
    
    const expanded = [];
    for (const item of list) {
      const normalized = item.trim().toLowerCase();
      if (TOOL_GROUPS[normalized]) {
        expanded.push(...TOOL_GROUPS[normalized]);
      } else {
        expanded.push(normalized);
      }
    }
    
    return [...new Set(expanded)];
  }

  normalizeToolList(list) {
    if (!list || list.length === 0) return [];
    
    return [...new Set(
      list
        .filter(item => typeof item === 'string')
        .map(item => item.trim().toLowerCase())
        .filter(item => item.length > 0)
    )];
  }

  applyPolicy(tools, policy) {
    if (!policy) return tools;
    
    let allowedTools = tools;
    
    if (policy.allow && policy.allow.length > 0) {
      const expandedAllow = this.expandToolGroups(policy.allow);
      const allowSet = new Set(expandedAllow);
      
      if (!allowSet.has('*')) {
        allowedTools = allowedTools.filter(tool => {
          const toolName = typeof tool === 'string' ? tool : tool.name;
          return allowSet.has(toolName.toLowerCase());
        });
      }
    }
    
    if (policy.deny && policy.deny.length > 0) {
      const expandedDeny = this.expandToolGroups(policy.deny);
      const denySet = new Set(expandedDeny);
      
      allowedTools = allowedTools.filter(tool => {
        const toolName = typeof tool === 'string' ? tool : tool.name;
        return !denySet.has(toolName.toLowerCase());
      });
    }
    
    return allowedTools;
  }

  registerCustomProfile(name, profile) {
    this.customProfiles.set(name, profile);
  }

  registerPluginTool(pluginId, tools) {
    this.pluginTools.set(pluginId.toLowerCase(), tools);
  }

  getToolSections() {
    return TOOL_SECTIONS.map(section => ({
      id: section.id,
      label: section.label,
      tools: TOOL_DEFINITIONS
        .filter(tool => tool.sectionId === section.id)
        .map(tool => ({
          id: tool.id,
          label: tool.label,
          description: tool.description,
        })),
    })).filter(section => section.tools.length > 0);
  }

  getToolProfiles() {
    return Object.entries(TOOL_PROFILES).map(([id, profile]) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      description: profile.description,
    }));
  }

  isKnownToolId(toolId) {
    return TOOL_BY_ID.has(toolId.toLowerCase());
  }

  getToolProfilesForTool(toolId) {
    const tool = TOOL_BY_ID.get(toolId.toLowerCase());
    if (!tool) return [];
    return [...tool.profiles];
  }

  isOwnerOnlyTool(toolName) {
    return OWNER_ONLY_TOOLS.has(toolName.toLowerCase());
  }

  applyOwnerOnlyPolicy(tools, senderIsOwner, ownerOnlyAllowlist) {
    const allowedOwnerOnly = new Set(
      (ownerOnlyAllowlist || OWNER_ONLY_ALLOWLIST_DEFAULT).map(n => n.toLowerCase())
    );

    return tools.map(tool => {
      const toolName = (typeof tool === 'string' ? tool : tool.name).toLowerCase();
      const isOwnerOnly = OWNER_ONLY_TOOLS.has(toolName);

      if (!isOwnerOnly) return tool;

      if (senderIsOwner || allowedOwnerOnly.has(toolName)) return tool;

      if (typeof tool === 'string') return null;

      return {
        ...tool,
        _ownerRestricted: true,
        execute: async () => ({
          error: `工具 "${tool.name}" 仅限所有者使用`,
          restricted: true,
        }),
      };
    }).filter(Boolean);
  }

  getPluginTools(pluginId) {
    return this.pluginTools.get(pluginId.toLowerCase()) || [];
  }

  mergePluginTools(baseTools, activePluginIds) {
    if (!activePluginIds || activePluginIds.length === 0) return baseTools;

    const pluginToolNames = new Set(baseTools.map(t =>
      typeof t === 'string' ? t.toLowerCase() : t.name.toLowerCase()
    ));

    for (const pluginId of activePluginIds) {
      const tools = this.pluginTools.get(pluginId.toLowerCase());
      if (tools) {
        for (const tool of tools) {
          const name = typeof tool === 'string' ? tool.toLowerCase() : tool.name.toLowerCase();
          if (!pluginToolNames.has(name)) {
            baseTools.push(tool);
            pluginToolNames.add(name);
          }
        }
      }
    }

    return baseTools;
  }
}

const toolPolicyManager = new ToolPolicyManager();

module.exports = {
  TOOL_PROFILES,
  TOOL_GROUPS,
  TOOL_SECTIONS,
  TOOL_DEFINITIONS,
  OWNER_ONLY_TOOLS,
  OWNER_ONLY_ALLOWLIST_DEFAULT,
  ToolPolicyManager,
  toolPolicyManager,
};
