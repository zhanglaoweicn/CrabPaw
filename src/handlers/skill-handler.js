const path = require('path');
const fs = require('fs');
const { formidable } = require('formidable');
const { SkillFlow } = require('../core/skill-flow');
const { GLOBAL_SKILLS_DIR, DATA_DIR, DEFAULT_PORT } = require('../core/config');
const { getSkillLifecycleManager } = require('../core/skill-lifecycle');
const { installPipDeps, installNpmDeps, checkPipDepsInstalled, getSkillLibDir } = require('../core/portable-deps');



const skillFlow = new SkillFlow();

const disabledSkillsPath = path.join(DATA_DIR, 'disabled-skills.json');

function loadDisabledSkills() {
  try {
    if (fs.existsSync(disabledSkillsPath)) {
      return JSON.parse(fs.readFileSync(disabledSkillsPath, 'utf-8'));
    }
  } catch (e) {
    console.warn('读取禁用技能列表失败:', e.message);
  }
  return [];
}

function saveDisabledSkills(disabledList) {
  const dir = path.dirname(disabledSkillsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(disabledSkillsPath, JSON.stringify(disabledList, null, 2));
}

const SKILL_DISPLAY_NAMES = {
  'financial-analyst': { displayName: '📊 财务分析', category: '分析' },
  'summarize-pro': { displayName: '📝 摘要引擎', category: '文本处理' },
  'multi-search-engine': { displayName: '🔍 搜索引擎', category: '搜索' },
  'weather': { displayName: '🌤️ 天气查询', category: '信息查询' },
  'system-info': { displayName: '💻 系统信息', category: '系统' },
  'stock-analyst-enhanced': { displayName: '📈 股票分析', category: '分析' },
  'pdf-generator': { displayName: '📄 PDF生成', category: '文档' },
  'healthcheck': { displayName: '❤️ 健康检查', category: '系统' },
  'prompt-engineering-expert': { displayName: '💡 提示词专家', category: 'AI辅助' },
  'self-improving-agent': { displayName: '🔄 自我改进', category: 'AI辅助' },
  'workflow-designer': { displayName: '🔧 工作流设计', category: '自动化' },
  'agent-team-orchestration': { displayName: '👥 智能体协作', category: '协作' },
  'excel-xlsx': { displayName: '📗 Excel处理', category: '文档' },
  'chart-visualization': { displayName: '📊 图表可视化', category: '可视化' },
  'consulting-analysis': { displayName: '💼 咨询分析', category: '分析' },
  'deep-research': { displayName: '🔬 深度研究', category: '研究' },
  'deep-research-pro': { displayName: '🔬 深度研究Pro', category: '研究' },
  'desktop-control': { displayName: '🖥️ 桌面控制', category: '系统' },
  'flashclaw-stock': { displayName: '📈 股票数据', category: '金融' },
  'frontend-design-ultimate': { displayName: '🎨 前端设计', category: '开发' },
  'markdown-converter': { displayName: '📝 Markdown转换', category: '文档' },
  'pdf-smart-tool-cn': { displayName: '📄 PDF工具', category: '文档' },
  'pptx-generator': { displayName: '📽️ PPT生成', category: '文档' },
  'agent-browser': { displayName: '🌐 浏览器代理', category: '网络' },
  'code-review': { displayName: '🔍 代码审查', category: '开发' },
  'git-ops': { displayName: '🔀 Git操作', category: '开发' },
  'shell-enhance': { displayName: '💻 Shell增强', category: '系统' },
  'image-analyze': { displayName: '🖼 图片分析', category: '媒体' },
  'meeting-summary': { displayName: '📋 会议纪要', category: '效率' },
  'api-tester': { displayName: '🧪 API测试', category: '开发' },
  'knowledge-base': { displayName: '🧠 知识库', category: '效率' },
  'scheduled-task': { displayName: '⏰ 定时任务', category: '自动化' },
  'trending-monitor': { displayName: '📡 趋势监控', category: '信息' },
  'product-research': { displayName: '📦 产品调研', category: '分析' },
  'hot-now': { displayName: '🔥 热点追踪', category: '信息' },
  'image-editor': { displayName: '🎨 图片编辑', category: '媒体' },
  'article-writer': { displayName: '✍️ 文章写作', category: '创作' },
  'content-planner': { displayName: '📅 内容规划', category: '效率' },
  'listing-optimizer': { displayName: '💰 列表优化', category: '营销' },
  'price-monitor': { displayName: '📉 价格监控', category: '分析' },
  'review-analyzer': { displayName: '💬 评论分析', category: '分析' },
  'promo-planner': { displayName: '🎉 促销策划', category: '营销' },
  'email-assistant': { displayName: '📧 邮件助手', category: '效率' },
  'doc-processor': { displayName: '📄 文档处理', category: '文档' },
  'report-generator': { displayName: '📊 报告生成', category: '文档' },
  'file-organizer': { displayName: '🗂 文件整理', category: '系统' },
  'workflow-automator': { displayName: '🤖 工作流自动化', category: '自动化' },
};

function getSkillDisplayName(skillId, skillName, description) {
  const display = SKILL_DISPLAY_NAMES[skillId] || SKILL_DISPLAY_NAMES[skillName];
  if (display) {
    return display;
  }
  
  const nameMatch = description?.match(/^([\p{Emoji}]+)\s*(.+)/u);
  if (nameMatch) {
    return { displayName: nameMatch[1] + ' ' + nameMatch[2].substring(0, 10), category: '其他' };
  }
  
  return { displayName: skillName, category: '其他' };
}

async function handleSkills(req, res, _ctx) {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    // 使用实时技能注册表，确保热重载后数据一致
    const skillSystem = require('../core/skill-system');
    const skillsRegistry = skillSystem.getRegistry() || {}
    const lifecycleManager = getSkillLifecycleManager();

    let flowTools = [];
    try {
      await skillFlow.initialize();
      flowTools = await skillFlow.getFlowsAsTools();
    } catch (e) {
      console.warn('⚠️ 加载工作流失败:', e.message);
    }

    const disabledList = loadDisabledSkills();

    const allSkills = Object.values(skillsRegistry).map(s => {
      const id = s.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
      const displayInfo = getSkillDisplayName(id, s.name, s.description);
      const lifecycleSource = lifecycleManager.getSkillSource(id);
      const lifecycleDetail = lifecycleManager.getSkillDetail(id);

      let depStatus = { hasDependencies: false, pipDeps: [], npmDeps: [], binDeps: [], pipInstalled: false, pipMissing: [], portableDir: '', installable: false };
      try {
        depStatus = getSkillDependencyStatusForApi(s);
      } catch (e) {
        console.warn(`⚠️ 获取技能 ${id} 依赖状态失败:`, e.message);
      }

      return {
        id,
        name: s.name,
        displayName: displayInfo.displayName,
        category: displayInfo.category,
        description: s.description || '',
        version: s.version || s.metadata?.version || '1.0.0',
        source: lifecycleSource !== 'unknown' ? lifecycleSource : (s.source === 'global' ? 'imported' : s.source || 'imported'),
        enabled: s.source === 'builtin' ? true : !disabledList.includes(id),
        hasExecutor: !!(s.baseDir && fs.existsSync(path.join(s.baseDir, 'executor.js'))),
        hasAnalyzer: !!(s.baseDir && fs.existsSync(path.join(s.baseDir, 'analyzer.js'))),
        hasSummarizer: !!(s.baseDir && fs.existsSync(path.join(s.baseDir, 'summarizer.js'))),
        available: s.available !== false,
        missingDeps: s.missingDeps || [],
        dependencies: depStatus,
        lifecycle: lifecycleDetail ? {
          usageCount: lifecycleDetail.usageCount || 0,
          successCount: lifecycleDetail.successCount || 0,
          qualityScore: lifecycleDetail.qualityScore || 0,
          lastUsedAt: lifecycleDetail.lastUsedAt,
          status: lifecycleDetail.status || 'active',
        } : null,
      }
    })

    for (const ft of flowTools) {
      const displayInfo = getSkillDisplayName(ft.name, ft.name, ft.description);
      allSkills.push({
        id: ft.name,
        name: ft.name,
        displayName: displayInfo.displayName,
        category: displayInfo.category,
        description: ft.description,
        version: '1.0.0',
        source: 'flow',
        enabled: !disabledList.includes(ft.name),
        hasExecutor: true,
        hasAnalyzer: false,
        hasSummarizer: false
      })
    }

    const categories = [...new Set(allSkills.map(s => s.category))];
    // 2026-08-26 S3: lifecycleStats 与列表同源——lifecycleManager.getStats() 只统计
    // 走过 executeSkillAdvanced 的技能(未用过的 58 个全 0 → 页面"0 活跃/0 总计"
    // 与列表矛盾)。改为按 allSkills 动态统计(total=注册数/active=启用/bySource=
    // 来源分布), 与列表口径一致; lifecycle 明细保留(usageCount/qualityScore 见于
    // 列表 lifecycle 字段, 无记录则前端显示"从未使用"语义)。
    const regStats = {
      total: allSkills.length,
      active: allSkills.filter(s => s.enabled !== false).length,
      archived: 0,
      bySource: {
        builtin: allSkills.filter(s => s.source === 'builtin').length,
        auto_generated: allSkills.filter(s => s.source === 'auto_generated').length,
        imported: allSkills.filter(s => s.source !== 'builtin' && s.source !== 'auto_generated' && s.source !== 'flow').length,
      },
      autoGeneratedActive: allSkills.filter(s => s.source === 'auto_generated' && s.enabled !== false).length,
      maxAutoGenerated: 100,
      totalGenerated: 0,
      totalArchived: 0,
      totalMerged: 0,
      recentReviews: [],
      mergeCandidates: 0,
    };

    // 2026-08-27 B1-5: 技能整册清单校验(manifest.json 声明 ↔ 目录实况)——顶层附加。
    // 读取失败/校验器异常在 getSkillsManifestCheck 内兜底为通过, 不阻断列表。
    const manifestCheck = getSkillsManifestCheck();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      data: {
        skills: allSkills,
        flowTools,
        categories,
        lifecycleStats: regStats, // 2026-08-26 S3: 与列表同源(原 lifecycleManager 统计恒 0)
        manifestValid: manifestCheck.valid,
        manifestProblems: manifestCheck.problems,
      }
    }));
  } catch (e) {
    console.error('❌ 处理技能请求失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: e.message }));
  }
}

