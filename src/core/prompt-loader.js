/**
 * Prompt Loader — 从 prompts/*.md 加载外部化提示词
 *
 * 设计目标：
 * - 将大块静态提示词文本从 system-prompt.js 中外部化到 .md 文件
 * - 带内存缓存，避免每轮对话重复读盘
 * - 支持 {{var}} 占位符替换，处理少量动态内容
 * - 文件缺失时静默返回空串，不阻断 prompt 构建
 *
 * 用法：
 *   const { loadPrompt, invalidatePromptCache } = require('./prompt-loader');
 *   const text = loadPrompt('stable-safety');              // 读取 prompts/stable-safety.md
 *   const text = loadPrompt('stable-rule-priority', { name: '飞书' }); // 替换 {{name}}
 *
 * 缓存策略：
 * - 首次加载后缓存到 module 级 Map
 * - invalidatePromptCache() 清空全部缓存（用于热重载/测试）
 * - 单次进程生命周期内文件不变，无需文件监听
 */

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

// 模块级缓存：name -> 文件原始内容（未做占位符替换）
const _cache = new Map();

// 占位符正则：{{varName}}
const _PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * 加载提示词文件并替换占位符
 * @param {string} name - 文件名（不含扩展名），对应 prompts/<name>.md
 * @param {Object<string, string|number>} [vars] - 占位符替换映射
 * @returns {string} 文件内容（BOM 已剥离）；文件不存在时返回 ''
 */
function loadPrompt(name, vars) {
  if (typeof name !== 'string' || !name) return '';

  // 1. 读取（带缓存）
  let raw = _cache.get(name);
  if (raw === undefined) {
    const filePath = path.join(PROMPTS_DIR, `${name}.md`);
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      // 剥离 BOM
      if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
      // 剥离文件末尾多余换行（保留内容内部的换行结构）
      raw = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
      _cache.set(name, raw);
    } catch (e) {
      // 文件不存在或读取失败：缓存空串避免重复读盘告警
      console.warn(`[prompt-loader] 无法加载提示词 "${name}": ${e.message}`);
      _cache.set(name, '');
      return '';
    }
  }

  if (!raw) return '';

  // 2. 占位符替换
  if (!vars || Object.keys(vars).length === 0) return raw;

  return raw.replace(_PLACEHOLDER_RE, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match; // 未提供该变量时保留原占位符，便于排查
  });
}

/**
 * 加载多个提示词块并用空行拼接
 * @param {string[]} names
 * @param {Object} [vars]
 * @returns {string}
 */
function loadPromptBlocks(names, vars) {
  return names
    .map(n => loadPrompt(n, vars))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 清空全部缓存。用于测试或热重载场景。
 */
function invalidatePromptCache() {
  _cache.clear();
}

module.exports = {
  loadPrompt,
  loadPromptBlocks,
  invalidatePromptCache,
  PROMPTS_DIR,
};
