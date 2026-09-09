/**
 * Tool Optimizer Service
 * 
 * 减少重复工具清单，优化 Token 消耗
 * 根据上下文智能选择和简化工具定义
 */

class ToolOptimizer {
  constructor(config = {}) {
    this.config = {
      maxToolDescription: config.maxToolDescription || 200,
      maxOtherTools: config.maxOtherTools || 20,
      ...config,
    };

    this.toolUsageStats = new Map();
    this.lastUsedTools = new Set();
    this.sessionToolUsage = [];
    this.relevanceKeywords = this._buildRelevanceKeywords();
  }

  _buildRelevanceKeywords() {
    return {
      web_search: ['搜索', 'search', '查找', '查询', '网络', '互联网'],
      read_file: ['文件', 'file', '读取', '查看', 'read', '打开'],
      write_file: ['写入', '保存', 'write', 'save', '创建文件', '修改文件'],
      edit_file: ['编辑', '修改', 'edit', '修改文件', '更新'],
      execute_bash: ['执行', '命令', 'bash', 'shell', '终端', 'terminal'],
      web_fetch: ['网页', 'fetch', '获取', '下载', 'download', 'url'],
      memory: ['记忆', 'memory', '记住', '回忆', '存储'],
      weather: ['天气', 'weather', '气温', '温度'],
      system_info: ['系统', 'system', '信息', '状态', 'status'],
    };
  }

  recordToolUse(toolName, success = true, metadata = {}) {
    const stats = this.toolUsageStats.get(toolName) || {
      uses: 0,
      successes: 0,
      failures: 0,
      lastUsed: 0,
      avgDuration: 0,
    };

    stats.uses++;
    if (success) {
      stats.successes++;
    } else {
      stats.failures++;
    }
    stats.lastUsed = Date.now();

    if (metadata.duration) {
      stats.avgDuration = (stats.avgDuration * (stats.uses - 1) + metadata.duration) / stats.uses;
    }

    this.toolUsageStats.set(toolName, stats);
    this.lastUsedTools.add(toolName);
    this.sessionToolUsage.push({
      tool: toolName,
      timestamp: Date.now(),
      success,
    });

    if (this.sessionToolUsage.length > 100) {
      this.sessionToolUsage = this.sessionToolUsage.slice(-50);
    }
  }

  optimizeToolList(allTools, context = {}) {
    const contextStr = this._extractContextString(context);
    
    const recentTools = this._getRecentTools();
    const relevantTools = this._getRelevantTools(contextStr);
    const coreTools = this._getCoreTools();
    const frequentlyUsedTools = this._getFrequentlyUsedTools();

    const prioritySet = new Set([
      ...coreTools,
      ...relevantTools,
      ...frequentlyUsedTools,
      ...recentTools,
    ]);

    const prioritized = [];
    const others = [];

    for (const tool of allTools) {
      if (prioritySet.has(tool.name)) {
        prioritized.push(tool);
      } else {
        others.push(tool);
      }
    }

    prioritized.sort((a, b) => {
      const aScore = this._getToolPriorityScore(a.name, prioritySet, contextStr);
      const bScore = this._getToolPriorityScore(b.name, prioritySet, contextStr);
      return bScore - aScore;
    });

    const limitedOthers = others.slice(0, this.config.maxOtherTools - prioritized.length);
    const simplifiedOthers = limitedOthers.map(t => this._simplifyTool(t));

    return [...prioritized, ...simplifiedOthers];
  }

