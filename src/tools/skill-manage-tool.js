/**
 * Skill Manage Tool - Agent 主动技能管理工具
 * 
 * 允许 Agent 在对话中主动创建、编辑、删除技能
 * 
 * Actions:
 *   create     - 创建新技能 (SKILL.md + 目录结构)
 *   edit       - 完整替换 SKILL.md 内容
 *   patch      - 部分修改 SKILL.md 或支持文件
 *   delete     - 删除用户技能
 *   write_file - 添加/覆盖支持文件
 *   remove_file- 删除支持文件
 *   list       - 列出所有技能
 *   view       - 查看技能详情
 */

const fs = require('fs');
const { getCurrentWriteOrigin, markProvenance, WRITE_ORIGINS } = require('../core/skill/skill-provenance');
const path = require('path');
const { registry } = require('./registry');
// 2026-08-01: 路径 config 化（此前硬编码相对路径，与核心配置可能漂移）
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../core/config');
const USER_SKILLS_DIR = GLOBAL_SKILLS_DIR;

const MAX_NAME_LENGTH = 64;

const MAX_SKILL_CONTENT_CHARS = 100000;
const MAX_SKILL_FILE_BYTES = 1048576;

const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);

const SECURITY_PATTERNS = [
  { pattern: /eval\s*\(/g, severity: 'critical', desc: '使用 eval()，可能执行任意代码' },
  { pattern: /Function\s*\(/g, severity: 'high', desc: '使用 Function 构造器' },
  { pattern: /require\s*\(\s*['"]child_process/g, severity: 'critical', desc: '引入 child_process' },
  { pattern: /exec\s*\(\s*[^)]*\)/g, severity: 'high', desc: '调用 exec' },
  { pattern: /execSync\s*\(/g, severity: 'high', desc: '调用 execSync' },
  { pattern: /spawn\s*\(/g, severity: 'medium', desc: '调用 spawn' },
];

function validateName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: '技能名称不能为空' };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { valid: false, error: `技能名称过长，最大 ${MAX_NAME_LENGTH} 字符` };
  }
  if (!VALID_NAME_RE.test(name)) {
    return { valid: false, error: '技能名称只能包含小写字母、数字、点、下划线和连字符，且必须以字母或数字开头' };
  }
  return { valid: true };
}

function scanSecurity(content, fileName = 'SKILL.md') {
  const findings = [];
  for (const { pattern, severity, desc } of SECURITY_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches) {
      findings.push({
        file: fileName,
        severity,
        desc,
        count: matches.length
      });
    }
  }
  return findings;
}

function formatFindings(findings) {
  if (findings.length === 0) return '';
  
  const lines = ['安全扫描发现以下问题:'];
  const critical = findings.filter(f => f.severity === 'critical');
  const high = findings.filter(f => f.severity === 'high');
  const medium = findings.filter(f => f.severity === 'medium');
  
  if (critical.length > 0) {
    lines.push('🚨 严重风险:');
    critical.forEach(f => lines.push(`  - ${f.file}: ${f.desc} (x${f.count})`));
  }
  if (high.length > 0) {
    lines.push('⚠️ 高风险:');
    high.forEach(f => lines.push(`  - ${f.file}: ${f.desc} (x${f.count})`));
  }
  if (medium.length > 0) {
    lines.push('ℹ️ 中等风险:');
    medium.forEach(f => lines.push(`  - ${f.file}: ${f.desc} (x${f.count})`));
  }
  
  return lines.join('\n');
}

function findSkillDir(name) {
  const dirs = [USER_SKILLS_DIR, GLOBAL_SKILLS_DIR, SKILLS_DIR];
  
  for (const dir of dirs) {
    const skillPath = path.join(dir, name);
    const skillFile = path.join(skillPath, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      return { path: skillPath, source: dir === SKILLS_DIR ? 'builtin' : 'user' };
    }
  }
  
  return null;
}

function ensureUserSkillsDir() {
  if (!fs.existsSync(USER_SKILLS_DIR)) {
    fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });
  }
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
  
  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    
    if (keyMatch) {
      if (currentKey && currentValue.length > 0) {
        frontmatter[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
        currentValue = [];
      }
      
      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();
      
      if (value === 'true') {
        currentValue.push(true);
      } else if (value === 'false') {
        currentValue.push(false);
      } else if (/^\d+$/.test(value)) {
        currentValue.push(parseInt(value));
      } else if (/^\d+\.\d+$/.test(value)) {
        currentValue.push(parseFloat(value));
      } else if (value.startsWith('[') && value.endsWith(']')) {
        try {
          currentValue.push(JSON.parse(value));
        } catch {
          currentValue.push(value);
        }
      } else {
        currentValue.push(value);
      }
    }
  }
  
  if (currentKey && currentValue.length > 0) {
    frontmatter[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue;
  }
  
  return { frontmatter, body };
}

function generateSkillTemplate(name, description = '') {
  return `---
name: ${name}
description: ${description || 'Agent 创建的技能'}
arguments: []
argument-hint: ""
metadata:
  created_by: agent
  created_at: ${new Date().toISOString()}
---

# ${name}

${description || '这是一个由 Agent 自动创建的技能。'}

## 使用方法

请根据实际需求补充技能的具体使用方法。

## 示例

\`\`\`bash
# 示例命令
echo "Hello from ${name}"
\`\`\`

## 注意事项

- 此技能由 Agent 自动创建
- 请根据实际需求修改和完善
`;
}

async function handleSkillManage(params, _context) {
  const { action, name, content, file_path, file_content, old_str, new_str, params: executeParams } = params;
  
  if (!action) {
    return { success: false, error: '缺少 action 参数' };
  }
  
  switch (action) {
    case 'create':
      return handleCreate(name, content);
    case 'edit':
      return handleEdit(name, content);
    case 'patch':
      return handlePatch(name, old_str, new_str, file_path);
    case 'delete':
      return handleDelete(name);
    case 'write_file':
      return handleWriteFile(name, file_path, file_content);
    case 'remove_file':
      return handleRemoveFile(name, file_path);
    case 'list':
      return handleList();
    case 'view':
      return handleView(name);
    case 'execute':
      return handleExecute(name, executeParams);
    default:
      return { success: false, error: `未知操作: ${action}` };
  }
}

function handleCreate(name, content) {
  const validation = validateName(name);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }
  
  const existing = findSkillDir(name);
  if (existing) {
    return { success: false, error: `技能 "${name}" 已存在于 ${existing.path}` };
  }
  
  ensureUserSkillsDir();
  
  const skillDir = path.join(USER_SKILLS_DIR, name);
  const skillFile = path.join(skillDir, 'SKILL.md');
  
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    
    const skillContent = content || generateSkillTemplate(name);
    
    if (skillContent.length > MAX_SKILL_CONTENT_CHARS) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      return { success: false, error: `技能内容过长，最大 ${MAX_SKILL_CONTENT_CHARS} 字符` };
    }
    
    const findings = scanSecurity(skillContent);
    const criticalFindings = findings.filter(f => f.severity === 'critical');
    
    if (criticalFindings.length > 0) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      return {
        success: false,
        error: `安全扫描阻止创建技能:\n${formatFindings(criticalFindings)}`
      };
    }
    
    fs.writeFileSync(skillFile, skillContent, 'utf-8');
    try { const origin = getCurrentWriteOrigin(); markProvenance(name, origin || WRITE_ORIGINS.FOREGROUND); } catch(_) { console.warn('Failed to mark provenance for skill ' + name); }
    
    const warnings = findings.filter(f => f.severity !== 'critical');
    let message = `技能 "${name}" 创建成功`;
    if (warnings.length > 0) {
      message += `\n\n⚠️ ${formatFindings(warnings)}`;
    }
    
    console.log(`✅ 技能创建成功: ${name}`);
    
    return {
      success: true,
      name,
      path: skillFile,
      message,
      warnings: warnings.length > 0 ? formatFindings(warnings) : null
    };
  } catch (e) {
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
    return { success: false, error: `创建技能失败: ${e.message}` };
  }
}

