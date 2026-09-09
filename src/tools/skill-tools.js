/**
 * 技能工?- 渐进式披露模? * 
 * 灵感来自 Hermes ?skills_list ?skill_view 工具
 * AI 先调?skills_list 查看可用技能，然后根据需要调?skill_view 加载特定技? */

const { registry } = require('./registry');
const tierLoader = require('../core/skill/skill-tier-loader');
const fs = require('fs');
const path = require('path');
// 2026-08-01: 路径 config 化（此前硬编码相对路径，与核心配置可能漂移）
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../core/config');

function findSkillFile(skillName) {
  const dirs = [GLOBAL_SKILLS_DIR, SKILLS_DIR];
  
  for (const dir of dirs) {
    const skillPath = path.join(dir, skillName, 'SKILL.md');
      // Prevent path traversal: ensure resolved path stays within the skills directory
      const resolved = path.resolve(path.normalize(skillPath));
      if (!resolved.startsWith(path.resolve(dir))) {
        continue;
      }
      if (fs.existsSync(skillPath)) {
        return skillPath;
      }
  }
  
  return null;
}

function parseFrontmatter(content) {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const frontmatterStr = match[1];
  const body = match[2];
  const frontmatter = {};
  
  const lines = frontmatterStr.split('\n');
  let currentKey = null;
  let currentValue = [];
  let inNestedObject = false;
  
  for (const line of lines) {
    const keyMatch = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    
    if (keyMatch) {
      if (currentKey && currentValue.length > 0) {
        frontmatter[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
        currentValue = [];
      }
      
      currentKey = keyMatch[2];
      const value = keyMatch[3].trim();
      
      if (value === '' || value.startsWith('|')) {
        inNestedObject = true;
        currentValue = [];
      } else if (value === 'true') {
        currentValue.push(true);
      } else if (value === 'false') {
        currentValue.push(false);
      } else if (/^\d+$/.test(value)) {
        currentValue.push(parseInt(value, 10));
      } else if (/^\d+\.\d+$/.test(value)) {
        currentValue.push(parseFloat(value));
      } else {
        currentValue.push(value);
      }
    } else if (inNestedObject && line.startsWith('    ')) {
      currentValue.push(line.trim());
    }
  }
  
  if (currentKey && currentValue.length > 0) {
    frontmatter[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
  }
  
  return { frontmatter, body };
}

function checkSkillDeps(frontmatter, skillDir) {
  const issues = [];
  const requires = frontmatter.metadata?.crabpaw?.requires || frontmatter.metadata?.openclaw?.requires || [];
  
  const npmDeps = [];
  const pipDeps = [];
  const cliDeps = [];
  
  if (Array.isArray(requires)) {
    for (const r of requires) {
      if (typeof r === 'string') {
        if (r === 'python3' || r === 'python') cliDeps.push(r);
        else npmDeps.push(r);
      } else if (r && typeof r === 'object') {
        if (r.npm) npmDeps.push(...(Array.isArray(r.npm) ? r.npm : [r.npm]));
        if (r.pip) pipDeps.push(...(Array.isArray(r.pip) ? r.pip : [r.pip]));
      }
    }
  }
  if (Array.isArray(frontmatter.metadata?.crabpaw?.requires?.npm)) {
    npmDeps.push(...frontmatter.metadata.crabpaw.requires.npm);
  }

  for (const dep of npmDeps) {
    try { require.resolve(dep); } catch { issues.push(`npm:${dep}未安装`); }
  }
  // execSync/execFileSync 提到循环外（同名 const 在多个 for 块内声明 → TS2300）
  const { execSync, execFileSync } = require('child_process');
  for (const dep of pipDeps) {
    try {
      if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(dep)) { execFileSync('python', ['-c', `import ${dep}`], { stdio: "pipe", timeout: 5000 }) } else { issues.push(`pip:${dep} (invalid module name)`) }
    } catch { issues.push(`pip:${dep}未安装`); }
  }
  for (const dep of cliDeps) {
    if (dep === 'python3' || dep === 'python') {
      try {
        execSync('python --version', { stdio: 'pipe', timeout: 5000, windowsHide: true });
      } catch (e) { console.warn('[skill-tools] python not found:', e.message); issues.push('python not installed'); }
    }
  }

  const executorPath = path.join(skillDir, 'executor.js');
  const hasExecutor = fs.existsSync(executorPath);

  return { issues, hasExecutor, npmDeps, pipDeps };
}

function listSkills() {
  const skills = [];
  const dirs = [
    { path: SKILLS_DIR, source: 'builtin' },
    { path: GLOBAL_SKILLS_DIR, source: 'global' }
  ];
  
  for (const { path: dir, source } of dirs) {
    if (!fs.existsSync(dir)) continue;
    
    const skillDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    for (const skillName of skillDirs) {
      const skillPath = path.join(dir, skillName, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        try {
          const content = fs.readFileSync(skillPath, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);
          
          const firstLine = body.split('\n').find(l => l.trim() && !l.startsWith('#'));
          const shortDesc = firstLine ? firstLine.trim().substring(0, 100) : '';
          
          const skillDir = path.dirname(skillPath);
          const depCheck = checkSkillDeps(frontmatter, skillDir);
          
          skills.push({
            name: frontmatter.name || skillName,
            description: frontmatter.description || shortDesc || 'no description',
            category: frontmatter.metadata?.openclaw?.category || frontmatter.metadata?.crabpaw?.category || source,
            source: source,
            path: skillPath,
            hasExecutor: depCheck.hasExecutor,
            depIssues: depCheck.issues,
            available: depCheck.issues.length === 0,
            bundle: tierLoader.getSkillBundleInfo(skillName).bundle,
            priority: (frontmatter.metadata?.crabpaw?.priority) || 0
          });
        } catch (e) {
          console.error(`解析技?${skillName} 失败:`, e.message);
        }
      }
    }
  }
  
  return skills;
}

function viewSkill(skillName) {
  if (!skillName || typeof skillName !== 'string') {
    return {
      success: false,
      error: 'Please provide skill name (name param)'
    };
  }
  
  const skillPath = findSkillFile(skillName);
  
  if (!skillPath) {
    return {
      success: false,
      error: `技能"${skillName}" 不存在`
    };
  }
  
  try {
    const content = fs.readFileSync(skillPath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    
    const skillDir = path.dirname(skillPath);
    
    let commandHint = '';
    const pythonMatch = body.match(/python\s+(\S+\.py)\s+\S+/);
    if (pythonMatch) {
      const scriptPath = pythonMatch[1];
      const fullScriptPath = path.join(skillDir, scriptPath);
      commandHint = `python "${fullScriptPath}" run --text "<user_request>"`;
    }
    
    return {
      success: true,
      name: frontmatter.name || skillName,
      description: frontmatter.description || '',
      version: frontmatter.version || '1.0.0',
      metadata: frontmatter.metadata || {},
      instructions: body,
      path: skillPath,
      baseDir: skillDir,
      commandHint: commandHint
    };
  } catch (e) {
    return {
      success: false,
      error: `读取技能失? ${e.message}`
    };
  }
}

registry.register({
  name: 'SkillsList',
  toolset: 'skills',
  category: 'skill',
  description: 'List all available skills (progressive disclosure layer 1 - metadata only). Returns skill names and descriptions. Use SkillView to load full content',
  schema: {
    description: 'List all available skill metadata',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Optional category filter (skills available/active)'
        }
      }
    }
  },
  handler: async (params, _ctx) => {
    const skills = listSkills();
    const filtered = params.category ? skills.filter(s => s.category === params.category) : skills;
    const available = filtered.filter(s => s.available);
    const unavailable = filtered.filter(s => !s.available);
    let summary = '';
    if (available.length > 0) {
      summary += '可用技能:\n';
      for (const s of available) {
        summary += `  - ${s.name}: ${s.description}${s.hasExecutor ? ' [有执行器]' : ''}\n`;
      }
    }
    
    if (unavailable.length > 0) {
      summary += '\n不可用技能:\n';
      for (const s of unavailable) {
        summary += `  - ${s.name}: ${s.description} (缺少: ${s.depIssues.join(', ')})\n`;
      }
    }
    
    return {
      success: true,
      count: filtered.length,
      availableCount: available.length,
      unavailableCount: unavailable.length,
      skills: filtered.map(s => ({
        name: s.name,
        description: s.description,
        category: s.category,
        available: s.available,
        depIssues: s.depIssues.length > 0 ? s.depIssues : undefined,
        hasExecutor: s.hasExecutor,
        bundle: s.bundle,
        priority: s.priority
      })),
      summary,
      hint: '使用 SkillView 工具加载特定技能的完整内容（仅在你需要执行该技能时调用'
    };
  },
  timeout: 5000,
  isReadOnly: true
});

