/**
 * Context Files — 项目上下文文件发现与注入
 *
 *   - 从项目目录自动发现指令文件（AGENTS.md、.cursorrules 等）
 *   - 优先级系统：首个匹配项胜出
 *   - 安全扫描：注入检测 + 不可见字符清理
 *   - 截断处理：超长文件按 70/20 头尾比例截断
 *   - YAML 前置元数据移除
 *
 * 支持的文件格式（按优先级）：
 *   1. .crabpaw.md / CRABPAW.md — CrabPaw 原生项目配置
 *   2. AGENTS.md — 通用 Agent 指令文件
 *   3. CLAUDE.md — Claude Code 兼容
 *   4. .cursorrules / .cursor/rules/*.mdc — Cursor 兼容
 */

const fs = require('fs');
const path = require('path');
const { scanContextContent, scanAndStripInvisible } = require('./context-scanner');

const MAX_CONTENT_LENGTH = 20000; // 单文件上限 20k 字符
const HEAD_RATIO = 0.7; // 截断时保留头部 70%

/**
 * 上下文文件定义
 * name: 文件名
 * searchUp: 是否向上遍历到 git 根目录
 * glob: 是否支持 glob 模式（.cursor/rules/*.mdc）
 */
const CONTEXT_FILE_DEFS = [
  { name: '.crabpaw.md', searchUp: true, glob: false },
  { name: 'CRABPAW.md', searchUp: true, glob: false },
  { name: 'AGENTS.md', searchUp: false, glob: false },
  { name: 'CLAUDE.md', searchUp: false, glob: false },
  { name: '.cursorrules', searchUp: false, glob: false },
  { name: '.cursor/rules', searchUp: false, glob: true }, // .cursor/rules/*.mdc
];

/**
 * 查找 git 仓库根目录
 */
function _findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) { // 最多向上 20 层
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到达根目录
    dir = parent;
  }
  return null;
}

/**
 * 移除 YAML 前置元数据（--- 包裹的部分）
 */
function _stripYamlFrontMatter(content) {
  if (!content.startsWith('---')) return content;
  const endMatch = content.indexOf('---', 3);
  if (endMatch === -1) return content;
  return content.slice(endMatch + 3).trimStart();
}

/**
 * 截断超长内容（70% 头部 + 截断标记 + 20% 尾部）
 */
function _truncateContent(content, filename) {
  if (content.length <= MAX_CONTENT_LENGTH) return content;

  const headLen = Math.floor(MAX_CONTENT_LENGTH * HEAD_RATIO);
  const tailLen = Math.floor(MAX_CONTENT_LENGTH * (1 - HEAD_RATIO));
  const marker = `\n\n... [${filename} 截断：原文 ${content.length} 字符，已保留头部 ${headLen} + 尾部 ${tailLen} 字符] ...\n\n`;

  return content.slice(0, headLen) + marker + content.slice(content.length - tailLen);
}

/**
 * 读取并处理单个文件
 * @returns {{ content: string, filename: string, source: string } | null}
 */
function _loadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    let content = fs.readFileSync(filePath, 'utf-8');

    // 1. 移除 YAML 前置元数据
    content = _stripYamlFrontMatter(content);

    // 2. 清理不可见字符
    content = scanAndStripInvisible(content);

    // 3. 安全扫描
    const scanResult = scanContextContent(content, path.basename(filePath));
    if (!scanResult.safe) {
      return {
        content: scanResult.content,
        filename: path.basename(filePath),
        source: filePath,
      };
    }

    // 4. 截断
    content = _truncateContent(content.trim(), path.basename(filePath));

    if (!content) return null;

    return {
      content,
      filename: path.basename(filePath),
      source: filePath,
    };
  } catch (e) {
    // 文件读取失败静默跳过
    return null;
  }
}

/**
 * 加载 .cursor/rules/ 目录下的 .mdc 文件
 */
function _loadCursorRules(rulesDir) {
  const results = [];
  try {
    if (!fs.existsSync(rulesDir)) return results;
    const entries = fs.readdirSync(rulesDir);
    for (const entry of entries) {
      if (entry.endsWith('.mdc')) {
        const loaded = _loadFile(path.join(rulesDir, entry));
        if (loaded) results.push(loaded);
      }
    }
  } catch (e) {
    /* 静默跳过 */
    console.warn('[context-files.js] 空 catch 补日志:', e && e.message);
  }

  return results;
}

/**
 * 发现并加载项目上下文文件
 *
 * 优先级系统：首个匹配项胜出（同一类型只加载一个）
 * .crabpaw.md / CRABPAW.md 会向上遍历到 git 根目录
 * 其他文件仅在当前工作目录查找
 *
 * @param {string} cwd - 当前工作目录
 * @returns {{ sections: Array<{content: string, filename: string, source: string}>, summary: string }}
 */
function discoverContextFiles(cwd) {
  const workDir = path.resolve(cwd || process.cwd());
  const gitRoot = _findGitRoot(workDir);
  const sections = [];

  for (const def of CONTEXT_FILE_DEFS) {
    if (def.glob) {
      // glob 模式：.cursor/rules/*.mdc
      const rulesDir = path.join(workDir, def.name);
      const rules = _loadCursorRules(rulesDir);
      if (rules.length > 0) {
        for (const rule of rules) {
          sections.push(rule);
        }
        break; // 找到 .cursor/rules 后不再查找更低优先级
      }
      continue;
    }

    if (def.searchUp && gitRoot) {
      // 向上遍历到 git 根目录
      let dir = workDir;
      let found = false;
      for (let i = 0; i < 20; i++) {
        const filePath = path.join(dir, def.name);
        const loaded = _loadFile(filePath);
        if (loaded) {
          sections.push(loaded);
          found = true;
          break;
        }
        if (dir === gitRoot) break;
        dir = path.dirname(dir);
      }
      if (found) break; // 首个匹配项胜出
    } else {
      // 仅当前工作目录
      const filePath = path.join(workDir, def.name);
      const loaded = _loadFile(filePath);
      if (loaded) {
        sections.push(loaded);
        break; // 首个匹配项胜出
      }
    }
  }

  const summary = sections.length > 0
    ? sections.map(s => `${s.filename} (${s.source})`).join(', ')
    : '无上下文文件';

  return { sections, summary };
}

/**
 * 生成上下文文件的系统提示块
 * @param {string} cwd - 当前工作目录
 * @returns {string} 注入到系统提示中的上下文块
 */
function buildContextFilesPrompt(cwd) {
  const { sections } = discoverContextFiles(cwd);
  if (sections.length === 0) return '';

  const parts = ['# 项目上下文', ''];
  parts.push('以下项目上下文文件已加载，请在工作中遵循其中的指引：');
  parts.push('');

  for (const section of sections) {
    parts.push(`## ${section.filename}`);
    parts.push(`(来源: ${section.source})`);
    parts.push('');
    parts.push(section.content);
    parts.push('');
  }

  return parts.join('\n');
}

module.exports = {
  discoverContextFiles,
  buildContextFilesPrompt,
  CONTEXT_FILE_DEFS,
  MAX_CONTENT_LENGTH,
};
