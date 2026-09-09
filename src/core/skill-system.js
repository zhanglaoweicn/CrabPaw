/**
 * CrabPaw Skill System — 技能体系编排门面
 *
 * 职责边界（2026-08-01 明确）：
 * - 执行引擎/LLM 注入链路 → src/core/skills.js（ai.js 主入口，含安全扫描、
 *   依赖检查、多语言执行器、prompt 构建）
 * - 本文件 = 编排层：聚合 Router（任务分类）/ Scoring（评分）/ DependencyManager /
 *   TaskAdapter / HotReload / CapabilityRegistry / Recommender，并暴露 CRUD 与
 *   市场操作给 handler 层（skill-handler.js、mcp-server-mode.js）。
 * - skill-system 的 loadSkillsFromDir 是面向 Router/Scoring 的简化注册表结构
 *   （map 形态），与 skills.js 的数组形态共存是刻意的，勿合并。
 */
const fs = require('fs');
const path = require('path');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('./config');

const {
  getCurrentPlatform,
  matchesPlatform,
  scanSkillDirectory,
  listSkillsMetadata,
  viewSkillContent,
  getSkillCategories
} = require('./skill-loader-enhanced');

const { getHotReloader } = require('./skill-hot-reload');
const {
  createSkill,
  editSkill,
  patchSkill,
  deleteSkill,
  writeSkillFile,
  removeSkillFile,
  findSkillPath
} = require('./skill-editor');
const {
  searchClawHub,
  installFromClawHub,
  installFromGitHub,
  installFromUrl,
  listInstalledSkills,
  uninstallSkill
} = require('./skill-market');
// 2026-08-18 P2: 移除死引用 skill-metrics(文件保留——tool-call-processor 仍用 getSkillEvolution)
// eslint-disable-next-line no-unused-vars
const { getSkillLifecycleManager } = require('./skill-lifecycle');
const { globalSkillRouter, initializeRouter } = require('./skill-router');
const { globalScoringSystem } = require('./skill-scoring');
const { globalDependencyManager } = require('./skill-dependency-manager');
const { globalTaskAdapter, initializeAdapter } = require('./skill-task-adapter');
const { executeSkillAdvanced: executeSkill, globalExecutorFactory, EXECUTOR_TYPE, EXECUTOR_STATE } = require('./skills');
const { getSkillRecommender } = require('./skill-recommender');
const { parseFrontmatter } = require('./skill/frontmatter-parser');

let _registry = null;
let _lastLoadTime = 0;
const CACHE_TTL = 60000;

function loadSkillsFromDir(skillsDir, source) {
  const registry = {};

  if (!fs.existsSync(skillsDir)) {
    return registry;
  }

  // 2026-08-18 P0: 补 testdraft 草稿过滤(此前 330 个 testdraftskill-* 曾污染注册表)
  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.') && !dirent.name.toLowerCase().includes('testdraft'))
    .map(dirent => dirent.name);

  for (const skillName of skillDirs) {
    const skillPath = path.join(skillsDir, skillName);
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      continue;
    }

    let skill = {
      name: skillName,
      description: '',
      filePath: skillMdPath,
      baseDir: skillPath,
      metadata: {},
      body: '',
      source: source
    };

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);

      skill.name = frontmatter.name || skillName;
      skill.description = frontmatter.description || '';
      skill.body = body.trim();
      skill.metadata = frontmatter.metadata || {};
      skill.version = frontmatter.version || '1.0.0';

      if (!matchesPlatform(frontmatter)) {
        console.log(`⏭️ 技能 [${skill.name}] 不兼容当前平台，跳过加载`);
        continue;
      }
    } catch (e) {
      console.warn(`读取技能 ${skillName} 失败:`, e.message);
      continue;
    }

    const executorPath = path.join(skillPath, 'executor.js');
    skill.hasExecutor = fs.existsSync(executorPath);

    const normalized = skill.name.toLowerCase()
      .replace(/[\s/]+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    registry[normalized] = skill;
  }

  return registry;
}