function handleEdit(name, content) {
  if (!content) {
    return { success: false, error: '缺少 content 参数' };
  }
  
  const skillDir = findSkillDir(name);
  if (!skillDir) {
    return { success: false, error: `技能 "${name}" 不存在` };
  }
  
  if (skillDir.source === 'builtin') {
    return { success: false, error: '不能编辑内置技能，请创建新技能或编辑用户技能' };
  }
  
  const skillFile = path.join(skillDir.path, 'SKILL.md');
  
  try {
    if (content.length > MAX_SKILL_CONTENT_CHARS) {
      return { success: false, error: `技能内容过长，最大 ${MAX_SKILL_CONTENT_CHARS} 字符` };
    }
    
    const findings = scanSecurity(content);
    const criticalFindings = findings.filter(f => f.severity === 'critical');
    
    if (criticalFindings.length > 0) {
      return {
        success: false,
        error: `安全扫描阻止编辑:\n${formatFindings(criticalFindings)}`
      };
    }
    
    fs.writeFileSync(skillFile, content, 'utf-8');
    
    console.log(`✅ 技能编辑成功: ${name}`);
    
    return {
      success: true,
      name,
      path: skillFile,
      message: `技能 "${name}" 更新成功`
    };
  } catch (e) {
    return { success: false, error: `编辑技能失败: ${e.message}` };
  }
}