/** 2026-08-27 总览端点配套: 与 handleSkills regStats 同口径的统计(禁用=slug 化 id 命中,
 *  builtin 恒启用, flow 工具计入) */
async function getSkillsOverviewStats() {
  let registry;
  try {
    registry = require('../core/skill-system').getRegistry() || {};
  } catch (e) {
    console.warn('[skills] overview stats: registry 加载失败:', e?.message || e);
    registry = {};
  }
  const disabledList = loadDisabledSkills();
  const disabledSet = new Set(disabledList);
  const entries = Object.values(registry).map(s => {
    const id = s.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-'); // 与 handleSkills 同款 slug 化
    return { enabled: s.source === 'builtin' ? true : !disabledSet.has(id) };
  });
  let flowCount = 0;
  try {
    const { SkillFlow } = require('../core/skill-flow');
    const skillFlow = new SkillFlow();
    await skillFlow.initialize();
    const flowTools = await skillFlow.getFlowsAsTools();
    flowCount = flowTools.length;
    for (const ft of flowTools) entries.push({ enabled: !disabledSet.has(ft.name) });
  } catch (e) {
    console.warn('⚠️ overview stats: 加载工作流失败:', e?.message || e);
  }
  return { total: entries.length, active: entries.filter(en => en.enabled).length, disabled: disabledList.length, flowCount };
}

