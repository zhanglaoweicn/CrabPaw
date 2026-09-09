const fs = require('fs').promises;
const path = require('path');
const { GLOBAL_SKILLS_DIR } = require('./config');
const { getSkillLifecycleManager } = require('./skill-lifecycle');
const {
  installPipDeps,
  installNpmDeps,
  checkPipDepsInstalled, // eslint-disable-line no-unused-vars
  generatePipInstallCommand,
  generateExecutorEnvSetup,
  generatePythonEnvSetup, // eslint-disable-line no-unused-vars
  getSkillLibDir, // eslint-disable-line no-unused-vars
} = require('./portable-deps');

function getSkillsDir() {
  return GLOBAL_SKILLS_DIR;
}

// 2026-08-18 P0: 草稿隔离目录——生成技能先落此(data/skills/.drafts/),
// loadSkillsFromDir(隐藏目录过滤)与 skill-hot-reload(路径含 .drafts 跳过)均不收录,
// 防止 testdraftskill-* 再次污染注册表。正式发布需人工移到根目录。
const DRAFT_SKILLS_DIR = '.drafts';

const SKILL_TEMPLATE = `---
name: {skillName}
version: 1.0.0
description: "{description}"
author: AI Generated
created: {createdAt}
metadata:
  auto_generated: true
  generated_from: "{userPrompt}"
  confidence: {confidence}
  requires:
    bins: [{bins}]
    pip: [{pipDeps}]
    npm: [{npmDeps}]
    portable_deps: true
---

# {displayName}

{skillDescription}

## 功能说明

{functionality}

## 依赖安装

{dependencies}

## 使用方式

\`\`\`
在对话中提及相关关键词即可触发此技能
\`\`\`

## 注意事项

- 此技能由 AI 自动生成，可能需要进一步优化
- 如有问题，请在技能管理页面编辑或删除
- Python 依赖已安装到便携式目录，跟随移动硬盘

## 生成历史

- {createdAt}: 初始版本，基于用户需求「{userPrompt}」生成
`;

const EXECUTOR_TEMPLATE = `/**
 * {displayName} 执行器
 * 自动生成时间: {createdAt}
 * 依赖: {dependencies}
 * 便携式依赖: {portableInfo}
 */

{envSetup}

async function execute(context) {
  const { input, tools, logger } = context;
  
  try {
    logger.info('开始执行 {skillName} 技能');
    
    // 依赖检查
    {dependencyCheck}
    
    // [待实现] 具体的业务逻辑
    // 这是一个自动生成的模板，需要根据实际需求进行修改
    
    const result = {
      success: true,
      data: input,
      message: '{skillName} 执行完成'
    };
    
    logger.info('{skillName} 执行成功');
    return result;
    
  } catch (error) {
    logger.error('{skillName} 执行失败:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = { execute };
`;