registry.register({
  name: 'SkillView',
  toolset: 'skills',
  category: 'skill',
  description: '加载特定技能的完整内容。必须提供技能名(name 或 skill_name 参数)。调用示例: SkillView({"name": "FlashClaw_stock"})',
  schema: {
    description: '加载特定技能的完整内容，必须提供 name 或 skill_name 参数',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '技能名称，必须是SkillsList返回的技能名称之一，例如"FlashClaw_stock"或"weather"'
        },
        skill_name: {
          type: 'string',
          description: '同 name（别名，二选一）'
        }
      }
    }
  },
  handler: async (params) => {
    // 2026-09-07: name/skill_name 双参数别名——旧实现 registry 只认 name 而
    // 契约只认 skill_name, 模型两种写法各有一半概率被拒(宣传片实测 SkillView
    // {name} 被契约拒)。二选一, 都缺时报错。
    const skillName = params.name || params.skill_name;
    if (!skillName) {
      return { success: false, error: '缺少技能名: 请传 name 或 skill_name 参数' };
    }
    const result = viewSkill(skillName);
    
    if (!result.success) {
      return result;
    }
    
    return {
      success: true,
      skill: result
    };
  },
  timeout: 5000,
  isReadOnly: true
});

// ─── SkillExecute — 执行器技能执行入口（2026-08-26）───
// 断点修复: 20 个执行器技能(chart-generator/excel-xlsx/deep-research…)的
// executeSkillAdvanced 此前未注册任何 LLM 可调工具 → 即使执行器健康, LLM
// 只能 SkillsList/SkillView"看"而不能"用"(R18 知识注入只覆盖知识型, 执行器型
// 全部闲置)。注册本工具接通"用户需求 → LLM 决策 → 执行器产出"闭环。
// 注: 仅对 hasExecutor 技能推荐执行; 知识型技能仍走 R18 注入(描述已含触发语义)。
registry.register({
  name: 'SkillExecute',
  toolset: 'skills',
  category: 'skill',
  description: '执行一个带执行器的技能。技能需先经 SkillView 加载或有明确产出目标。参数 skill 为技能名(须来自 SkillsList 且标注[有执行器]), input 为传给执行器的 JSON(按各技能约定, 如 chart-generator 传 {type,title,data}、excel-xlsx 传 {action,data,filename})。',
  schema: {
    description: '执行指定的执行器技能',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: '技能名, 必须来自 SkillsList 且标注[有执行器], 如 chart-generator/excel-xlsx/deep-research/pdf-generator'
        },
        input: {
          type: 'string',
          description: '执行参数 JSON 字符串/对象(按技能约定结构)'
        },
      },
      required: ['skill'],
    },
  },
  handler: async (params) => {
    const skillName = String(params.skill || '').trim();
    if (!skillName) return { success: false, error: '缺少技能名 skill' };
    // 守卫: 只放行有执行器的技能(知识型走 R18 注入, 不在此执行)
    try {
      const { getRegistry } = require('../core/skill-system');
      const reg = getRegistry();
      const sk = reg && reg[skillName];
      if (!sk) return { success: false, error: `技能「${skillName}」不存在` };
      const hasExec = sk.baseDir && require('fs').existsSync(require('path').join(sk.baseDir, 'executor.js'));
      if (!hasExec) return { success: false, error: `技能「${skillName}」无执行器, 无法执行(知识型技能由 LLM 按 SKILL.md 知识直接产出)` };
    } catch (e) { console.warn('[SkillExecute] 技能注册表检查失败:', e?.message || e); }
    let input = params.input;
    if (input != null && typeof input !== 'string') input = JSON.stringify(input);
    try {
      const { executeSkillAdvanced } = require('../core/skills');
      const result = await executeSkillAdvanced(skillName, String(input || ''), { silent: false });
      return { success: !!result?.success, skill: skillName, result };
    } catch (e) {
      return { success: false, error: `技能「${skillName}」执行失败: ${e?.message || e}` };
    }
  },
  timeout: 60000,
  isReadOnly: false,
});

console.log('📚 技能工具已注册: SkillsList, SkillView, SkillExecute');