/**
 * 2026-08-27 B1-5: 技能整册清单校验——validateSkillManifest 语义为"清单声明 ↔ 目录实况"
 * 交叉校验(非 per-skill), 故 /skills 在顶层附加一次 manifestValid/manifestProblems。
 * 读 skills/manifest.json 失败(未声明=自由模式)或校验器异常时视为通过, 仅告警不阻断列表。
 * @returns {{valid: boolean, problems: string[]}}
 */
function getSkillsManifestCheck() {
  try {
    const { loadSkillManifest, validateSkillManifest } = require('../core/skills/manifest-registry');
    const manifest = loadSkillManifest();
    if (!manifest) return { valid: true, problems: [] };
    const result = validateSkillManifest(manifest);
    return { valid: result.valid !== false, problems: Array.isArray(result.problems) ? result.problems : [] };
  } catch (e) {
    console.warn('[skills] 清单校验失败(不阻断):', e?.message || e);
    return { valid: true, problems: [] };
  }
}

async function handleSkillsInstallZip(req, res, _ctx) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  const form = formidable({ maxFileSize: 100 * 1024 * 1024 });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, message: err.message }));
      return;
    }

    const zipFile = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!zipFile) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, message: '没有上传文件' }));
      return;
    }

    try {
      const tempDir = path.join(require('os').tmpdir(), 'crabpaw-skill');
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tempDir, { recursive: true });

      const { safeExtractZip } = require('../core/safe-zip');
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      // 2026-08-29 安全收口: extract-zip 全版本 zip-slip (CWE-22, CVSS 8.1) 无上游
      // 补丁——统一改 safeExtractZip(条目名越界/绝对路径/符号链接整体拒绝+全有或全无;
      // 原 2026-08-07 (M18) 前缀判断补 path.sep 的防线由 helper 内 path.resolve
      // 前缀校验等价覆盖)。
      await safeExtractZip(zipFile.filepath, extractDir);

      const items = fs.readdirSync(extractDir);
      let skillDir = extractDir;

      if (items.length === 1 && fs.statSync(path.join(extractDir, items[0])).isDirectory()) {
        skillDir = path.join(extractDir, items[0]);
      }

      const skillName = path.basename(skillDir);
      const destDir = path.join(GLOBAL_SKILLS_DIR, skillName);

      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }

      fs.renameSync(skillDir, destDir);
      fs.rmSync(tempDir, { recursive: true, force: true });

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, message: '技能安装成功' }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
  });
}