function load(options = {}) {
  const { force = false } = options;

  const now = Date.now();
  if (!force && _registry && (now - _lastLoadTime) < CACHE_TTL) {
    return _registry;
  }

  console.log('📁 加载技能注册表...');

  console.log(`   内置技能目录: ${SKILLS_DIR}`);
  const builtinRegistry = loadSkillsFromDir(SKILLS_DIR, 'builtin');
  console.log(`   ✅ 内置技能: ${Object.keys(builtinRegistry).length} 个`);

  console.log(`   全局技能目录: ${GLOBAL_SKILLS_DIR}`);
  const globalRegistry = loadSkillsFromDir(GLOBAL_SKILLS_DIR, 'global');
  console.log(`   ✅ 全局技能: ${Object.keys(globalRegistry).length} 个`);

  const conflicts = Object.keys(builtinRegistry).filter(k => globalRegistry[k]);
  if (conflicts.length > 0) {
    console.log(`   ⚠️ 同名技能冲突: ${conflicts.length} 个 (全局版本覆盖内置版本)`);
  }

  const merged = { ...builtinRegistry };
  for (const [key, globalSkill] of Object.entries(globalRegistry)) {
    merged[key] = globalSkill;
  }

  _registry = merged;
  _lastLoadTime = now;

  console.log(`📊 技能注册表加载完成: ${Object.keys(merged).length} 个技能`);

  return merged;
}

function reload() {
  return load({ force: true });
}

function getRegistry() {
  if (!_registry) {
    return load();
  }
  return _registry;
}

function listSkills(options = {}) {
  const registry = getRegistry();
  return listSkillsMetadata(registry, options);
}

function viewSkill(skillName, options = {}) {
  const registry = getRegistry();
  return viewSkillContent(skillName, registry, options);
}

function getCategories() {
  const registry = getRegistry();
  return getSkillCategories(registry);
}

function getSkill(skillName) {
  const registry = getRegistry();
  const normalized = skillName.toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return registry[normalized] || null;
}

function initialize() {
  console.log('🚀 初始化 CrabPaw 技能体系...');

  const registry = load();

  initializeRouter(registry);
  initializeAdapter(registry);
  globalScoringSystem.updateAllScores(registry);

  // Wire: index all skills by capability for TaskFlow resolution
  try {
    const { getCapabilityRegistry } = require('../taskflow/skill-capability-registry');
    const summary = getCapabilityRegistry().initialize(registry);
    if (summary) console.log(`   💡 能力注册表: ${summary.skillCount} 个技能, ${summary.capabilityCount} 种能力`);
  } catch (e) {
    console.warn('[skill-system] CapabilityRegistry init skipped:', e.message);
  }

  const reloader = getHotReloader();
  reloader.onReload((event) => {
    console.log(`🔄 技能热重载触发: ${event.type}`);
    const newRegistry = reload();
    initializeRouter(newRegistry);
    initializeAdapter(newRegistry);
    globalScoringSystem.updateAllScores(newRegistry);
    try {
      const { getCapabilityRegistry } = require('../taskflow/skill-capability-registry');
      getCapabilityRegistry().initialize(newRegistry);
    } catch (e) {
      console.warn('[skill-system] CapabilityRegistry re-index skipped:', e.message);
    }
  });
  reloader.start();

  console.log('✅ CrabPaw 技能体系初始化完成');
  console.log(`   📊 技能评分系统已启动`);
  console.log(`   🔄 技能路由器已初始化`);
  console.log(`   🎯 任务适配器已就绪`);

  // 2026-08-15 P0-2 修复: getSkillRecommender 是 async 工厂(内部 await init()),
  // 此前未 await 直接调 setSkillRegistry → Promise 无此方法 → initialize() 在此
  // 抛 TypeError(推荐器从未接线,也是 initialize 从未被接线成功的直接原因之一)。
  getSkillRecommender().then((recommender) => {
    recommender.setSkillRegistry(registry);
    console.log(`   💡 技能推荐器已激活`);
  }).catch((e) => {
    console.warn('[skill-system] 技能推荐器激活失败:', e.message);
  });

  // Wire event bus — emit skill lifecycle events
  try {
    const eventBus = require('./event-bus');
    eventBus.systemEvent('skills_initialized', { skillCount: Object.keys(registry).length });
  } catch (e) {
    /* event bus optional */
    console.warn('[skill-system.js] 空 catch 补日志:', e && e.message);
  }

}

module.exports = {
  load,
  reload,
  getRegistry,
  listSkills,
  viewSkill,
  getCategories,
  getSkill,
  initialize,
  createSkill,
  editSkill,
  patchSkill,
  deleteSkill,
  writeSkillFile,
  removeSkillFile,
  findSkillPath,
  searchClawHub,
  installFromClawHub,
  installFromGitHub,
  installFromUrl,
  listInstalledSkills,
  uninstallSkill,
  getHotReloader,
  getCurrentPlatform,
  matchesPlatform,
  scanSkillDirectory,
  globalSkillRouter,
  globalScoringSystem,
  globalDependencyManager,
  globalTaskAdapter,
  executeSkill,
  globalExecutorFactory,
  EXECUTOR_TYPE,
  EXECUTOR_STATE,
  getSkillRecommender,
};