  _extractContextString(context) {
    const parts = [];

    if (context.query) {
      parts.push(context.query);
    }

    if (context.messages && Array.isArray(context.messages)) {
      const recentMessages = context.messages.slice(-5);
      for (const msg of recentMessages) {
        if (typeof msg.content === 'string') {
          parts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              parts.push(part.text);
            }
          }
        }
      }
    }

    return parts.join(' ').toLowerCase();
  }

  _getCoreTools() {
    return new Set([
      'read', 'write', 'edit', 'search', 'bash',
      'read_file', 'write_file', 'edit_file', 'execute_bash',
      'web_search', 'web_fetch',
    ]);
  }

  _getRelevantTools(contextStr) {
    const relevant = new Set();

    for (const [tool, keywords] of Object.entries(this.relevanceKeywords)) {
      for (const keyword of keywords) {
        if (contextStr.includes(keyword.toLowerCase())) {
          relevant.add(tool);
          break;
        }
      }
    }

    return relevant;
  }

  _getRecentTools() {
    const recent = new Set();
    const recentUsage = this.sessionToolUsage.slice(-10);
    
    for (const usage of recentUsage) {
      recent.add(usage.tool);
    }

    return recent;
  }

  _getFrequentlyUsedTools() {
    const frequent = new Set();
    const sorted = Array.from(this.toolUsageStats.entries())
      .sort((a, b) => b[1].uses - a[1].uses)
      .slice(0, 5);

    for (const [tool] of sorted) {
      frequent.add(tool);
    }

    return frequent;
  }

  _getToolPriorityScore(toolName, prioritySet, contextStr) {
    let score = 0;

    if (this._getCoreTools().has(toolName)) {
      score += 100;
    }

    if (this._getRelevantTools(contextStr).has(toolName)) {
      score += 50;
    }

    const stats = this.toolUsageStats.get(toolName);
    if (stats) {
      score += Math.min(stats.uses, 30);
      if (stats.successes / stats.uses > 0.8) {
        score += 10;
      }
    }

    if (this.lastUsedTools.has(toolName)) {
      score += 20;
    }

    return score;
  }

  _simplifyTool(tool) {
    return {
      name: tool.name,
      description: (tool.description || '').slice(0, this.config.maxToolDescription),
      parameters: this._simplifySchema(tool.parameters),
      _simplified: true,
    };
  }

  _simplifySchema(schema) {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    const simplified = {
      type: schema.type || 'object',
    };

    if (schema.required && Array.isArray(schema.required)) {
      simplified.required = schema.required.slice(0, 5);
    }

    if (schema.properties && typeof schema.properties === 'object') {
      simplified.properties = {};
      const keys = Object.keys(schema.properties).slice(0, 5);
      
      for (const key of keys) {
        const prop = schema.properties[key];
        simplified.properties[key] = {
          type: prop?.type || 'string',
          description: (prop?.description || '').slice(0, 50),
        };
      }
    }

    return simplified;
  }

  getStats() {
    const toolStats = Array.from(this.toolUsageStats.entries())
      .map(([name, stats]) => ({
        name,
        ...stats,
        successRate: stats.uses > 0 ? stats.successes / stats.uses : 0,
      }))
      .sort((a, b) => b.uses - a.uses);

    return {
      totalTools: this.toolUsageStats.size,
      totalUses: this.sessionToolUsage.length,
      toolStats,
      recentTools: Array.from(this._getRecentTools()),
      coreTools: Array.from(this._getCoreTools()),
    };
  }

  reset() {
    this.toolUsageStats.clear();
    this.lastUsedTools.clear();
    this.sessionToolUsage = [];
  }

  export() {
    return {
      toolUsageStats: Array.from(this.toolUsageStats.entries()),
      lastUsedTools: Array.from(this.lastUsedTools),
      sessionToolUsage: this.sessionToolUsage,
    };
  }

  import(data) {
    if (data?.toolUsageStats) {
      this.toolUsageStats = new Map(data.toolUsageStats);
    }
    if (data?.lastUsedTools) {
      this.lastUsedTools = new Set(data.lastUsedTools);
    }
    if (data?.sessionToolUsage) {
      this.sessionToolUsage = data.sessionToolUsage;
    }
  }
}

const toolOptimizer = new ToolOptimizer();

module.exports = {
  ToolOptimizer,
  toolOptimizer,
};
