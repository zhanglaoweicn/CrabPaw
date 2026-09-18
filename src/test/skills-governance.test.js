/**
 * 技能库治理回归测试（2026-09-18）
 *
 * 背景: 技能库审计发现三类问题并治理——
 *   ① 壳目录污染: 无 SKILL.md 的分类说明/嵌套遗留目录(core/、system/、_builtin/ 等)
 *      被注册成空描述壳技能进入候选清单
 *   ② 跨根双胞胎: 市场/重装安装与内置同名(deep-research、multi-search-engine),
 *      加载不去重 → 同一消息注入两份不同说明书(指令打架)
 *   ③ 无命中全量回退: 日常短句触发 90 技能全量正文注入(实测 16.4K 字符 ≈ 6.5K tokens)
 *   ④ 禁用名单只拦执行不拦提示词
 *
 * 注意: DATA_DIR 在 config require 期固化, 本文件在 require 之前设置
 * CRABPAW_DATA_DIR 指向临时目录(与 tool-result-storage.test.js 同款机制)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-governance-'));
process.env.CRABPAW_DATA_DIR = TMP_ROOT;

// 禁用名单先落盘(治理④的回归锚点)
fs.writeFileSync(path.join(TMP_ROOT, 'disabled-skills.json'), JSON.stringify(['weather-format']), 'utf-8');

const {
  loadSkills,
  loadSkillsFromDir,
  buildSkillsPrompt,
  buildSkillsPromptScoped,
  buildSkillsIndexPrompt,
  getDisabledSkillNames,
} = require('../core/skills');
const { filterSkillsByContext } = require('../core/ai-utils');

afterAll(() => {
  // 尽力清理: Windows 下技能加载器/质量跟踪器的句柄可能未及时释放导致 EBUSY,
  // 临时目录最终由系统回收, 清理失败不判失败
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('治理①: 壳目录不再注册为技能', () => {
  function makeSkillDir(root, name, withSkillMd = true) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (withSkillMd) {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n\n正文\n`, 'utf-8');
    } else {
      fs.writeFileSync(path.join(dir, 'DESCRIPTION.md'), `# ${name} 分类说明\n`, 'utf-8');
    }
    return dir;
  }

  test('无 SKILL.md 且无 config.json 的目录跳过, 正常技能保留', () => {
    const root = path.join(TMP_ROOT, 'husk-root');
    fs.mkdirSync(root, { recursive: true });
    makeSkillDir(root, 'real-skill', true);
    makeSkillDir(root, 'core', false);      // 模拟壳目录(仅 DESCRIPTION.md)
    makeSkillDir(root, 'system', false);

    const registry = loadSkillsFromDir(root, 'builtin');
    const names = Object.keys(registry);
    expect(names).toContain('real-skill');
    expect(names).not.toContain('core');
    expect(names).not.toContain('system');
  });

  test('真实库加载: 无壳目录残留(_builtin/core/system/development/domain/builtin-tools)', () => {
    const skills = loadSkills();
    const husks = ['_builtin', 'builtin-tools', 'core', 'development', 'domain', 'system'];
    expect(skills.map(s => s.name).filter(n => husks.includes(n))).toEqual([]);
  });
});

describe('治理②: 跨根同名去重', () => {
  test('真实库加载: 技能名全局唯一(deep-research/multi-search-engine 双胞胎消除)', () => {
    const skills = loadSkills();
    const seen = new Map();
    for (const s of skills) {
      expect(seen.has(s.name)).toBe(false);
      seen.set(s.name, s.source);
    }
    // 本仓库实测的双胞胎: 内置版带执行器应保留, 全局副本被跳过
    expect(seen.get('deep-research')).toBe('builtin');
  });
});

describe('治理③: 无命中回退改索引模式', () => {
  const skills = loadSkills();

  test('无命中消息注入索引(而非全量正文), 且逐条列出全部能力', () => {
    const r = buildSkillsPromptScoped('xq7zt 完全不存在的词组 q3w9v', skills, {});
    expect(r).toContain('索引模式');
    expect(r).not.toContain('### 使用说明'); // 全量正文的章节标记不出现
    // 能力零回退: 索引仍逐条列出全部技能
    const lineCount = (r.match(/^- /gm) || []).length;
    expect(lineCount).toBe(skills.length);
    // 体积显著小于全量正文
    expect(r.length).toBeLessThan(buildSkillsPrompt(skills).length * 0.6);
  });

  test('索引描述截断(60 字符上限), 索引包含双根路径指引', () => {
    const idx = buildSkillsIndexPrompt(skills);
    expect(idx).toContain('SKILL.md');
    const longDescSkill = skills.find(s => (s.description || '').length > 80);
    if (longDescSkill) {
      const line = idx.split('\n').find(l => l.includes(` ${longDescSkill.name} — `));
      expect(line).toBeTruthy();
      expect(line.length).toBeLessThan(160);
    }
  });

  test('命中场景行为不变(相关技能注入 + 高置信正文内联)', () => {
    const r = buildSkillsPromptScoped('帮我做个季度汇报PPT', skills, {});
    expect(r).not.toContain('索引模式');
    expect(r).toContain('PPT');
  });
});

describe('治理④: 禁用名单在提示词层生效', () => {
  test('getDisabledSkillNames 读取 disabled-skills.json', () => {
    expect(getDisabledSkillNames()).toContain('weather-format');
  });

  test('filterSkillsByContext 过滤禁用技能(合成对象隔离其他过滤条件)', () => {
    const fake = [
      { name: 'weather-format' },            // 禁用名单内 → 剔除
      { name: 'ok-skill' },                  // 正常 → 保留
      { name: 'WEATHER-FORMAT' },            // 大小写变体 → 剔除
    ];
    const filtered = filterSkillsByContext(fake, []);
    expect(filtered.map(s => s.name)).toEqual(['ok-skill']);
  });
});
