/**
 * Headroom 上下文压缩集成
 *
 * 可选择性地使用 headroom-ai 库对记忆上下文进行压缩，
 * 在内容到达 LLM 之前减少 token 消耗。
 *
 * 设计原则：
 * - 完全可选：无 headroom 依赖或提供者不可用时零影响
 * - 可逆压缩：CCR 缓存原始内容，工具可检索
 * - 优雅降级：compress() 始终返回有效结果
 */

let _headroom = null;
let _sharedContext = null;
let _enabled = process.env.HEADROOM_ENABLED !== 'false';

/**
 * 尝试加载 headroom-ai（懒加载）
 */
function _getHeadroom() {
  if (_headroom !== null) return _headroom;
  try {
    _headroom = require('headroom-ai');
  } catch {
    _headroom = false;
  }
  return _headroom;
}

/**
 * 压缩一段文本（如记忆上下文块）
 *
 * @param {string} text - 要压缩的文本
 * @param {object} [options]
 * @param {string} [options.model] - 可选的模型名
 * @param {number} [options.tokenBudget] - 可选的 token 预算
 * @returns {Promise<{text: string, tokensBefore: number, tokensAfter: number, compressionRatio: number, ccrHash: string|null}>}
 */
async function compressText(text, options = {}) {
  const hr = _getHeadroom();
  if (!hr || !_enabled || !text || text.length < 200) {
    return { text, tokensBefore: 0, tokensAfter: 0, compressionRatio: 1, ccrHash: null };
  }

  try {
    const result = await hr.compress(
      [{ role: 'user', content: text }],
      { model: options.model || 'gpt-4o', tokenBudget: options.tokenBudget }
    );

    const compressed = result.messages?.[0]?.content || text;
    const ccrHash = result.ccrHashes?.[0] || null;

    return {
      text: compressed,
      tokensBefore: result.tokensBefore || 0,
      tokensAfter: result.tokensAfter || 0,
      compressionRatio: result.compressionRatio || 1,
      ccrHash,
    };
  } catch {
    return { text, tokensBefore: 0, tokensAfter: 0, compressionRatio: 1, ccrHash: null };
  }
}

/**
 * 压缩消息数组
 *
 * @param {Array} messages - OpenAI 格式消息数组
 * @param {object} [options]
 * @returns {Promise<{messages: Array, tokensBefore: number, tokensAfter: number, compressionRatio: number}>}
 */
async function compressMessages(messages, options = {}) {
  const hr = _getHeadroom();
  if (!hr || !_enabled || !messages || messages.length === 0) {
    return { messages: messages || [], tokensBefore: 0, tokensAfter: 0, compressionRatio: 1 };
  }

  try {
    const result = await hr.compress(messages, {
      model: options.model || 'gpt-4o',
      tokenBudget: options.tokenBudget,
    });

    return {
      messages: result.messages || messages,
      tokensBefore: result.tokensBefore || 0,
      tokensAfter: result.tokensAfter || 0,
      compressionRatio: result.compressionRatio || 1,
    };
  } catch {
    return { messages, tokensBefore: 0, tokensAfter: 0, compressionRatio: 1 };
  }
}

/**
 * 获取 Headroom SharedContext（跨 agent 记忆共享）
 * 仅当 headroom 可用时有效
 */
function getSharedContext() {
  const hr = _getHeadroom();
  if (!hr || !_enabled) return null;
  if (!_sharedContext) {
    try {
      _sharedContext = new hr.SharedContext();
    } catch {
      return null;
    }
  }
  return _sharedContext;
}

/**
 * 启用/禁用 Headroom 压缩
 */
function setEnabled(enabled) {
  _enabled = enabled;
}

function isEnabled() {
  return _enabled && _getHeadroom() !== false;
}

module.exports = {
  compressText,
  compressMessages,
  getSharedContext,
  setEnabled,
  isEnabled,
};