function handlePatch(name, old_str, new_str, file_path) {
  if (!old_str) {
    return { success: false, error: '缺少 old_str 参数' };
  }
  
  const skillDir = findSkillDir(name);
  if (!skillDir) {
    return { success: false, error: `技能 "${name}" 不存在` };
  }
  
  if (skillDir.source === 'builtin') {
    return { success: false, error: '不能修改内置技能' };
  }
  
  const targetFile = file_path
    ? path.join(skillDir.path, file_path)
    : path.join(skillDir.path, 'SKILL.md');
  
  if (!fs.existsSync(targetFile)) {
    return { success: false, error: `文件不存在: ${file_path || 'SKILL.md'}` };
  }
  
  const realPath = fs.realpathSync(targetFile);
  const realSkillDir = fs.realpathSync(skillDir.path);
  if (!realPath.startsWith(realSkillDir)) {
    return { success: false, error: '非法文件路径' };
  }
  
  try {
    let content = fs.readFileSync(targetFile, 'utf-8');
    
    if (!content.includes(old_str)) {
      return { success: false, error: '未找到要替换的内容' };
    }
    
    const newContent = content.replace(old_str, new_str || '');
    
    if (file_path === 'SKILL.md' || !file_path) {
      if (newContent.length > MAX_SKILL_CONTENT_CHARS) {
        return { success: false, error: `技能内容过长` };
      }
      
      const findings = scanSecurity(newContent);
      const criticalFindings = findings.filter(f => f.severity === 'critical');
      
      if (criticalFindings.length > 0) {
        return {
          success: false,
          error: `安全扫描阻止修改:\n${formatFindings(criticalFindings)}`
        };
      }
    }
    
    fs.writeFileSync(targetFile, newContent, 'utf-8');
    
    console.log(`✅ 技能修补成功: ${name}`);
    
    return {
      success: true,
      name,
      path: targetFile,
      message: `技能 "${name}" 修补成功`
    };
  } catch (e) {
    return { success: false, error: `修补技能失败: ${e.message}` };
  }
}

function handleDelete(name) {
  const skillDir = findSkillDir(name);
  if (!skillDir) {
    return { success: false, error: `技能 "${name}" 不存在` };
  }
  
  if (skillDir.source === 'builtin') {
    return { success: false, error: '不能删除内置技能' };
  }
  
  try {
    fs.rmSync(skillDir.path, { recursive: true, force: true });
    
    console.log(`🗑️ 技能删除成功: ${name}`);
    
    return {
      success: true,
      name,
      message: `技能 "${name}" 已删除`
    };
  } catch (e) {
    return { success: false, error: `删除技能失败: ${e.message}` };
  }
}

function handleWriteFile(name, file_path, file_content) {
  if (!file_path) {
    return { success: false, error: '缺少 file_path 参数' };
  }
  
  const parts = file_path.split('/').filter(Boolean);
  if (parts.length < 1) {
    return { success: false, error: '无效的文件路径' };
  }
  
  const subdir = parts[0];
  if (!ALLOWED_SUBDIRS.has(subdir)) {
    return { success: false, error: `只允许在以下目录创建文件: ${[...ALLOWED_SUBDIRS].join(', ')}` };
  }
  
  const skillDir = findSkillDir(name);
  if (!skillDir) {
    return { success: false, error: `技能 "${name}" 不存在` };
  }
  
  if (skillDir.source === 'builtin') {
    return { success: false, error: '不能修改内置技能' };
  }
  
  if (file_content && file_content.length > MAX_SKILL_FILE_BYTES) {
    return { success: false, error: `文件内容过大，最大 ${MAX_SKILL_FILE_BYTES} 字节` };
  }
  
  const targetDir = path.join(skillDir.path, subdir);
  const targetFile = path.join(skillDir.path, file_path);
  
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    
    fs.writeFileSync(targetFile, file_content || '', 'utf-8');
    
    console.log(`✅ 技能文件写入成功: ${name}/${file_path}`);
    
    return {
      success: true,
      name,
      path: targetFile,
      message: `文件 "${file_path}" 写入成功`
    };
  } catch (e) {
    return { success: false, error: `写入文件失败: ${e.message}` };
  }
}

