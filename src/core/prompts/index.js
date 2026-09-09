/**
 * Prompt as Code — 模块化提示词动态组装器
 *
 * 替换 54KB 单体 system-prompt.js，支持按角色/场景/任务类型动态组合提示词段。
 *
 * 目录结构：
 *   prompts/base/       — 基础角色提示词
 *   prompts/tasks/      — 任务特定提示词
 *   prompts/tools/      — 工具使用指南
 *   prompts/personality/ — 个性化片段
 *   prompts/index.js    — 动态组装器（本文件）
 */

const fs = require("fs");
const path = require("path");

const PROMPTS_DIR = __dirname;

/** 加载指定子目录下所有 .txt 文件，返回 { name, content } 数组 */
function _loadSection(dirName) {
  const dir = path.join(PROMPTS_DIR, dirName);
  const result = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".txt") || f.endsWith(".md"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8").trim();
      if (content) {
        result.push({ name: f.replace(/\.(txt|md)$/, ""), content });
      }
    }
  } catch (_) { console.warn('[prompts] 读取提示词文件失败:', _.message); }
  return result;
}

/**
 * 动态组装 System Prompt
 *
 * @param {Object} opts
 *   - role: string — "coder" | "researcher" | "planner" | "analyst" | "communicator"
 *   - taskType: string — "code_review" | "debugging" | "refactor" | "exploration" | "write"
 *   - toolNames: string[] — 当前可用的工具名列表
 *   - personalityMarkers: { language, tone, verbosity } — 用户个性化偏好
 *   - customSections: { name, content }[] — 调用方注入的额外段
 * @returns {string} 完整提示词
 */
function assemblePrompt(opts = {}) {
  const sections = [];

  // ─── 1. 基础角色（必需）───
  const base = _loadSection("base");
  if (opts.role) {
    const roleSection = base.find(s => s.name === opts.role);
    if (roleSection) sections.push(roleSection.content);
  }
  if (sections.length === 0) {
    const defaultBase = base.find(s => s.name === "coder") || base[0];
    if (defaultBase) sections.push(defaultBase.content);
  }

  // ─── 2. 任务特定段（可选）───
  if (opts.taskType) {
    const tasks = _loadSection("tasks");
    const taskSection = tasks.find(s => s.name === opts.taskType);
    if (taskSection) sections.push(taskSection.content);
  }

  // ─── 3. 工具使用指南（按工具列表裁剪）───
  if (opts.toolNames && opts.toolNames.length > 0) {
    const tools = _loadSection("tools");
    for (const t of tools) {
      // 只包含当前可用工具的指南
      if (opts.toolNames.some(tn => t.name.toLowerCase().includes(tn.toLowerCase()))) {
        sections.push(t.content);
      }
    }
  }

  // ─── 4. 个性化（语言/语气/详细程度）───
  if (opts.personalityMarkers) {
    const personality = _loadSection("personality");
    const { language, tone, verbosity } = opts.personalityMarkers;
    for (const p of personality) {
      if (language && p.name.includes(language)) sections.push(p.content);
      if (tone && p.name.includes(tone)) sections.push(p.content);
      if (verbosity && p.name.includes(verbosity)) sections.push(p.content);
    }
  }

  // ─── 5. 自定义注入段 ───
  if (opts.customSections && opts.customSections.length > 0) {
    for (const cs of opts.customSections) {
      sections.push(cs.content);
    }
  }

  return sections.join("\n\n");
}

/**
 * 列出所有可用提示词段（用于 A/B 测试和审计）
 */
function listSections() {
  const result = {};
  for (const dir of ["base", "tasks", "tools", "personality"]) {
    result[dir] = _loadSection(dir).map(s => s.name);
  }
  return result;
}

/**
 * 注册一个提示词段到文件系统
 */
function registerSection(dirName, name, content) {
  const dir = path.join(PROMPTS_DIR, dirName);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { console.warn('[prompts] 创建提示词目录失败:', _.message); }
  fs.writeFileSync(path.join(dir, name + ".txt"), content, "utf8");
}

/**
 * 加载单个提示词文件内容
 * @param {string} subdir - 子目录名（如 "compressor", "summarizer"）
 * @param {string} filename - 文件名（含扩展名）
 * @param {object} [vars] - 可选模板变量替换 { key: value }
 * @returns {string} 文件内容（空字符串如果文件不存在）
 */
function loadPromptFile(subdir, filename, vars) {
  const filePath = path.join(PROMPTS_DIR, subdir, filename);
  try {
    let content = fs.readFileSync(filePath, "utf8").trim();
    if (vars) {
      for (const [key, val] of Object.entries(vars)) {
        content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val != null ? val : "");
      }
    }
    return content;
  } catch (_) {
    console.warn(`[prompts] 加载提示词文件失败: ${filePath}`, _.message);
    return "";
  }
}

module.exports = { assemblePrompt, listSections, registerSection, loadPromptFile };