/**
 * skills-manifest-registry.test.js — 技能清单收编面（Phase 3d）
 */
const { validateSkillManifest, listSkillsFlat } = require('../core/skills/manifest-registry');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkSkillDir(root, name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`, 'utf8');
}

describe('skills manifest-registry（清单面 + 一致性校验）', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-reg-'));
    mkSkillDir(tmp, 'bilibili-knowledge');
    mkSkillDir(tmp, 'core-tech');
  });

  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp */ } });

  test('声明↔目录一致 → valid', () => {
    const manifest = { bundles: { core: { skills: ['bilibili-knowledge'] } }, noExecutor: ['core-tech'] };
    const r = validateSkillManifest(manifest, { skillsDir: tmp, globalSkillsDir: path.join(tmp, 'noexists') });
    expect(r.valid).toBe(true);
    expect(r.counts.declared).toBe(2);
  });

  test('清单声明但不存在 → 点名问题', () => {
    const manifest = { bundles: { x: { skills: ['ghost-skill', 'bilibili-knowledge'] } }, noExecutor: [] };
    const r = validateSkillManifest(manifest, { skillsDir: tmp, globalSkillsDir: tmp });
    expect(r.valid).toBe(false);
    expect(r.problems.join(' ')).toContain('ghost-skill');
  });

  test('目录存在未声明 → 告警清单面（自由技能补充视角）', () => {
    const manifest = { bundles: { core: { skills: [] } }, noExecutor: [] };
    const r = validateSkillManifest(manifest, { skillsDir: tmp, globalSkillsDir: tmp });
    expect(r.problems.some((p) => p.startsWith('未声明技能'))).toBe(true);
  });

  test('缺失清单文件 → 显式 invalid（不会误报为干净）', () => {
    const r = validateSkillManifest(null, { skillsDir: tmp, globalSkillsDir: tmp });
    expect(r.valid).toBe(false);
    expect(r.problems[0]).toContain('不存在');
  });

  test('listSkillsFlat 扁平化（bundle/noExecutor 标注）', () => {
    const manifest = {
      bundles: { core: { skills: ['a'] } },
      noExecutor: ['b'],
    };
    const flat = listSkillsFlat(manifest);
    expect(flat).toHaveLength(2);
    expect(flat.find((s) => s.name === 'a')).toMatchObject({ bundle: 'core', noExecutor: false });
    expect(flat.find((s) => s.name === 'b')).toMatchObject({ noExecutor: true });
  });
});
