const fs = require('fs');
const path = require('path');
const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('./config');
// eslint-disable-next-line no-unused-vars
const { scanSkillDirectory } = require('./skill-loader-enhanced');

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LENGTH = 100000;

const SKILL_TEMPLATE = `---
name: {name}
version: 1.0.0
description: "{description}"
metadata:
  crabpaw:
    category: {category}
    requires:
      bins: []
      npm: []
      pip: []
---

# {name}

{description}

## 功能说明

[待补充] 添加功能说明

## 使用方式

[待补充] 添加使用说明

## 注意事项

- 此技能由用户创建，可根据需要修改
`;

function validateSkillName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: '技能名称不能为空' };
  }

  const normalized = name.toLowerCase()
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (normalized.length === 0) {
    return { valid: false, error: '技能名称无效' };
  }

  if (normalized.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, error: `技能名称过长（最大 ${MAX_SKILL_NAME_LENGTH} 字符）` };
  }

  return { valid: true, normalized };
}

function validateDescription(description) {
  if (!description || typeof description !== 'string') {
    return { valid: false, error: '描述不能为空' };
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { valid: false, error: `描述过长（最大 ${MAX_DESCRIPTION_LENGTH} 字符）` };
  }

  return { valid: true };
}

function validateBody(body) {
  if (body && body.length > MAX_BODY_LENGTH) {
    return { valid: false, error: `技能内容过长（最大 ${MAX_BODY_LENGTH} 字符）` };
  }

  return { valid: true };
}

function findSkillPath(skillName) {
  const dirs = [
    { path: GLOBAL_SKILLS_DIR, source: 'global' },
    { path: SKILLS_DIR, source: 'builtin' }
  ];

  for (const { path: dir, source } of dirs) {
    const skillPath = path.join(dir, skillName);
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    if (fs.existsSync(skillMdPath)) {
      return { skillPath, skillMdPath, source };
    }
  }

  return null;
}

function createSkill(options) {
  const { name, description, category = 'general', targetDir = GLOBAL_SKILLS_DIR } = options;

  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid) {
    return { success: false, error: nameValidation.error };
  }

  const descValidation = validateDescription(description);
  if (!descValidation.valid) {
    return { success: false, error: descValidation.error };
  }

  const skillName = nameValidation.normalized;
  const skillPath = path.join(targetDir, skillName);
  const skillMdPath = path.join(skillPath, 'SKILL.md');

  if (fs.existsSync(skillMdPath)) {
    return { success: false, error: `技能 "${skillName}" 已存在` };
  }

  try {
    fs.mkdirSync(skillPath, { recursive: true });

    const content = SKILL_TEMPLATE
      .replace(/{name}/g, skillName)
      .replace(/{description}/g, description)
      .replace(/{category}/g, category);

    fs.writeFileSync(skillMdPath, content, 'utf-8');

    console.log(`✅ 创建技能: ${skillName}`);

    return {
      success: true,
      skillName,
      skillPath,
      skillMdPath
    };
  } catch (e) {
    return { success: false, error: `创建技能失败: ${e.message}` };
  }
}

function editSkill(skillName, options) {
  const { body, description, metadata } = options;

  const found = findSkillPath(skillName);
  if (!found) {
    return { success: false, error: `技能 "${skillName}" 不存在` };
  }

  // eslint-disable-next-line no-unused-vars
  const { skillMdPath, source } = found;

  try {
    let content = fs.readFileSync(skillMdPath, 'utf-8');
    const frontmatterMatch = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);

    if (!frontmatterMatch) {
      return { success: false, error: '技能文件格式无效' };
    }

    let frontmatter = frontmatterMatch[1];
    let currentBody = frontmatterMatch[2];

    if (description) {
      const descValidation = validateDescription(description);
      if (!descValidation.valid) {
        return { success: false, error: descValidation.error };
      }
      frontmatter = frontmatter.replace(
        /^description:\s*.*$/m,
        `description: "${description}"`
      );
    }

    if (body) {
      const bodyValidation = validateBody(body);
      if (!bodyValidation.valid) {
        return { success: false, error: bodyValidation.error };
      }
      currentBody = body;
    }

    const newContent = frontmatter + currentBody;
    fs.writeFileSync(skillMdPath, newContent, 'utf-8');

    console.log(`✅ 编辑技能: ${skillName}`);

    return {
      success: true,
      skillName,
      skillMdPath,
      changes: {
        body: !!body,
        description: !!description,
        metadata: !!metadata
      }
    };
  } catch (e) {
    return { success: false, error: `编辑技能失败: ${e.message}` };
  }
}

