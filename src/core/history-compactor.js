/**
 * history-compactor — 会话历史长内容压缩器（2026-09-18 会话膨胀治理 层1）
 *
 * 背景：长内容（文章草稿/工具大段结果转述/长回复/粘贴长文）原样持久化进会话历史，
 * 每条可达数万字符。压缩器的尾部保护窗恰好护住最近的巨型消息，每轮压缩只省 2%，
 * 永远追不上增量——voice_shell_user 会话实测 83612 tokens（超限 1022%）。
 *
 * 治理：超过阈值的历史消息原文落档到文件（DATA_DIR/tool-results，随工具结果 7 天
 * TTL 清理），历史里只保留「预览 + 存档引用」。模型需要完整原文时用 Read 读取
 * 存档文件——与工具结果持久化（persistToolResult）同一模式。
 *
 * 双入口（与 hint-sanitizer 同模式）：
 *   - 持久化侧：unified-memory.addMessage —— 增量不再膨胀（DB/检索/会话内存同步瘦身）
 *   - 装配侧：ai.prepareChatContext 历史映射 —— 存量膨胀立即瘦身（不等新会话）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

// 超过该字符数的历史消息触发落档。8000 字符 ≈ 2-3K tokens（中文按 1.5 字/token、
// 英文按 4 字符/token 混合估算）——单条历史超过它就是对上下文预算的滥用。
const HISTORY_ARCHIVE_THRESHOLD_CHARS = 8000;
// 落档后历史里保留的预览长度
const HISTORY_PREVIEW_CHARS = 1200;
// 与 tool-result-storage 共用目录（7 天 TTL 清理），存档文件名前缀区分来源
const ARCHIVE_DIR_NAME = 'tool-results';
const ARCHIVE_PREFIX = 'history-';

const ARCHIVE_NOTE_HEAD = '[长内容已存档';

function _archiveDir() {
  return path.join(DATA_DIR, ARCHIVE_DIR_NAME);
}

function isArchivedContent(content) {
  return typeof content === 'string' && content.includes(ARCHIVE_NOTE_HEAD);
}

/**
 * 把长原文写入存档文件，返回带预览+引用的替换内容。
 * 非长内容原样返回；写入失败时退化为就地截断（宁可截断也不能让原文整条入库）。
 * @param {string} content 原文
 * @param {string} role    消息角色（存档元信息用）
 * @returns {string}
 */
function compactMessageContent(content, role = 'user') {
  if (!content || typeof content !== 'string') return content;
  if (content.length <= HISTORY_ARCHIVE_THRESHOLD_CHARS) return content;
  if (isArchivedContent(content)) return content;

  const dir = _archiveDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 10);
    const filePath = path.join(dir, `${ARCHIVE_PREFIX}${Date.now().toString(36)}-${hash}.txt`);
    fs.writeFileSync(filePath, content, 'utf-8');

    const preview = content.slice(0, HISTORY_PREVIEW_CHARS);
    const note = `${ARCHIVE_NOTE_HEAD}（本条${role === 'user' ? '用户消息' : '助手回复'}原文约 ${content.length} 字，为控制上下文体积已存档至: ${filePath}，保留 7 天。以上为开头预览，如需完整原文请用 Read 工具读取该文件。）]`;
    return `${preview}\n\n${note}`;
  } catch (e) {
    console.warn('[history-compactor] 存档写入失败，退化为就地截断:', e.message);
    return content.slice(0, HISTORY_PREVIEW_CHARS) + `\n\n${ARCHIVE_NOTE_HEAD}（原文约 ${content.length} 字，存档失败已就地截断）]`;
  }
}

/**
 * 装配侧批量压缩：对历史消息数组逐条压缩长内容，保留其余字段（id 等）。
 * @param {Array<{role: string, content: string}>} messages
 * @returns {{messages: Array, compactedCount: number}}
 */
function compactHistoryMessages(messages) {
  if (!Array.isArray(messages)) return { messages, compactedCount: 0 };
  let compactedCount = 0;
  const out = messages.map(m => {
    if (!m || typeof m.content !== 'string') return m;
    if (m.role !== 'user' && m.role !== 'assistant') return m;
    const compacted = compactMessageContent(m.content, m.role);
    if (compacted !== m.content) {
      compactedCount++;
      return { ...m, content: compacted };
    }
    return m;
  });
  return { messages: out, compactedCount };
}

module.exports = {
  compactMessageContent,
  compactHistoryMessages,
  isArchivedContent,
  HISTORY_ARCHIVE_THRESHOLD_CHARS,
  HISTORY_PREVIEW_CHARS,
};
