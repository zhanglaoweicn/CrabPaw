/**
 * Multi-Format Output Skills — eval test cases
 * Tests: diagram-generator, html-generator, chart-generator skill metadata validity
 */
const fs = require('fs');
const path = require('path');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');
const USER_SKILLS_DIR = path.join(__dirname, '..', '..', 'data', 'skills');

// Test helpers
const skillExists = (dir, name) => fs.existsSync(path.join(dir, name, 'SKILL.md'));
const readSkill = (dir, name) => {
  const p = path.join(dir, name, 'SKILL.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
};

// 统一使用 canonical frontmatter-parser（2026-08-01：替换朴素逐行解析器）
const { parseFrontmatter } = require('../../src/core/skill/frontmatter-parser');
const parseSkillFrontmatter = (content) => {
  if (!content) return null;
  return parseFrontmatter(content).frontmatter || null;
};

module.exports = {
  name: 'Multi-Format Output Skills',
  cases: [
    {
      id: 'mfo_001',
      name: 'diagram-generator skill exists',
      category: 'skill_validate',
      run: () => skillExists(SKILLS_DIR, 'diagram-generator'),
    },
    {
      id: 'mfo_002',
      name: 'diagram-generator has valid frontmatter',
      category: 'skill_validate',
      run: () => {
        const content = readSkill(SKILLS_DIR, 'diagram-generator');
        if (!content) return false;
        const fm = parseSkillFrontmatter(content);
        return fm && fm.name === 'diagram-generator' && fm.version;
      },
    },
    {
      id: 'mfo_003',
      name: 'diagram-generator mentions Mermaid',
      category: 'skill_validate',
      run: () => {
        const content = readSkill(SKILLS_DIR, 'diagram-generator');
        return content && /[Mm]ermaid/.test(content);
      },
    },
    {
      id: 'mfo_004',
      name: 'html-generator skill exists',
      category: 'skill_validate',
      run: () => skillExists(SKILLS_DIR, 'html-generator'),
    },
    {
      id: 'mfo_005',
      name: 'html-generator has valid frontmatter',
      category: 'skill_validate',
      run: () => {
        const content = readSkill(SKILLS_DIR, 'html-generator');
        if (!content) return false;
        const fm = parseSkillFrontmatter(content);
        return fm && fm.name === 'html-generator' && fm.version;
      },
    },
    {
      id: 'mfo_006',
      name: 'html-generator describes standalone HTML output',
      category: 'skill_validate',
      run: () => {
        const content = readSkill(SKILLS_DIR, 'html-generator');
        return content && /独立.*HTML|单文件.*HTML|standalone.*html/i.test(content);
      },
    },
    {
      id: 'mfo_007',
      name: 'chart-generator skill exists',
      category: 'skill_validate',
      run: () => skillExists(SKILLS_DIR, 'chart-generator'),
    },
    {
      id: 'mfo_008',
      name: 'chart-generator has valid frontmatter',
      category: 'skill_validate',
      run: () => {
        const content = readSkill(SKILLS_DIR, 'chart-generator');
        if (!content) return false;
        const fm = parseSkillFrontmatter(content);
        return fm && fm.name === 'chart-generator' && fm.version;
      },
    },
    {
      id: 'mfo_009',
      name: 'chart-generator covers ECharts or Chart.js',
      category: 'skill_validate',
      run: () => {
        const content = readSkill(SKILLS_DIR, 'chart-generator');
        return content && (/[Ee]Charts/.test(content) || /[Cc]hart\.js/.test(content));
      },
    },
    {
      id: 'mfo_010',
      name: 'All three new skills have metadata.crabpaw',
      category: 'skill_validate',
      run: () => {
        for (const name of ['diagram-generator', 'html-generator', 'chart-generator']) {
          const content = readSkill(SKILLS_DIR, name);
          if (!content) return false;
          const fm = parseSkillFrontmatter(content);
          if (!fm || !fm.metadata || !(fm.metadata.crabpaw || fm.metadata.crawpaw)) return false;
        }
        return true;
      },
    },
    {
      id: 'mfo_011',
      name: 'Existing skills still intact after new additions',
      category: 'regression',
      run: () => {
        const required = ['pdf-generator', 'word-docx', 'powerpoint-pptx', 'markdown-converter', 'doc-processor'];
        for (const name of required) {
          if (!skillExists(SKILLS_DIR, name)) return false;
          const content = readSkill(SKILLS_DIR, name);
          if (!content || content.length < 100) return false;
        }
        return true;
      },
    },
    {
      id: 'mfo_012',
      name: 'Imported skills dir has SKILL.md files',
      category: 'skill_validate',
      tags: ['P1', 'cap:skill'],
      run: () => {
        if (!fs.existsSync(USER_SKILLS_DIR)) return false;
        const skillDirs = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .map(d => d.name);
        if (skillDirs.length === 0) return false;
        const withSkillMd = skillDirs.filter(n => skillExists(USER_SKILLS_DIR, n));
        return withSkillMd.length > 0;
      },
    },
    {
      id: 'mfo_013',
      name: 'Imported skills have valid frontmatter (name + description)',
      category: 'skill_validate',
      tags: ['P1', 'cap:skill', 'severity:major'],
      run: () => {
        if (!fs.existsSync(USER_SKILLS_DIR)) return false;
        const skillDirs = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .map(d => d.name);
        let checked = 0;
        for (const name of skillDirs) {
          const content = readSkill(USER_SKILLS_DIR, name);
          if (!content) continue;
          const fm = parseSkillFrontmatter(content);
          if (!fm || !fm.name || !fm.description) return false;
          checked++;
        }
        return checked > 0;
      },
    },
    {
      id: 'mfo_014',
      name: 'Imported skills parse via canonical parser without error',
      category: 'skill_validate',
      tags: ['P2', 'cap:skill'],
      run: () => {
        if (!fs.existsSync(USER_SKILLS_DIR)) return false;
        const skillDirs = fs.readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('.'))
          .map(d => d.name);
        let parsed = 0;
        for (const name of skillDirs) {
          const content = readSkill(USER_SKILLS_DIR, name);
          if (!content) continue;
          try {
            const result = parseFrontmatter(content);
            if (result && result.frontmatter) parsed++;
          } catch {
            return false;
          }
        }
        return parsed > 0;
      },
    },
  ],
};
