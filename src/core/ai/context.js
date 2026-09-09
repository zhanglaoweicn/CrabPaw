/**
 * AI 上下文构建模块 - 从 ai.js 提取
 *
 * 包含记忆加载、上下文构建、意图检测等逻辑
 */

const { memoryManager } = require('../memory-system');
// eslint-disable-next-line no-unused-vars
const { loadSmartContext, buildCompactMemoryPrompt } = require('../memory-smart-loader');

/**
 * 加载记忆
 */
async function loadMemory() {
  try {
    if (!memoryManager || typeof memoryManager.loadMemories !== 'function') return;
    await memoryManager.loadMemories();
  } catch (e) {
    console.error('加载记忆失败:', e.message);
  }
}

/**
 * 获取相关记忆
 */
async function getRelevantMemories(message, limit = 5) {
  try {
    if (!memoryManager || typeof memoryManager.search !== 'function') return [];
    const results = await memoryManager.search(message, { limit });
    return results || [];
  } catch (e) {
    console.error('搜索记忆失败:', e.message);
    return [];
  }
}

/**
 * 构建记忆提示词
 */
function buildMemoryPrompt(memories) {
  if (!memories || memories.length === 0) return '';
  
  const lines = memories.map(m => {
    if (typeof m === 'string') return m;
    return m.content || m.text || JSON.stringify(m);
  });
  
  return '相关记忆:\n' + lines.map(l => `- ${l}`).join('\n');
}

/**
 * 检测消息意图
 */
function detectMessageIntent(message, _channel) {
  if (!message) return { type: 'general', confidence: 0 };

  const lower = message.toLowerCase();

  // 搜索意图
  if (/搜索|查找|查询|search|find|look up/i.test(lower)) {
    return { type: 'search', confidence: 0.8 };
  }

  // 分析意图
  if (/分析|评估|比较|analyze|evaluate|compare/i.test(lower)) {
    return { type: 'analysis', confidence: 0.7 };
  }

  // 创作意图
  if (/写|创作|生成|write|create|generate/i.test(lower)) {
    return { type: 'creation', confidence: 0.7 };
  }

  // 闲聊
  if (/你好|hello|hi|嗨|早上好|晚上好/i.test(lower)) {
    return { type: 'greeting', confidence: 0.9 };
  }

  return { type: 'general', confidence: 0.3 };
}

/**
 * 构建记忆上下文提示词
 */
function buildMemoryContextPrompt(context) {
  if (!context) return '';

  const parts = [];

  if (context.recentMemories && context.recentMemories.length > 0) {
    parts.push('近期记忆:');
    context.recentMemories.forEach(m => {
      parts.push(`- ${typeof m === 'string' ? m : m.content || JSON.stringify(m)}`);
    });
  }

  if (context.userPreferences) {
    parts.push(`用户偏好: ${JSON.stringify(context.userPreferences)}`);
  }

  if (context.conversationSummary) {
    parts.push(`对话摘要: ${context.conversationSummary}`);
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

module.exports = {
  loadMemory,
  getRelevantMemories,
  buildMemoryPrompt,
  detectMessageIntent,
  buildMemoryContextPrompt,
};