async function handleSkillEvolution(req, res, _ctx) {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  const skills = require('../core/skills.js');
  const evolution = skills.getEvolution();
  const stats = evolution.getStats();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, ...stats }));
}

async function handleSkillDelete(req, res, _ctx) {
  if (req.method !== 'DELETE') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const skillId = url.pathname.replace('/skills/', '');

  const skills = require('../core/skills.js');
  const { builtin, global } = skills.getAllWithSource();

  const isBuiltin = builtin.some(s => s.id === skillId || s.name === skillId);
  if (isBuiltin) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, message: '内置技能无法删除' }));
    return;
  }

  const globalSkill = global.find(s => s.id === skillId || s.name === skillId);
  if (!globalSkill) {
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, message: '技能不存在' }));
    return;
  }

  const skillDir = path.join(GLOBAL_SKILLS_DIR, globalSkill.id || globalSkill.name);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    console.log(`🗑️ 已删除技能: ${skillId}`);
  }

  const disabledList = loadDisabledSkills();
  const newDisabledList = disabledList.filter(id => id !== skillId);
  saveDisabledSkills(newDisabledList);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: '技能已删除' }));
}

// 2026-08-05: SkillComposer 管道直连执行——POST /api/skills/run { name, input }
// 内部走 executeSkillAdvanced（与 LLM 工具调用同款），自动广播 skill:started/completed
// 触发前端 SkillStageHost 全息卡；管道由前端依次调用本端点完成。
async function handleSkillExecute(req, res, _ctx) {
  const { readJsonBody } = require('./http-utils');
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }
  try {
    const body = await readJsonBody(req);
    const name = body && body.name;
    if (!name) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '缺少技能名 name' }));
      return;
    }
    const skills = require('../core/skills.js');
    const result = await skills.executeSkillAdvanced(String(name), (body && body.input) || {});
    // 2026-08-18 P1: 透传 result.success 而非恒包 {success:true}(禁用/执行失败此前被吞)
    const ok = result && result.success !== false;
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: ok, skill: String(name), result }));
  } catch (e) {
    console.error('[skills] 执行技能失败:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
}

async function handleSkillToggle(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');
  
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const skillId = url.pathname.replace('/skills/', '');

  try {
    const data = await readJsonBody(req);
    const enabled = data.enabled;

    const disabledList = loadDisabledSkills();

    if (enabled) {
      const newDisabledList = disabledList.filter(id => id !== skillId);
      saveDisabledSkills(newDisabledList);
      console.log(`✅ 已启用技能: ${skillId}`);
    } else {
      if (!disabledList.includes(skillId)) {
        disabledList.push(skillId);
        saveDisabledSkills(disabledList);
      }
      console.log(`🚫 已禁用技能: ${skillId}`);
    }

    return sendJson(res, 200, { success: true, enabled });
  } catch (e) {
    return sendError(res, 400, e.message);
  }
}

function getSkillDependencyStatusForApi(skill) {
  const skillId = skill.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const deps = skill.metadata?.crabpaw?.requires || skill.metadata?.openclaw?.requires || skill.metadata?.requires || {};

  const parseInlineArray = (str) => {
    if (!str || !str.trim().startsWith('[')) return [];
    try { const p = JSON.parse(str); return Array.isArray(p) ? p : []; } catch { return []; }
  };

  const bins = Array.isArray(deps.bins) ? deps.bins : (typeof deps.bins === 'string' ? parseInlineArray(deps.bins) : []);
  const npmPkgs = Array.isArray(deps.npm) ? deps.npm : [];
  const pythonPkgs = Array.isArray(deps.pip || deps.core) ? (deps.pip || deps.core) : [];

  const hasPipDeps = pythonPkgs.length > 0;
  const hasNpmDeps = npmPkgs.length > 0;
  const hasBinDeps = bins.length > 0;

  let pipInstalled = false;
  let pipMissing = [];
  if (hasPipDeps) {
    const check = checkPipDepsInstalled(skillId, pythonPkgs);
    pipInstalled = check.installed;
    pipMissing = check.missing || [];
  }

  return {
    hasDependencies: hasPipDeps || hasNpmDeps || hasBinDeps,
    pipDeps: pythonPkgs,
    npmDeps: npmPkgs,
    binDeps: bins,
    pipInstalled,
    pipMissing,
    portableDir: getSkillLibDir(skillId),
    installable: hasPipDeps || hasNpmDeps,
  };
}

async function handleSkillInstallDeps(req, res, ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const data = await readJsonBody(req);
    const skillId = data.skillId;

    if (!skillId) {
      return sendError(res, 400, '缺少 skillId 参数');
    }

    const skillsRegistry = ctx.skillsRegistry || {};
    const skill = Object.values(skillsRegistry).find(s => {
      const id = s.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      return id === skillId;
    });

    if (!skill) {
      return sendError(res, 404, `技能 ${skillId} 不存在`);
    }

    const deps = skill.metadata?.crabpaw?.requires || skill.metadata?.openclaw?.requires || skill.metadata?.requires || {};
    const pythonPkgs = Array.isArray(deps.pip || deps.core) ? (deps.pip || deps.core) : [];
    const npmPkgs = Array.isArray(deps.npm) ? deps.npm : [];

    const results = { pip: null, npm: null };

    if (pythonPkgs.length > 0) {
      results.pip = await installPipDeps(skillId, pythonPkgs);
    }

    if (npmPkgs.length > 0) {
      results.npm = await installNpmDeps(skillId, npmPkgs);
    }

    if (!pythonPkgs.length && !npmPkgs.length) {
      return sendJson(res, 200, {
        success: true,
        message: `技能 ${skillId} 无需安装额外依赖`,
        results,
      });
    }

    const messages = [];
    if (results.pip) {
      if (results.pip.success) {
        messages.push(`✅ Python 依赖已安装到便携式目录: ${pythonPkgs.join(', ')}`);
      } else if (results.pip.skipped) {
        messages.push(`⏭️ 无 Python 依赖需要安装`);
      } else {
        messages.push(`❌ Python 依赖安装失败: ${results.pip.error}`);
        if (results.pip.hint) {
          messages.push(`💡 手动安装: ${results.pip.hint}`);
        }
      }
    }
    if (results.npm) {
      if (results.npm.success) {
        messages.push(`✅ Node.js 依赖已安装: ${npmPkgs.join(', ')}`);
      } else {
        messages.push(`❌ Node.js 依赖安装失败: ${results.npm.error}`);
      }
    }

    return sendJson(res, 200, {
      success: results.pip?.success !== false && results.npm?.success !== false,
      message: messages.join('\n'),
      results,
    });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillDepStatus(req, res, ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const skillId = url.searchParams.get('skillId');

    if (!skillId) {
      return sendError(res, 400, '缺少 skillId 参数');
    }

    const skillsRegistry = ctx.skillsRegistry || {};
    const skill = Object.values(skillsRegistry).find(s => {
      const id = s.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      return id === skillId;
    });

    if (!skill) {
      return sendError(res, 404, `技能 ${skillId} 不存在`);
    }

    const depStatus = getSkillDependencyStatusForApi(skill);

    return sendJson(res, 200, {
      success: true,
      skillId,
      dependencies: depStatus,
    });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillMarketSearch(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const query = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const skillMarket = require('../core/skill-market');
    const result = await skillMarket.searchSkills(query, { limit });

    return sendJson(res, 200, result);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillMarketInstall(req, res, ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  // 2026-08-28 发布项: 远程技能安装默认关闭——技能=完全信任域(等同本机用户权限,
  // 发布口径红线)。registry/GitHub/URL 三源统一拒装, GUI 设置→安全→远程技能安装开启后放行。
  const remoteInstall = ctx?.appConfig?.security?.remoteInstall;
  if (!remoteInstall || remoteInstall.enabled !== true) {
    return sendError(res, 403, '远程技能安装默认关闭（安装的技能等同本机用户权限）。如确认来源可信，可在 设置 → 安全 → 远程技能安装 中开启。');
  }

  try {
    const data = await readJsonBody(req);
    const { source, skillSlug, repo, url, force = false } = data;

    const skillMarket = require('../core/skill-market');
    let result;

    if (source === 'remote' && skillSlug) {
      const registryUrl = process.env.CRABPAW_SKILL_REGISTRY || '';
      if (!registryUrl) {
        return sendError(res, 400, '未配置 CRABPAW_SKILL_REGISTRY');
      }
      // 发布 S-2a: remote 源改走 installFromRegistry——env 配置的 registry 是管理员可信源,
      // 不走 installFromUrl 的 SSRF 目标校验（本地/内网 registry 合法场景保留）。
      result = await skillMarket.installFromRegistry(skillSlug, { force });
    } else if (source === 'github' && repo) {
      result = await skillMarket.installFromGitHub(repo, { force });
    } else if (source === 'url' && url) {
      result = await skillMarket.installFromUrl(url, { skillName: skillSlug, force });
    } else {
      return sendError(res, 400, '缺少必要参数: source + skillSlug/repo/url');
    }

    if (result.success) {
      const skills = require('../core/skills.js');
      skills.reload();
    }

    return sendJson(res, 200, result);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillMarketList(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const skillMarket = require('../core/skill-market');
    const installed = skillMarket.listInstalledSkills();

    return sendJson(res, 200, {
      success: true,
      installed,
      count: installed.length
    });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillMarketStatus(req, res, _ctx) {
  const { sendJson } = require('./http-utils');
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }
  try {
    const skillMarket = require('../core/skill-market');
    const status = skillMarket.getMarketStatus();
    return sendJson(res, 200, { success: true, ...status });
  } catch (e) {
    return sendJson(res, 200, { success: true, registryUrl: '', availableRemote: false, installedCount: 0 });
  }
}

async function handleSkillReview(req, res, ctx) {
  const { sendJson, sendError } = require('./http-utils');
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body || '{}');
    const { runReview, getStatus } = require('../core/learning/post-turn-review');
    if (data.action === 'status') {
      return sendJson(res, 200, { success: true, status: getStatus() });
    }
    if (data.action === 'run' && ctx.ai) {
      const result = await runReview({
        conversationSummary: data.summary || '(手动触发)',
        toolCallCount: data.toolCalls || 0,
        ai: ctx.ai,
      });
      return sendJson(res, 200, { success: true, result });
    }
    return sendJson(res, 200, { success: true, status: getStatus() });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillCreate(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const data = await readJsonBody(req);
    const { name, description, category = 'general' } = data;

    if (!name || !description) {
      return sendError(res, 400, '缺少必要参数: name, description');
    }

    // 先用模板创建技能骨架
    const skillSystem = require('../core/skill-system');
    const result = skillSystem.createSkill({ name, description, category });

    if (!result.success) {
      return sendJson(res, 200, result);
    }

    // 尝试用 LLM 生成更丰富的技能内容
    try {
      const { getProviderRegistry } = require('../core/llm');
      const registry = getProviderRegistry();
      if (registry) {
        const llmResult = await registry.chat({
          messages: [
            { role: 'system', content: '你是一个技能生成专家。根据用户提供的技能名称和描述，生成一个完整的 SKILL.md 文件内容。要求：\n1. 使用 YAML frontmatter 格式（name, version, description, metadata）\n2. 包含功能说明、使用方式、注意事项等章节\n3. 内容要详细、实用、专业\n4. 用中文回答\n5. 只输出 SKILL.md 内容，不要多余的解释' },
            { role: 'user', content: '技能名称: ' + name + '\n描述: ' + description + '\n分类: ' + category + '\n\n请生成完整的 SKILL.md 内容。' }
          ],
          maxTokens: 4000,
          temperature: 0.7,
        });
        if (llmResult && llmResult.content) {
          const fs = require('fs');
          const skillMdPath = require('path').join(result.skillPath, 'SKILL.md');
          fs.writeFileSync(skillMdPath, llmResult.content, 'utf-8');
          console.log('✅ AI 已为技能 "' + name + '" 生成内容');
          result.aiGenerated = true;
        }
      }
    } catch (llmErr) {
      console.warn('⚠️ LLM 技能生成失败，使用默认模板:', llmErr.message);
    }

    // 重新加载技能注册表
    try {
      const skills = require('../core/skills.js');
      skills.reload();
    } catch (_) { console.warn('[skill-handler] 重新加载技能注册表失败:', _.message); }

    return sendJson(res, 200, result);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleSkillEdit(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const data = await readJsonBody(req);
    const { name, updates } = data;

    if (!name || !updates) {
      return sendError(res, 400, '缺少必要参数: name, updates');
    }

    const skillSystem = require('../core/skill-system');
    const result = skillSystem.editSkill(name, updates);

    return sendJson(res, 200, result);
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

/**
 * 获取技能进化状态
 */
async function handleSkillEvolutionStatus(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const status = { available: false, engines: [], config: {} };

    // 尝试获取进化系统状态
    try {
      const { getEvolutionSystemStatus } = require('../core/evolution-system');
      const evoStatus = await getEvolutionSystemStatus();
      status.available = true;
      status.engines = evoStatus.coordinator?.engines || [];
      status.config = evoStatus.config || {};
      status.isRunning = evoStatus.isRunning || false;
    } catch {
      // 进化系统未初始化，尝试获取 SkillEvolver 状态
      try {
        const { getSkillEvolver } = require('../core/skill/skill-evolver');
        const evolver = getSkillEvolver();
        const stats = evolver.getStats();
        status.available = true;
        status.evolverStats = stats;
      } catch {
        console.warn('[skill-handler.js] skill evolver stats unavailable');
      }
    }

    // 获取进化图谱统计
    try {
      const { getStats } = require('../core/skill/skill-evolution-graph');
      status.graphStats = getStats();
    } catch {
      console.warn('[skill-handler.js] skill evolution graph stats unavailable');
    }

    return sendJson(res, 200, { success: true, status });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

/**
 * 手动触发技能进化
 */
async function handleSkillEvolutionTrigger(req, res, _ctx) {
  // eslint-disable-next-line no-unused-vars
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    let result;

    // 尝试通过进化系统触发
    try {
      const { triggerEvolution } = require('../core/evolution-system');
      result = await triggerEvolution();
    } catch {
      // 降级：直接调用 SkillEvolutionEngine
      try {
        const { getSkillEvolutionEngine } = require('../core/evolution/skill-evolution');
        const engine = await getSkillEvolutionEngine();
        result = await engine.evolve();
      } catch (err2) {
        return sendError(res, 500, '进化引擎不可用: ' + err2.message);
      }
    }

    return sendJson(res, 200, { success: true, result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

/**
 * 获取技能进化历史
 */
async function handleSkillEvolutionHistory(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const skillName = url.searchParams.get('skill');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    const history = { evolverHistory: [], engineHistory: [] };

    // SkillEvolver 历史
    try {
      const { getSkillEvolver } = require('../core/skill/skill-evolver');
      const evolver = getSkillEvolver();
      history.evolverHistory = evolver.getHistory(skillName, limit);
    } catch {
      console.warn('[skill-handler.js] skill evolver history unavailable');
    }

    // SkillEvolutionEngine 历史
    try {
      const { getSkillEvolutionEngine } = require('../core/evolution/skill-evolution');
      const engine = await getSkillEvolutionEngine();
      const report = engine.getSkillReport();
      history.engineHistory = report.recentEvolutions || [];
    } catch {
      console.warn('[skill-handler.js] skill evolution engine history unavailable');
    }

    return sendJson(res, 200, { success: true, history });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

/**
 * 获取技能进化图谱
 */
async function handleSkillEvolutionGraph(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const skillName = url.searchParams.get('skill');
    const format = url.searchParams.get('format') || 'json';

    const result = {};

    if (skillName) {
      // 获取特定技能的进化谱系
      try {
        const { getLineage } = require('../core/skill/skill-evolution-graph');
        result.lineage = getLineage(skillName);
      } catch {
        console.warn('[skill-handler.js] skill lineage unavailable');
      }
    }

    // 获取进化推荐
    try {
      const { getEvolutionRecommendations } = require('../core/skill/skill-evolution-graph');
      result.recommendations = getEvolutionRecommendations();
    } catch {
      console.warn('[skill-handler.js] evolution recommendations unavailable');
    }

    // 获取图谱统计
    try {
      const { getStats } = require('../core/skill/skill-evolution-graph');
      result.stats = getStats();
    } catch {
      console.warn('[skill-handler.js] evolution graph stats unavailable');
    }

    // Mermaid 格式
    if (format === 'mermaid') {
      try {
        const { toMermaid } = require('../core/skill/skill-evolution-graph');
        result.mermaid = toMermaid();
      } catch {
        console.warn('[skill-handler.js] mermaid conversion unavailable');
      }
    }

    return sendJson(res, 200, { success: true, graph: result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

/**
 * 回滚指定进化记录
 */
async function handleSkillEvolutionRollback(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ success: false, message: 'Method Not Allowed' }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const skillName = body.skillName || '';
    if (!skillName) {
      return sendError(res, 400, '缺少 skillName 参数');
    }

    try {
      const { getRollbackManager } = require('../core/evolution/rollback-manager');
      const rollbackMgr = getRollbackManager();
      rollbackMgr.initialize();
      const record = await rollbackMgr.rollback(skillName, { newVersion: 'latest' }, { reason: 'manual_rollback', action: 'rollback' });
      return sendJson(res, 200, { success: record.success, message: record.success ? '回滚成功' : (record.error || '回滚失败') });
    } catch (e) {
      return sendError(res, 500, '回滚失败: ' + e.message);
    }
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

module.exports = {
  handleSkills,
  getSkillsOverviewStats,
  getSkillsManifestCheck,
  handleSkillsInstallZip,
  handleSkillEvolution,
  handleSkillDelete,
  handleSkillToggle,
  handleSkillExecute,
  handleSkillInstallDeps,
  handleSkillDepStatus,
  handleSkillMarketSearch,
  handleSkillMarketInstall,
  handleSkillMarketList,
  handleSkillCreate,
  handleSkillEdit,
  handleSkillEvolutionStatus,
  handleSkillEvolutionTrigger,
  handleSkillEvolutionHistory,
  handleSkillEvolutionGraph,
  handleSkillMarketStatus,
  handleSkillReview,
  handleSkillEvolutionRollback,
};
