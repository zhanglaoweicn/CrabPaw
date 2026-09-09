/**
 * skill-generate-tool - Auto generate new skills during conversation
 */

const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');

const SKILL_GENERATE_TOOL = {
  name: 'skill_generate',
  description: 'Automatically generate new skills during conversation. When user needs cannot be met by existing skills, use this tool to create new skills.',
  input_schema: {
    type: 'object',
    properties: {
      skillName: {
        type: 'string',
        description: 'Name of the new skill',
      },
      description: {
        type: 'string',
        description: 'Description of what the skill does',
      },
      requirements: {
        type: 'string',
        description: 'User requirements that need to be met by this skill',
      },
    },
    required: ['skillName', 'description'],
  },
};

function getSkillGenerateTool() {
  return SKILL_GENERATE_TOOL;
}

async function executeSkillGenerate(params, context) {
  const { skillName, description, requirements } = params || {};
  if (!skillName) {
    return { success: false, error: 'skillName is required' };
  }
  if (!description) {
    return { success: false, error: 'description is required' };
  }

  const skillsDir = context?.skillsDir || path.join(process.cwd(), 'skills', skillName);
  try {
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    const skillMd = `# ${skillName}\n\n${description}\n\n## Requirements\n${requirements || 'N/A'}\n`;
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillMd, 'utf8');

    return { success: true, skillDir: skillsDir, message: `Skill "${skillName}" created successfully.` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

registry.register({
  name: 'skill_generate',
  toolset: 'skills',
  category: 'skill',
  description: 'Automatically generate new skills during conversation. When user needs cannot be met by existing skills, use this tool to create new skills.',
  schema: {
    type: 'object',
    properties: {
      skillName: {
        type: 'string',
        description: 'Name of the new skill',
      },
      description: {
        type: 'string',
        description: 'Description of what the skill does',
      },
      requirements: {
        type: 'string',
        description: 'User requirements that need to be met by this skill',
      },
    },
    required: ['skillName', 'description'],
  },
  handler: executeSkillGenerate,
  isDangerous: false,
  isReadOnly: false,
});

console.log('🛠️ 技能生成工具已注册: skill_generate');

module.exports = {
  SKILL_GENERATE_TOOL,
  getSkillGenerateTool,
  executeSkillGenerate,
};