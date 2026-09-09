const os = require('os');
const path = require('path');
const fs = require('fs');

const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;
const COMPACT_WARNING_OVERHEAD = 150;

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function compactHomePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  const homes = resolveCompactHomePrefixes();
  for (const home of homes) {
    const prefixes = [home.endsWith(path.sep) ? home : home + path.sep];
    if (home.includes('\\') && !home.endsWith('\\')) {
      prefixes.push(home + '\\');
    }
    for (const prefix of prefixes) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const normalized = prefix.includes('\\') ? rest.replace(/\\/g, '/') : rest;
        return '~/' + normalized;
      }
    }
  }
  return filePath;
}

function resolveCompactHomePrefixes() {
  const homes = [];
  try {
    const home = path.resolve(os.homedir());
    homes.push(home);
    try {
      const real = fs.realpathSync(home);
      if (real !== home) homes.push(real);
    } catch (e) { console.warn('[skill-prompt-budget] Failed to resolve realpath:', e.message); }
  } catch (e) { console.warn('[skill-prompt-budget] Failed to resolve home:', e.message); }
  return homes.sort((a, b) => b.length - a.length);
}

function formatSkillsFull(skills) {
  if (skills.length === 0) return '';
  const lines = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill\'s file when the task matches its description.',
    'When a skill file references a relative path, resolve it against the skill directory.',
    '',
    '<available_skills>',
  ];
  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    if (skill.description) {
      lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    }
    if (skill.filePath) {
      lines.push(`    <location>${escapeXml(compactHomePath(skill.filePath))}</location>`);
    }
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function formatSkillsCompact(skills) {
  if (skills.length === 0) return '';
  const lines = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill\'s file when the task matches its name.',
    '',
    '<available_skills>',
  ];
  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    if (skill.filePath) {
      lines.push(`    <location>${escapeXml(compactHomePath(skill.filePath))}</location>`);
    }
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function applySkillsPromptLimits(skills, limits = {}) {
  const maxSkillsInPrompt = limits.maxSkillsInPrompt || DEFAULT_MAX_SKILLS_IN_PROMPT;
  const maxSkillsPromptChars = limits.maxSkillsPromptChars || DEFAULT_MAX_SKILLS_PROMPT_CHARS;

  const total = skills.length;
  const byCount = skills.slice(0, Math.max(0, maxSkillsInPrompt));

  let skillsForPrompt = byCount;
  let truncated = total > byCount.length;
  let compact = false;

  const fitsFull = (list) => formatSkillsFull(list).length <= maxSkillsPromptChars;
  const compactBudget = maxSkillsPromptChars - COMPACT_WARNING_OVERHEAD;
  const fitsCompact = (list) => formatSkillsCompact(list).length <= compactBudget;

  if (!fitsFull(skillsForPrompt)) {
    if (fitsCompact(skillsForPrompt)) {
      compact = true;
    } else {
      compact = true;
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid))) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
      truncated = true;
    }
  }

  return { skillsForPrompt, truncated, compact };
}

function buildBudgetedSkillsPrompt(skills, limits = {}) {
  if (!skills || skills.length === 0) {
    return '\n当前没有加载任何技能。\n';
  }

  const { skillsForPrompt, truncated, compact } = applySkillsPromptLimits(skills, limits);

  let prompt;
  if (compact) {
    prompt = formatSkillsCompact(skillsForPrompt);
    if (truncated) {
      prompt = `[技能列表已压缩以节省上下文空间，显示 ${skillsForPrompt.length}/${skills.length} 个技能]\n` + prompt;
    } else {
      prompt = '[技能列表已使用紧凑格式以节省上下文空间]\n' + prompt;
    }
  } else {
    prompt = formatSkillsFull(skillsForPrompt);
    if (truncated) {
      prompt = `[技能列表已截断，显示 ${skillsForPrompt.length}/${skills.length} 个技能]\n` + prompt;
    }
  }

  return prompt;
}

module.exports = {
  formatSkillsFull,
  formatSkillsCompact,
  applySkillsPromptLimits,
  buildBudgetedSkillsPrompt,
  compactHomePath,
  DEFAULT_MAX_SKILLS_IN_PROMPT,
  DEFAULT_MAX_SKILLS_PROMPT_CHARS,
};
