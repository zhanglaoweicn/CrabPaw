/**
 * Tool Summary Service
 * 
 * 工具使用摘要生成服务
 * 借鉴 Claude Code 的 toolUseSummaryGenerator.ts 实现
 */

const { EventEmitter } = require('events');

class ToolSummaryService extends EventEmitter {
  constructor() {
    super();
    this.initialized = false;
    this.config = {
      enabled: true,
      maxToolsPerSummary: 10,
      maxInputLength: 300,
      maxOutputLength: 300,
    };
  }

  async initialize(config = {}) {
    if (this.initialized) {
      return;
    }

    this.config = { ...this.config, ...config };
    this.initialized = true;
    this.emit('initialized');
  }

  async shutdown() {
    if (!this.initialized) {
      return;
    }

    this.initialized = false;
    this.emit('shutdown');
  }

  async generateSummary(tools, context = {}) {
    if (!this.config.enabled || tools.length === 0) {
      return null;
    }

    const limitedTools = tools.slice(0, this.config.maxToolsPerSummary);
    
    const contextPrefix = context.lastAssistantText
      ? `Context: ${context.lastAssistantText.slice(0, 200)}\n\n`
      : '';

    const summary = this.generateSimpleSummary(limitedTools, contextPrefix);
    
    this.emit('summary:generated', { toolCount: tools.length, summary });
    
    return summary;
  }

  generateSimpleSummary(tools, _contextPrefix) {
    const toolNames = [...new Set(tools.map(t => t.name))];
    
    if (toolNames.length === 1) {
      const tool = tools[0];
      const action = this.getToolAction(tool.name);
      const target = this.getToolTarget(tool);
      return `${action} ${target}`.trim();
    }

    const actions = toolNames.map(name => {
      const count = tools.filter(t => t.name === name).length;
      const action = this.getToolAction(name);
      return count > 1 ? `${action} (${count}x)` : action;
    });

    return actions.slice(0, 3).join(', ') + (actions.length > 3 ? '...' : '');
  }

  getToolAction(toolName) {
    const actionMap = {
      'Read': 'Read',
      'Write': 'Wrote',
      'Edit': 'Edited',
      'Bash': 'Ran',
      'Grep': 'Searched',
      'Glob': 'Found',
      'Task': 'Executed',
      'WebSearch': 'Searched web',
      'WebFetch': 'Fetched',
    };
    return actionMap[toolName] || toolName;
  }

  getToolTarget(tool) {
    if (tool.input?.file_path) {
      const parts = tool.input.file_path.split('/');
      return parts[parts.length - 1];
    }
    if (tool.input?.pattern) {
      return tool.input.pattern;
    }
    if (tool.input?.command) {
      return tool.input.command.slice(0, 30);
    }
    return '';
  }

  truncateJson(value, maxLength) {
    try {
      const str = JSON.stringify(value);
      if (str.length <= maxLength) {
        return str;
      }
      return str.slice(0, maxLength - 3) + '...';
    } catch {
      return '[unable to serialize]';
    }
  }

  getStats() {
    return {
      initialized: this.initialized,
      enabled: this.config.enabled,
    };
  }
}

const toolSummaryService = new ToolSummaryService();

module.exports = {
  ToolSummaryService,
  toolSummaryService,
};
