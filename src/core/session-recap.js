const RECENT_TURN_WINDOW = 20;
const PROMPT_PREVIEW_CHARS = 140;
const ASSISTANT_PREVIEW_CHARS = 200;
const MAX_FILES_LISTED = 5;

const FILE_EDIT_TOOLS = {
  Write: 'path',
  Edit: 'path',
  Read: 'path',
  SkillManage: 'file_path',
  SkillView: 'file_path',
};

function coerceText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter(block => block.type === 'text' || typeof block === 'string')
      .map(block => (typeof block === 'string' ? block : block.text || ''))
      .join('');
  }
  return String(value);
}

function extractToolNames(messages) {
  const names = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        names.push(tc.function?.name || 'unknown');
      }
    }
  }
  return names;
}

function extractEditedFiles(messages) {
  const files = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const toolName = tc.function?.name || '';
        const pathKey = FILE_EDIT_TOOLS[toolName];
        if (!pathKey) continue;
        try {
          const args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
          const filePath = args?.[pathKey];
          if (filePath && typeof filePath === 'string') {
            files.push(filePath);
          }
        } catch { console.warn('[session-recap] silent catch, error swallowed'); }
      }
    }
  }
  return [...new Set(files)];
}

function categorizeTools(toolNames) {
  const categories = {
    file_edit: 0,
    search: 0,
    browser: 0,
    web: 0,
    terminal: 0,
    memory: 0,
    skill: 0,
    other: 0,
  };

  for (const name of toolNames) {
    if (['Write', 'Edit', 'DeleteFile', 'CreateDirectory'].includes(name)) {
      categories.file_edit++;
    } else if (['Read', 'Glob', 'Grep', 'LS'].includes(name)) {
      categories.search++;
    } else if (name.startsWith('Browser') || name.startsWith('Desktop')) {
      categories.browser++;
    } else if (name.startsWith('Web')) {
      categories.web++;
    } else if (['Bash', 'Terminal', 'ExecuteCode'].includes(name)) {
      categories.terminal++;
    } else if (name.startsWith('Memory') || name === 'TodoWrite' || name === 'TodoRead') {
      categories.memory++;
    } else if (name.startsWith('Skill')) {
      categories.skill++;
    } else {
      categories.other++;
    }
  }
  return categories;
}

// eslint-disable-next-line no-unused-vars
function buildRecap(messages, options = {}) {
  if (!messages || messages.length === 0) {
    return '📭 空会话，尚无内容';
  }

  const recentMessages = messages.slice(-RECENT_TURN_WINDOW * 2);
  const toolNames = extractToolNames(recentMessages);
  const editedFiles = extractEditedFiles(recentMessages);
  const categories = categorizeTools(toolNames);

  const userMessages = recentMessages.filter(m => m.role === 'user');
  const assistantMessages = recentMessages.filter(m => m.role === 'assistant');

  const lastUserMsg = userMessages.length > 0
    ? coerceText(userMessages[userMessages.length - 1].content)
    : '';
  const lastAssistantMsg = assistantMessages.length > 0
    ? coerceText(assistantMessages[assistantMessages.length - 1].content)
    : '';

  const lines = [];

  lines.push(`📊 会话回顾 (${messages.length} 条消息)`);

  if (toolNames.length > 0) {
    const topCategories = Object.entries(categories)
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);

    if (topCategories.length > 0) {
      const categoryLabels = {
        file_edit: '文件编辑',
        search: '代码搜索',
        browser: '浏览器',
        web: '网络搜索',
        terminal: '终端命令',
        memory: '记忆/待办',
        skill: '技能管理',
        other: '其他工具',
      };
      const activitySummary = topCategories
        .slice(0, 3)
        .map(([cat, count]) => `${categoryLabels[cat] || cat}×${count}`)
        .join(', ');
      lines.push(`🔧 主要活动: ${activitySummary}`);
    }

    const uniqueTools = new Set(toolNames);
    lines.push(`🛠 使用了 ${uniqueTools.size} 种工具，${toolNames.length} 次调用`);
  }

  if (editedFiles.length > 0) {
    const displayFiles = editedFiles.slice(0, MAX_FILES_LISTED);
    const suffix = editedFiles.length > MAX_FILES_LISTED
      ? ` (+${editedFiles.length - MAX_FILES_LISTED} 更多)`
      : '';
    lines.push(`📝 涉及文件: ${displayFiles.join(', ')}${suffix}`);
  }

  if (lastUserMsg) {
    const preview = lastUserMsg.length > PROMPT_PREVIEW_CHARS
      ? lastUserMsg.slice(0, PROMPT_PREVIEW_CHARS) + '…'
      : lastUserMsg;
    lines.push(`👤 最近用户: ${preview}`);
  }

  if (lastAssistantMsg) {
    const preview = lastAssistantMsg.length > ASSISTANT_PREVIEW_CHARS
      ? lastAssistantMsg.slice(0, ASSISTANT_PREVIEW_CHARS) + '…'
      : lastAssistantMsg;
    lines.push(`🤖 最近回复: ${preview}`);
  }

  return lines.join('\n');
}

module.exports = {
  buildRecap,
  extractToolNames,
  extractEditedFiles,
  categorizeTools,
  coerceText,
};
