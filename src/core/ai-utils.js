const TOOL_TIMEOUTS = {
  Read: 30000,
  Write: 30000,
  Edit: 30000,
  Glob: 60000,
  Grep: 60000,
  LS: 30000,
  WebFetch: 60000,
  WebSearch: 60000,
  Bash: 120000,
  DeleteFile: 30000,
  CreateDirectory: 30000,
  DesktopControl: 30000,
  ImageGenerate: 300000,
  ImageGenerateFromImage: 300000,
  VideoGenerate: 300000,
  VideoGenerateFromImage: 300000,
  default: 60000
};

function getToolTimeout(toolName) {
  return TOOL_TIMEOUTS[toolName] || TOOL_TIMEOUTS.default;
}

function filterSkillsByContext(skills, toolNames) {
  return skills.filter(skill => {
    if (skill.platformMismatch) return false;
    if (skill.available === false) return false;
    if (skill.requiresTools && skill.requiresTools.length > 0) {
      const hasAllRequired = skill.requiresTools.every(rt => toolNames.includes(rt));
      if (!hasAllRequired) return false;
    }
    if (skill.fallbackForTools && skill.fallbackForTools.length > 0) {
      const hasPreferred = skill.fallbackForTools.some(ft => toolNames.includes(ft));
      if (hasPreferred) return false;
    }
    return true;
  });
}

function buildMemoryContextPrompt(context) {
  const parts = [];
  if (context.sessionMemory && context.sessionMemory.messages) {
    const msgs = context.sessionMemory.messages;
    if (msgs.length > 0) {
      const recentMessages = msgs.slice(-10).map(m => {
        const role = m.role === 'user' ? '👤 用户' : '🦀 助手';
        const time = m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const content = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
        return `[${time}] ${role}: ${content}`;
      }).join('\n');
      parts.push(`\n## 💬 近期对话记忆\n\n${recentMessages}\n`);
    }
  }
  if (context.sessionMemory && context.sessionMemory.sections) {
    const sections = context.sessionMemory.sections;
    const activeSections = Object.entries(sections)
      .filter(([_, s]) => s.content && s.content.trim())
      .slice(0, 5);
    if (activeSections.length > 0) {
      const sessionText = activeSections.map(([_name, section]) =>
        `### ${section.title}\n${section.content.slice(0, 300)}`
      ).join('\n\n');
      parts.push(`\n## ⚡ 会话关键信息\n\n${sessionText}\n`);
    }
  }
  if (context.notebook && context.notebook.length > 0) {
    const notes = context.notebook.map(n => {
      const typeEmoji = { 'user': '👤', 'feedback': '💬', 'project': '📁', 'reference': '🔗' }[n.type] || '📝';
      return `${typeEmoji} **${n.title}** (${n.type})\n ${n.content.slice(0, 200)}`;
    }).join('\n\n');
    parts.push(`\n\n## 📓 笔记本记忆\n\n以下是你记录的重要信息（按类型分类）：\n\n${notes}\n\n> 记忆类型说明：\n> - 👤 user: 用户偏好和背景\n> - 💬 feedback: 用户反馈和指导\n> - 📁 project: 项目相关信息\n> - 🔗 reference: 外部资源引用\n`);
  }
  if (context.insights && context.insights.length > 0) {
    const insights = context.insights.map(i =>
      `- 💡 ${i.content} (重要性: ${Math.round(i.importance * 100)}%)`
    ).join('\n');
    parts.push(`\n\n## 🧠🌙 深度洞察\n\n通过分析历史对话，你发现了以下模式：\n\n${insights}\n\n> 这些洞察来自自动梦境整理，帮助你更好地理解用户需求。\n`);
  }
  return parts.join('');
}

const CONCURRENT_SAFE_TOOLS = new Set([
  'Grep', 'Glob', 'LS', 'Read', 'WebSearch', 'WebFetch',
  'SkillsList', 'SkillView', 'StockQuery',
]);

const SEQUENTIAL_AFTER_TOOLS = new Set([
  'Write', 'Edit', 'DeleteFile', 'CreateDirectory', 'Bash',
]);

const executeKeywords = ['执行', '运行', '创建', '修改', '删除', '安装', '写入', '发送', '买入', '卖出', '提交', '部署', 'run', 'execute', 'create', 'delete', 'install', 'write', 'send'];

function classifyRequestCategory(toolName, _intent) {
  if (!toolName) return null;
  const name = toolName.toLowerCase();
  if (name.includes('memory') || name.includes('recall') || name.includes('remember') || name.includes('retrieve')) return 'memory';
  if (name.includes('contract') || name.includes('validate') || name.includes('verify') || name.includes('guardrail')) return 'tool_validation';
  if (name.includes('metric') || name.includes('observe') || name.includes('monitor') || name.includes('trace') || name.includes('log') || name.includes('diagnos') || name.includes('health')) return 'observability';
  if (name.includes('stream') || name.includes('sse')) return 'streaming';
  return 'tool_call';
}

function detectSessionMode(message, toolResults) {
  if (!message) return 'discover';
  const msg = message.toLowerCase();
  if (toolResults && toolResults.some(r => r.success)) return 'confirm';
  if (executeKeywords.some(k => msg.includes(k))) return 'execute';
  return 'discover';
}

function groupToolCallsForConcurrency(toolCalls) {
  if (!toolCalls || toolCalls.length <= 1) {
    return { parallel: toolCalls || [], sequential: [] };
  }
  const parallel = [];
  const sequential = [];
  let needsSequential = false;
  for (const call of toolCalls) {
    const name = call.function?.name || '';
    if (needsSequential) {
      sequential.push(call);
    } else if (SEQUENTIAL_AFTER_TOOLS.has(name)) {
      sequential.push(call);
      needsSequential = true;
    } else if (CONCURRENT_SAFE_TOOLS.has(name)) {
      parallel.push(call);
    } else {
      sequential.push(call);
    }
  }
  return { parallel, sequential };
}

/**
 * 判断 AI 回复是否为无效空输出(应替换为友好提示)。
 * 2026-08-06: 弱模型(deepseek-v4-flash)对模糊/口语输入会输出 "```json\n[]\n```" 或 {}，
 * 被透传成用户看到的空白回复。此处统一检测。
 * @param {string} reply
 * @returns {boolean}
 */
function isEmptyInvalidReply(reply) {
  if (typeof reply !== 'string') return true;
  const trimmed = reply.trim();
  if (trimmed.length === 0) return true;
  // ```json\n[]\n``` / ```\n[]\n``` 等纯 JSON 空结构
  if (/^```(?:json)?\s*\[\s*\]\s*```$/.test(trimmed)) return true;
  if (/^```(?:json)?\s*\{\s*\}\s*```$/.test(trimmed)) return true;
  return trimmed === '[]' || trimmed === '{}' || trimmed === 'null' || trimmed === 'undefined';
}

module.exports = {
  getToolTimeout,
  filterSkillsByContext,
  buildMemoryContextPrompt,
  classifyRequestCategory,
  detectSessionMode,
  groupToolCallsForConcurrency,
  isEmptyInvalidReply,
};