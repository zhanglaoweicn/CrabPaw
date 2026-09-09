const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// eslint-disable-next-line no-unused-vars
const { BudgetConfig, DEFAULT_BUDGET } = require('./budget-config');
const { DATA_DIR } = require('./config');

const PERSISTED_TAG_OPEN = '<persisted-output>';
const PERSISTED_TAG_CLOSE = '</persisted-output>';
const STORAGE_DIR_NAME = 'tool-results';
// P0-2(Runtime优化轮): 旧版本把大结果写 os.tmpdir()/crabpaw-results——重启即失,
// 会话里引用的文件路径成悬空。迁移到 DATA_DIR/tool-results(执行状态,受控 TTL);
// 旧路径仅作为升级期兜底读取,不再写入。
const LEGACY_TMP_DIR_NAME = 'crabpaw-results';

function _getStorageDir() {
  return path.join(DATA_DIR, STORAGE_DIR_NAME);
}

function _getLegacyStorageDir() {
  const os = require('os');
  return path.join(os.tmpdir(), LEGACY_TMP_DIR_NAME);
}

// 进程内一次性清理——首个工具结果写入时触发(TTL 默认 7 天,原 cleanOldResults
// 此前零调用方,目录只增不清)
let _cleanupDone = false;
function _ensureStorageDir() {
  const dir = _getStorageDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!_cleanupDone) {
    _cleanupDone = true;
    const ttl = Number(process.env.TOOL_RESULT_TTL_MS);
    try {
      const cleaned = cleanOldResults(Number.isFinite(ttl) && ttl > 0 ? ttl : 7 * 24 * 60 * 60 * 1000);
      if (cleaned > 0) console.log(`[ToolResultStorage] 启动清理过期工具结果: ${cleaned} 个`);
    } catch (e) {
      console.warn('[ToolResultStorage] 启动清理失败(忽略):', e.message);
    }
  }
  return dir;
}

function generatePreview(content, maxChars) {
  maxChars = maxChars || DEFAULT_BUDGET.previewSize;
  if (content.length <= maxChars) {
    return { preview: content, hasMore: false };
  }
  let truncated = content.substring(0, maxChars);
  const lastNl = truncated.lastIndexOf('\n');
  if (lastNl > maxChars / 2) {
    truncated = truncated.substring(0, lastNl + 1);
  }
  return { preview: truncated, hasMore: true };
}

function persistToolResult({ toolUseId, content, toolName, budget }) {
  budget = budget || DEFAULT_BUDGET;
  const threshold = budget.resolveThreshold(toolName);
  if (content.length <= threshold) {
    return { persisted: false, content };
  }
  if (threshold === Infinity) {
    return { persisted: false, content };
  }
  const dir = _ensureStorageDir();
  const id = toolUseId || crypto.randomUUID();
  const filePath = path.join(dir, `${id}.txt`);
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (e) {
    console.error('[ToolResultStorage] 持久化失败?', e.message);
    return { persisted: false, content };
  }
  const { preview, hasMore } = generatePreview(content, budget.previewSize);
  const lines = content.split('\n').length;
  const sizeKb = (content.length / 1024).toFixed(1);
  const persistedContent = [
    PERSISTED_TAG_OPEN,
    `文件: ${filePath}`,
    `大小: ${sizeKb} KB | 行数: ${lines} | 工具: ${toolName}`,
    '---',
    preview,
    hasMore ? `... (截断，完整内容请读取文件: ${filePath})` : '',
    PERSISTED_TAG_CLOSE,
  ].filter(Boolean).join('\n');
  return { persisted: true, content: persistedContent, filePath, originalSize: content.length };
}

function enforceTurnBudget({ toolResults, budget }) {
  budget = budget || DEFAULT_BUDGET;
  let totalSize = 0;
  const indexed = toolResults.map((r, i) => ({
    index: i,
    toolName: r.toolName || '',
    content: r.content || '',
    size: (r.content || '').length,
    persisted: r.persisted || false,
  }));
  for (const r of indexed) {
    totalSize += r.size;
  }
  if (totalSize <= budget.turnBudget) {
    return toolResults;
  }
  const unpersisted = indexed
    .filter(r => !r.persisted && !(r.toolName in require('./budget-config').PINNED_THRESHOLDS))
    .sort((a, b) => b.size - a.size);
  for (const item of unpersisted) {
    if (totalSize <= budget.turnBudget) break;
    const result = persistToolResult({
      toolUseId: item.toolName + '_' + item.index,
      content: item.content,
      toolName: item.toolName,
      budget,
    });
    if (result.persisted) {
      const reduction = item.content.length - result.content.length;
      totalSize -= reduction;
      toolResults[item.index] = {
        ...toolResults[item.index],
        content: result.content,
        persisted: true,
      };
    }
  }
  return toolResults;
}

function readPersistedResult(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    // P0-2: 升级期兜底——历史会话里嵌入的旧 tmpdir 全路径已被系统清理,或调用方
    // 只传文件名时,按文件名回退旧目录查找,避免升级后引用悬空
    const base = path.basename(String(filePath || ''));
    if (base) {
      const legacy = path.join(_getLegacyStorageDir(), base);
      if (fs.existsSync(legacy)) {
        return fs.readFileSync(legacy, 'utf-8');
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cleanOldResults(maxAgeMs) {
  maxAgeMs = maxAgeMs || 24 * 60 * 60 * 1000;
  const results = { main: _cleanDir(_getStorageDir(), maxAgeMs), legacy: _cleanDir(_getLegacyStorageDir(), maxAgeMs) };
  return results.main + results.legacy;
}

function _cleanDir(dir, maxAgeMs) {
  if (!fs.existsSync(dir)) return 0;
  const now = Date.now();
  let cleaned = 0;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (e) { console.warn('[tool-result-storage] 单文件清理失败(跳过):', e.message); }
    }
  } catch (e) { console.warn('[tool-result-storage] 目录清理失败(跳过):', e.message); }
  return cleaned;
}

module.exports = {
  persistToolResult,
  enforceTurnBudget,
  generatePreview,
  readPersistedResult,
  cleanOldResults,
  PERSISTED_TAG_OPEN,
  PERSISTED_TAG_CLOSE,
};