function handleRemoveFile(name, file_path) {
  if (!file_path) {
    return { success: false, error: '缺少 file_path 参数' };
  }
  
  const parts = file_path.split('/').filter(Boolean);
  if (parts.length < 1) {
    return { success: false, error: '无效的文件路径' };
  }
  
  const subdir = parts[0];
  if (!ALLOWED_SUBDIRS.has(subdir)) {
    return { success: false, error: `只允许删除以下目录中的文件: ${[...ALLOWED_SUBDIRS].join(', ')}` };
  }
  
  const skillDir = findSkillDir(name);
  if (!skillDir) {
    return { success: false, error: `技能 "${name}" 不存在` };
  }
  
  if (skillDir.source === 'builtin') {
    return { success: false, error: '不能修改内置技能' };
  }
  
  const targetFile = path.join(skillDir.path, file_path);
  
  if (!fs.existsSync(targetFile)) {
    return { success: false, error: `文件不存在: ${file_path}` };
  }
  
  const realPath = fs.realpathSync(targetFile);
  const realSkillDir = fs.realpathSync(skillDir.path);
  if (!realPath.startsWith(realSkillDir)) {
    return { success: false, error: '非法文件路径' };
  }
  
  try {
    fs.unlinkSync(targetFile);
    
    console.log(`🗑️ 技能文件删除成功: ${name}/${file_path}`);
    
    return {
      success: true,
      name,
      message: `文件 "${file_path}" 已删除`
    };
  } catch (e) {
    return { success: false, error: `删除文件失败: ${e.message}` };
  }
}

function handleList() {
  const skills = [];
  const dirs = [
    { path: SKILLS_DIR, source: 'builtin' },
    { path: GLOBAL_SKILLS_DIR, source: 'global' },
    { path: USER_SKILLS_DIR, source: 'user' }
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
          
          skills.push({
            name: frontmatter.name || skillName,
            description: frontmatter.description || shortDesc || '无描述',
            source,
            canEdit: source !== 'builtin'
          });
        } catch (e) {
          console.error(`解析技能 ${skillName} 失败:`, e.message);
        }
      }
    }
  }
  
  return {
    success: true,
    skills,
    count: skills.length
  };
}

function handleView(name) {
  const skillDir = findSkillDir(name);
  
  if (!skillDir) {
    return { success: false, error: `技能 "${name}" 不存在` };
  }
  
  try {
    const skillFile = path.join(skillDir.path, 'SKILL.md');
    const content = fs.readFileSync(skillFile, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    
    const files = [];
    const subdirs = ['references', 'templates', 'scripts', 'assets'];
    
    for (const subdir of subdirs) {
      const subdirPath = path.join(skillDir.path, subdir);
      if (fs.existsSync(subdirPath)) {
        const subdirFiles = fs.readdirSync(subdirPath)
          .filter(f => fs.statSync(path.join(subdirPath, f)).isFile());
        for (const f of subdirFiles) {
          files.push(`${subdir}/${f}`);
        }
      }
    }
    
    return {
      success: true,
      name: frontmatter.name || name,
      description: frontmatter.description || '',
      source: skillDir.source,
      canEdit: skillDir.source !== 'builtin',
      path: skillDir.path,
      frontmatter,
      content: body,
      raw_content: content,
      files
    };
  } catch (e) {
    return { success: false, error: `读取技能失败: ${e.message}` };
  }
}

registry.register({
  name: 'skill_manage',
  toolset: 'skills',
  category: 'skills',
  description: 'Agent 主动管理技能 - 创建、编辑、删除技能，将成功经验转化为可复用的程序记忆',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file', 'list', 'view', 'execute'],
        description: '操作类型: create(创建), edit(编辑), patch(修补), delete(删除), write_file(写文件), remove_file(删文件), list(列表), view(查看), execute(执行技能)'
      },
      name: {
        type: 'string',
        description: '技能名称 (小写字母、数字、点、下划线、连字符)'
      },
      params: {
        type: 'object',
        description: '执行参数（action=execute 时使用），传递给技能的 execute() 函数作为 input'
      },
      content: {
        type: 'string',
        description: 'SKILL.md 完整内容 (用于 create/edit)'
      },
      old_str: {
        type: 'string',
        description: '要替换的旧文本 (用于 patch)'
      },
      new_str: {
        type: 'string',
        description: '替换后的新文本 (用于 patch)'
      },
      file_path: {
        type: 'string',
        description: '支持文件路径，如 references/example.md (用于 patch/write_file/remove_file)'
      },
      file_content: {
        type: 'string',
        description: '文件内容 (用于 write_file)'
      }
    },
    required: ['action']
  },
  handler: handleSkillManage,
  isDangerous: false,
  isReadOnly: false
});

console.log('🛠️ 技能管理工具已注册: skill_manage');

async function handleExecute(name, executeParams) {
  if (!name) { return { success: false, error: '缺少 name 参数' }; }
  try {
    const { executeSkillAdvanced } = require('../core/skills');
    const result = await executeSkillAdvanced(name, executeParams || {});
    return result;
  } catch (e) {
    return { success: false, error: `执行技能失败: ${e.message}` };
  }
}

module.exports = {
  handleSkillManage,
  handleCreate,
  handleEdit,
  handlePatch,
  handleDelete,
  handleWriteFile,
  handleRemoveFile,
  handleList,
  handleView
};
