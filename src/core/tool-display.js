const TOOL_DISPLAY_ICONS = {
  Bash: '⌨️',
  Read: '📖',
  Write: '✏️',
  Edit: '📝',
  LS: '📁',
  SearchCodebase: '🔍',
  Grep: '🔎',
  Glob: '🗂️',
  WebSearch: '🌐',
  WebFetch: '🔗',
  SkillView: '🔧',
  SkillExecute: '⚡',
  TodoWrite: '📋',
  AskUserQuestion: '❓',
  FileRead: '📄',
  FileWrite: '💾',
  FileDelete: '🗑️',
  default: '🔧',
};

const TOOL_DISPLAY_NAMES = {
  Bash: '执行命令',
  Read: '读取文件',
  Write: '写入文件',
  Edit: '编辑文件',
  LS: '列出目录',
  SearchCodebase: '搜索代码',
  Grep: '文本搜索',
  Glob: '文件匹配',
  WebSearch: '网络搜索',
  WebFetch: '获取网页',
  SkillView: '查看技能',
  SkillExecute: '执行技能',
  TodoWrite: '更新任务',
  AskUserQuestion: '确认问题',
  FileRead: '读取文件',
  FileWrite: '保存文件',
  FileDelete: '删除文件',
};

const TOOL_STATUS_ICONS = {
  running: '⏳',
  success: '✅',
  error: '❌',
  timeout: '⏱️',
  skipped: '⏭️',
  pending: '⏸️',
};

const TOOL_RESULT_FORMATS = {
  Bash: 'code',
  Read: 'code',
  Write: 'text',
  Edit: 'diff',
  LS: 'list',
  SearchCodebase: 'list',
  Grep: 'list',
  Glob: 'list',
  WebSearch: 'list',
  WebFetch: 'markdown',
  default: 'text',
};

class ToolDisplayFormatter {
  constructor() {
    this._customIcons = new Map();
    this._customNames = new Map();
    this._customFormats = new Map();
    this._compactMode = false;
  }

  setCustomIcon(toolName, icon) {
    this._customIcons.set(toolName, icon);
  }

  setCustomName(toolName, name) {
    this._customNames.set(toolName, name);
  }

  setCustomFormat(toolName, format) {
    this._customFormats.set(toolName, format);
  }

  setCompactMode(compact) {
    this._compactMode = compact;
  }

  getIcon(toolName) {
    return this._customIcons.get(toolName) || TOOL_DISPLAY_ICONS[toolName] || TOOL_DISPLAY_ICONS.default;
  }

  getDisplayName(toolName) {
    return this._customNames.get(toolName) || TOOL_DISPLAY_NAMES[toolName] || toolName;
  }

  getStatusIcon(status) {
    return TOOL_STATUS_ICONS[status] || '❓';
  }

  getResultFormat(toolName) {
    return this._customFormats.get(toolName) || TOOL_RESULT_FORMATS[toolName] || TOOL_RESULT_FORMATS.default;
  }

  formatToolStart(toolName, params) {
    const icon = this.getIcon(toolName);
    const name = this.getDisplayName(toolName);

    if (this._compactMode) {
      return `${icon} ${name}...`;
    }

    const paramHint = this._formatParamHint(toolName, params);
    return `${icon} 执行 ${name}${paramHint ? ` (${paramHint})` : ''}...`;
  }

  formatToolResult(toolName, result, status = 'success') {
    const icon = this.getStatusIcon(status);
    const name = this.getDisplayName(toolName);

    if (this._compactMode) {
      return `${icon} ${name}`;
    }

    if (status === 'error') {
      const errorMsg = this._extractErrorMessage(result);
      return `${icon} ${name} 失败: ${errorMsg}`;
    }

    const resultHint = this._formatResultHint(toolName, result);
    return `${icon} ${name}${resultHint ? ` - ${resultHint}` : ''}`;
  }

  formatToolProgress(toolName, progress) {
    const icon = this.getIcon(toolName);
    const name = this.getDisplayName(toolName);
    return `${icon} ${name} ${progress}`;
  }

  _formatParamHint(toolName, params) {
    if (!params) return '';

    switch (toolName) {
      case 'Bash':
        return params.command ? this._truncate(params.command, 40) : '';
      case 'Read':
        return params.file_path ? this._truncate(params.file_path.split(/[\\/]/).pop(), 30) : '';
      case 'Write':
        return params.file_path ? this._truncate(params.file_path.split(/[\\/]/).pop(), 30) : '';
      case 'Edit':
        return params.file_path ? this._truncate(params.file_path.split(/[\\/]/).pop(), 30) : '';
      case 'LS':
        return params.path ? this._truncate(params.path.split(/[\\/]/).pop(), 30) : '';
      case 'WebSearch':
        return params.query ? this._truncate(params.query, 30) : '';
      default:
        return '';
    }
  }

  _formatResultHint(toolName, result) {
    if (!result) return '';

    if (typeof result === 'string') {
      const lines = result.split('\n').length;
      const chars = result.length;
      if (lines > 1) {
        return `${lines} 行, ${chars} 字符`;
      }
      return this._truncate(result, 60);
    }

    if (typeof result === 'object') {
      if (result.content && typeof result.content === 'string') {
        return `${result.content.length} 字符`;
      }
      if (Array.isArray(result)) {
        return `${result.length} 项`;
      }
    }

    return '';
  }

  _extractErrorMessage(result) {
    if (!result) return '未知错误';
    if (typeof result === 'string') return this._truncate(result, 100);
    if (result.error) return this._truncate(String(result.error), 100);
    if (result.message) return this._truncate(String(result.message), 100);
    return this._truncate(JSON.stringify(result), 100);
  }

  _truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str || '';
    return str.slice(0, maxLen - 3) + '...';
  }
}

const globalToolDisplay = new ToolDisplayFormatter();

module.exports = {
  ToolDisplayFormatter,
  globalToolDisplay,
  TOOL_DISPLAY_ICONS,
  TOOL_DISPLAY_NAMES,
  TOOL_STATUS_ICONS,
  TOOL_RESULT_FORMATS,
};