const DANGEROUS_PATTERNS = [
  /eval\s*\(/gi,
  /Function\s*\(/gi,
  /child_process/gi,
  /exec\s*\(/gi,
  /spawn\s*\(/gi,
  /require\s*\(\s*['"]child_process['"]\s*\)/gi,
  /process\.exit/gi,
  /fs\.unlink/gi,
  /fs\.rmdir/gi,
  /\.destroy\(\)/gi,
  /delete\s+process\.env/gi,
  /__proto__/gi,
  /prototype\s*\[/gi
];

async function generateSkill(userPrompt, aiAnalysis) {
  const skillsDir = await getSkillsDir();
  const skillId = generateSkillId(aiAnalysis.skillName);
  // 2026-08-18 P0: 草稿写入隔离目录 .drafts/,不再直接写 data/skills 根目录
  const skillDir = path.join(skillsDir, DRAFT_SKILLS_DIR, skillId);
  
  const bins = aiAnalysis.bins || [];
  const pipDeps = aiAnalysis.pipDeps || [];
  const npmDeps = aiAnalysis.npmDeps || [];
  
  const dependenciesText = generateDependenciesText(skillId, bins, pipDeps, npmDeps);
  const dependencyCheckCode = generateDependencyCheckCode(skillId, bins, pipDeps, npmDeps);
  const envSetup = generateExecutorEnvSetup(skillId);
  
  let installResult = { pip: null, npm: null };
  
  if (pipDeps.length > 0) {
    installResult.pip = await installPipDeps(skillId, pipDeps);
  }
  
  if (npmDeps.length > 0) {
    installResult.npm = await installNpmDeps(skillId, npmDeps);
  }
  
  try {
    await fs.mkdir(skillDir, { recursive: true });
    
    const skillContent = SKILL_TEMPLATE
      .replace(/{skillName}/g, skillId)
      .replace(/{displayName}/g, aiAnalysis.displayName)
      .replace(/{description}/g, aiAnalysis.description)
      .replace(/{skillDescription}/g, aiAnalysis.skillDescription || aiAnalysis.description)
      .replace(/{functionality}/g, aiAnalysis.functionality || '待补充')
      .replace(/{userPrompt}/g, userPrompt.replace(/"/g, '\\"'))
      .replace(/{createdAt}/g, new Date().toISOString())
      .replace(/{confidence}/g, aiAnalysis.confidence || 0.5)
      .replace(/{bins}/g, bins.map(b => `"${b}"`).join(', '))
      .replace(/{pipDeps}/g, pipDeps.map(p => `"${p}"`).join(', '))
      .replace(/{npmDeps}/g, npmDeps.map(n => `"${n}"`).join(', '))
      .replace(/{dependencies}/g, dependenciesText);
    
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      skillContent,
      'utf-8'
    );
    
    if (aiAnalysis.needsExecutor) {
      const portableInfo = pipDeps.length > 0
        ? `portable/libs/${skillId}`
        : 'none';

      const executorContent = EXECUTOR_TEMPLATE
        .replace(/{displayName}/g, aiAnalysis.displayName)
        .replace(/{skillName}/g, skillId)
        .replace(/{createdAt}/g, new Date().toISOString())
        .replace(/{dependencies}/g, dependenciesText)
        .replace(/{portableInfo}/g, portableInfo)
        .replace(/{envSetup}/g, envSetup)
        .replace(/{dependencyCheck}/g, dependencyCheckCode);

      await fs.writeFile(
        path.join(skillDir, 'executor.js'),
        executorContent,
        'utf-8'
      );

      // ── 三阶段质量门禁（不阻止返回，仅标记 draft） ──
      var qualityResult = await _qualityGate(skillDir, skillId, executorContent);
    }

    return {
      success: true,
      skillId,
      skillDir,
      quality: (!aiAnalysis.needsExecutor || (qualityResult && qualityResult.passed)) ? 'production' : 'draft',
      qualityDetails: qualityResult || null,
      message: `技能「${aiAnalysis.displayName}」已生成` + ((qualityResult && !qualityResult.passed) ? '（⚠ 质量门禁未通过，标记为 draft）' : ''),
      dependencies: { bins, pipDeps, npmDeps },
      installResult,
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

function generateDependenciesText(skillId, bins, pipDeps, npmDeps) {
  const lines = [];
  
  if (bins.length > 0) {
    lines.push('### 必需工具');
    bins.forEach(bin => {
      lines.push(`- \`${bin}\``);
    });
    lines.push('');
  }
  
  if (pipDeps.length > 0) {
    lines.push('### Python 依赖（便携式安装）');
    lines.push('依赖将自动安装到项目便携式目录，跟随移动硬盘：');
    lines.push('```bash');
    lines.push(generatePipInstallCommand(skillId, pipDeps));
    lines.push('```');
    lines.push('');
    lines.push('> 💡 依赖安装在 `portable/libs/' + skillId + '/` 目录，更换电脑无需重新安装');
    lines.push('');
  }
  
  if (npmDeps.length > 0) {
    lines.push('### Node.js 依赖');
    lines.push('```bash');
    lines.push(`npm install ${npmDeps.join(' ')}`);
    lines.push('```');
    lines.push('');
  }
  
  if (lines.length === 0) {
    lines.push('无额外依赖');
  }
  
  return lines.join('\n');
}

function generateDependencyCheckCode(skillId, bins, pipDeps, npmDeps) {
  const checks = [];
  
  if (pipDeps.length > 0) {
    checks.push('// 检查便携式 Python 依赖');
    checks.push('const depCheck = (() => {');
    checks.push('  try {');
    checks.push('    const fs = require("fs");');
    checks.push('    const path = require("path");');
    checks.push('    const markerFile = path.join(__dirname, "..", "..", "..", "portable", "libs", "' + skillId + '", ".crabpaw-deps.json");');
    checks.push('    return fs.existsSync(markerFile);');
    checks.push('  } catch(e) { return false; }');
    checks.push('})();');
    checks.push('if (!depCheck) {');
    checks.push('  return {');
    checks.push('    success: false,');
    checks.push(`    error: '缺少 Python 依赖，请在技能管理页面点击安装，或手动运行: ${generatePipInstallCommand(skillId, pipDeps)}'`);
    checks.push('  };');
    checks.push('}');
  }
  
  if (bins.length > 0) {
    checks.push('// 检查必需工具');
    bins.forEach(bin => {
      checks.push(`// TODO: 检查 ${bin} 是否安装`);
    });
  }
  
  if (npmDeps.length > 0) {
    checks.push('// 检查 Node.js 依赖');
    npmDeps.forEach(dep => {
      checks.push(`// [待检查] ${dep} 是否安装`);
    });
  }
  
  return checks.length > 0 ? checks.join('\n    ') : '// 无需依赖检查';
}

function generateSkillId(displayName) {
  const timestamp = Date.now();
  const sanitized = displayName
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 30);
  
  return `${sanitized}-${timestamp}`;
}

function scanSkillSecurity(skillContent) {
  const findings = [];
  
  for (const pattern of DANGEROUS_PATTERNS) {
    const matches = skillContent.match(pattern);
    if (matches) {
      findings.push({
        level: 'dangerous',
        pattern: pattern.source,
        matches: matches.length,
        message: `发现危险模式: ${pattern.source}`
      });
    }
  }
  
  return {
    safe: findings.length === 0,
    findings
  };
}

async function analyzeAndGenerateSkill(userPrompt, context) {
  // eslint-disable-next-line no-unused-vars
  const { ai, tools } = context;
  const lifecycleManager = getSkillLifecycleManager();
  
  const analysisPrompt = `分析以下用户需求，判断是否需要创建新技能：

用户需求：${userPrompt}

请以 JSON 格式返回分析结果：
{
  "needsNewSkill": true/false,
  "skillName": "技能ID（英文，小写，用连字符分隔）",
  "displayName": "技能显示名称（中文）",
  "description": "技能描述（一句话）",
  "skillDescription": "详细描述（多行）",
  "functionality": "功能说明",
  "keywords": ["关键词1", "关键词2"],
  "needsExecutor": true/false,
  "confidence": 0.0-1.0,
  "reason": "判断理由",
  "bins": ["必需工具1", "必需工具2"],
  "pipDeps": ["python包1", "python包2>=1.0.0"],
  "npmDeps": ["npm包1", "npm包2"]
}

判断标准：
1. 如果需求可以通过现有工具（如搜索、文件操作）完成，needsNewSkill = false
2. 如果需求是特定领域的复杂任务，needsNewSkill = true
3. 如果需求需要自定义业务逻辑，needsNewSkill = true
4. confidence 表示对判断的信心程度
5. bins 是必需的命令行工具（如 python, node, ffmpeg）
6. pipDeps 是 Python 依赖（如 numpy, pandas>=1.0.0）
7. npmDeps 是 Node.js 依赖（如 axios, lodash）
8. 优先使用纯 Node.js 方案，减少 Python 依赖，提升便携性`;

  try {
    const aiResponse = await ai.chat(analysisPrompt, {
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const { extractJsonFromLLMResponse } = require('./skill/frontmatter-parser');
    const analysis = extractJsonFromLLMResponse(aiResponse.content);
    if (!analysis) {
      return {
        success: false,
        code: 'LLM_PARSE_ERROR',
        reason: '无法从 AI 响应中解析 JSON',
        rawResponse: aiResponse.content?.slice(0, 500),
      };
    }

    if (!analysis.needsNewSkill) {
      return {
        success: false,
        code: 'ANALYSIS_NOT_NEEDED',
        reason: analysis.reason || '现有工具可以满足需求',
        suggestions: ['可以尝试使用现有的工具组合完成任务']
      };
    }

    const existingSkills = context.skillsRegistry
      ? Object.values(context.skillsRegistry).map(s => ({
          name: s.name,
          description: s.description || ''
        }))
      : [];

    const lifecycleCheck = await lifecycleManager.checkBeforeGenerate(
      analysis.skillName,
      analysis.description,
      existingSkills
    );

    if (!lifecycleCheck.canGenerate) {
      return {
        success: false,
        code: 'LIFECYCLE_BLOCKED',
        reason: lifecycleCheck.reason,
        existingSkills: existingSkills.map(s => s.name),
        suggestions: lifecycleCheck.similarSkill
          ? [`可以使用已有技能「${lifecycleCheck.similarSkill.name}」（请先调用 skill_manage(view) 确认该技能是否含有 executor.js）`]
          : ['请先清理不常用的自生成技能']
      };
    }
    
    const result = await generateSkill(userPrompt, analysis);
    
    if (result.success) {
      lifecycleManager.recordSkillGenerated(result.skillId, {
        name: analysis.displayName,
        description: analysis.description,
        generatedFrom: userPrompt,
        dependencies: result.dependencies,
      });
      
      const depMsg = _formatInstallResult(result.installResult, result.dependencies);
      
      return {
        success: true,
        skillId: result.skillId,
        displayName: analysis.displayName,
        message: result.message,
        analysis,
        dependencies: result.dependencies,
        installResult: result.installResult,
        depMsg,
      };
    } else {
      return {
        success: false,
        code: 'GENERATION_FAILED',
        error: result.error,
        reason: result.error
      };
    }

  } catch (error) {
    return {
      success: false,
      code: 'THROWN_EXCEPTION',
      error: error.message,
      reason: error.message
    };
  }
}

function _formatInstallResult(installResult, _dependencies) {
  const parts = [];
  
  if (installResult.pip && !installResult.pip.skipped) {
    if (installResult.pip.success) {
      parts.push(`✅ Python 依赖已安装到便携式目录 (${installResult.pip.libDir})`);
    } else {
      parts.push(`⚠️ Python 依赖自动安装失败，请手动执行:\n${installResult.pip.hint}`);
    }
  }
  
  if (installResult.npm && !installResult.npm.skipped) {
    if (installResult.npm.success) {
      parts.push(`✅ Node.js 依赖已安装`);
    } else {
      parts.push(`⚠️ Node.js 依赖自动安装失败，请手动执行:\n${installResult.npm.hint}`);
    }
  }
  
  return parts.length > 0 ? parts.join('\n') : '';
}

async function updateSkillFromFeedback(skillId, feedback, context) {
  const skillsDir = await getSkillsDir();
  // 2026-08-18 P0: 反馈更新先查正式目录;生成草稿在隔离目录 .drafts/,也支持更新
  let skillFile = path.join(skillsDir, skillId, 'SKILL.md');
  try {
    await fs.access(skillFile);
  } catch (_) {
    const draftFile = path.join(skillsDir, DRAFT_SKILLS_DIR, skillId, 'SKILL.md');
    try { await fs.access(draftFile); skillFile = draftFile; } catch (_) { /* 保持原报错路径 */ }
  }
  
  try {
    let content = await fs.readFile(skillFile, 'utf-8');
    
    const updatePrompt = `根据用户反馈优化技能描述：

当前技能内容：
${content}

用户反馈：
${feedback}

请返回优化后的完整 SKILL.md 内容（保持 YAML frontmatter 格式）：`;
    
    const aiResponse = await context.ai.chat(updatePrompt);
    const optimizedContent = aiResponse.content;
    
    const securityScan = scanSkillSecurity(optimizedContent);
    if (!securityScan.safe) {
      return {
        success: false,
        error: '安全扫描未通过',
        findings: securityScan.findings
      };
    }
    
    await fs.writeFile(skillFile, optimizedContent, 'utf-8');
    
    return {
      success: true,
      message: `技能「${skillId}」已更新`
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 三阶段质量门禁
 *
 * 阶段1：静态分析 — 检测 [待实现] 注释、空函数体、TODO 占位符
 * 阶段2：参数校验 — 用测试输入调执行器的 execute 函数
 * 阶段3：结果模式验证 — 验证返回值含 success 字段
 *
 * 门禁失败不阻止返回，仅标记 quality: 'draft' + 警告日志
 */
async function _qualityGate(skillDir, skillId, executorContent) {
  const issues = [];

  // ── 阶段1：静态分析 ──
  const staticIssues = _staticAnalysis(executorContent);
  issues.push(...staticIssues);

  // ── 阶段2：参数校验（运行 execute） ──
  let executeResult = null;
  const executorPath = path.join(skillDir, 'executor.js');
  try {
    // 清除 require 缓存以便加载新生成的文件
    delete require.cache[require.resolve(executorPath)];
    const executor = require(executorPath);
    if (typeof executor.execute === 'function') {
      executeResult = await executor.execute({ action: 'test', input: 'quality-gate-probe' });
    } else {
      issues.push({ stage: 'param_validation', message: 'executor 未导出 execute 函数' });
    }
  } catch (e) {
    issues.push({ stage: 'param_validation', message: `运行时错误: ${e.message}` });
  }

  // ── 阶段3：结果模式验证 ──
  if (executeResult !== null) {
    if (typeof executeResult !== 'object') {
      issues.push({ stage: 'result_pattern', message: 'execute 返回值不是对象' });
    } else if (!('success' in executeResult)) {
      issues.push({ stage: 'result_pattern', message: 'execute 返回值缺少 success 字段' });
    }
  }

  const passed = issues.length === 0;

  if (!passed) {
    console.warn(`[skill-generator] ⚠ 技能 "${skillId}" 质量门禁未通过 (draft)：`);
    issues.forEach(i => console.warn(`  [${i.stage}] ${i.message}`));
  }

  return { passed, issues };
}

/**
 * 静态分析：检测模板占位符和空实现
 */
function _staticAnalysis(source) {
  const issues = [];

  // 检测 [待实现] 注释（中英文变体）
  if (/\[待实现\]/i.test(source) || /\[TODO\]/i.test(source) || /\[待检查\]/i.test(source)) {
    issues.push({ stage: 'static_analysis', message: '代码中包含 [待实现]/[TODO] 占位注释' });
  }

  // 检测空函数体（async function xxx(...) { } 只有空白/注释）
  const funcBodies = source.match(/async\s+function\s+\w+\s*\([^)]*\)\s*\{([^}]*)\}/g) || [];
  for (const body of funcBodies) {
    // 提取花括号内容
    const inner = body.replace(/async\s+function\s+\w+\s*\([^)]*\)\s*\{/, '').replace(/\}$/, '');
    // 移除注释和空白后为空
    const stripped = inner
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (stripped === '' || stripped === '// 无需依赖检查') {
      issues.push({ stage: 'static_analysis', message: '检测到空函数体（无业务逻辑）' });
      break; // 只报一次
    }
  }

  return issues;
}

module.exports = {
  generateSkill,
  analyzeAndGenerateSkill,
  updateSkillFromFeedback,
  scanSkillSecurity
};