function patchSkill(skillName, options) {
  const { oldContent, newContent } = options;

  if (!oldContent || !newContent) {
    return { success: false, error: '必须提供 oldContent 和 newContent' };
  }

  const found = findSkillPath(skillName);
  if (!found) {
    return { success: false, error: `技能 "${skillName}" 不存在` };
  }

  const { skillMdPath } = found;

  try {
    let content = fs.readFileSync(skillMdPath, 'utf-8');

    if (!content.includes(oldContent)) {
      return { success: false, error: '未找到要替换的内容' };
    }

    const newFileContent = content.replace(oldContent, newContent);

    const bodyValidation = validateBody(newFileContent);
    if (!bodyValidation.valid) {
      return { success: false, error: bodyValidation.error };
    }

    fs.writeFileSync(skillMdPath, newFileContent, 'utf-8');

    console.log(`✅ 补丁技能: ${skillName}`);

    return {
      success: true,
      skillName,
      skillMdPath
    };
  } catch (e) {
    return { success: false, error: `补丁技能失败: ${e.message}` };
  }
}

function deleteSkill(skillName) {
  const found = findSkillPath(skillName);
  if (!found) {
    return { success: false, error: `技能 "${skillName}" 不存在` };
  }

  const { skillPath, source } = found;

  if (source === 'builtin') {
    return { success: false, error: '不能删除内置技能' };
  }

  try {
    fs.rmSync(skillPath, { recursive: true, force: true });

    console.log(`✅ 删除技能: ${skillName}`);

    return {
      success: true,
      skillName,
      skillPath
    };
  } catch (e) {
    return { success: false, error: `删除技能失败: ${e.message}` };
  }
}

function writeSkillFile(skillName, relativePath, content) {
  const found = findSkillPath(skillName);
  if (!found) {
    return { success: false, error: `技能 "${skillName}" 不存在` };
  }

  const { skillPath, source } = found;

  if (source === 'builtin') {
    return { success: false, error: '不能修改内置技能文件' };
  }

  const normalizedPath = relativePath
    .replace(/\.\./g, '')
    .replace(/^[/\\]+/, '');

  if (normalizedPath === 'SKILL.md') {
    return { success: false, error: '请使用 editSkill 修改 SKILL.md' };
  }

  const filePath = path.join(skillPath, normalizedPath);
  const dir = path.dirname(filePath);

  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');

    console.log(`✅ 写入技能文件: ${skillName}/${normalizedPath}`);

    return {
      success: true,
      skillName,
      filePath
    };
  } catch (e) {
    return { success: false, error: `写入文件失败: ${e.message}` };
  }
}

function removeSkillFile(skillName, relativePath) {
  const found = findSkillPath(skillName);
  if (!found) {
    return { success: false, error: `技能 "${skillName}" 不存在` };
  }

  const { skillPath, source } = found;

  if (source === 'builtin') {
    return { success: false, error: '不能删除内置技能文件' };
  }

  const normalizedPath = relativePath
    .replace(/\.\./g, '')
    .replace(/^[/\\]+/, '');

  if (normalizedPath === 'SKILL.md') {
    return { success: false, error: '不能删除 SKILL.md，请使用 deleteSkill 删除整个技能' };
  }

  const filePath = path.join(skillPath, normalizedPath);

  if (!fs.existsSync(filePath)) {
    return { success: false, error: `文件 "${relativePath}" 不存在` };
  }

  try {
    fs.unlinkSync(filePath);

    console.log(`✅ 删除技能文件: ${skillName}/${normalizedPath}`);

    return {
      success: true,
      skillName,
      filePath
    };
  } catch (e) {
    return { success: false, error: `删除文件失败: ${e.message}` };
  }
}

module.exports = {
  validateSkillName,
  validateDescription,
  validateBody,
  findSkillPath,
  createSkill,
  editSkill,
  patchSkill,
  deleteSkill,
  writeSkillFile,
  removeSkillFile,
  SKILL_TEMPLATE
};
