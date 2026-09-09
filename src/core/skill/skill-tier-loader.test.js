/**
 * P1-8: SkillsList 静态清单漂移测试（2026-08-15）
 *
 * 修复前 getBundledSkills() 直接返回 manifest.json 的 51 个静态技能名,
 * 与 SKILL.md 自动发现(~290 个)严重漂移。修复后:
 *  - 非打包模式清单运行时从 skill-system 发现结果生成
 *  - manifest 保留作兜底(发现失败时降级并 warn)
 * 本组测试锁定: 发现结果与清单一致性(发现清单 ⊇ manifest 静态清单)。
 *
 * 2026-08-18 复盘清理: data/skills 下 330 个 testdraftskill 测试草稿被删
 * (此前它们被计入发现注册表, 使计数虚高到 ~405), 真实技能 75 个。
 * 阈值从 100 下调为 60 —— 仍远大于静态 51, 且不再依赖草稿污染。
 */

const fs = require('fs');
const path = require('path');

const tierLoader = require('./skill-tier-loader');

describe('SkillTierLoader P1-8 清单漂移修复', () => {
  test('getDiscoveredSkillNames 返回运行时发现清单', () => {
    const names = tierLoader.getDiscoveredSkillNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(60); // 远大于静态 51(2026-08-18 清理草稿后 75 个真实技能)
  });

  test('发现清单覆盖 manifest 静态清单(无缺漏)', () => {
    const manifestPath = path.join(__dirname, '../../../skills/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifestNames = new Set();
    for (const bundle of Object.values(manifest.bundles || {})) {
      for (const skill of bundle.skills || []) manifestNames.add(skill);
    }

    // 一致性断言: manifest 中真实存在 SKILL.md 的技能必须全部出现在发现清单里。
    // 注意 manifest 里存在 4 个只有 DESCRIPTION.md 的历史幽灵条目
    // (system/core/development/productivity),SKILL.md 发现正确地排除了它们。
    const skillsDir = path.join(__dirname, '../../../skills');
    const realNames = [...manifestNames].filter(
      n => fs.existsSync(path.join(skillsDir, n, 'SKILL.md'))
    );

    const discovered = tierLoader.getDiscoveredSkillNames();
    expect(discovered).not.toBeNull();
    const missing = realNames.filter(n => !discovered.includes(n));
    expect(missing).toEqual([]);
  });

  test('getBundledSkills 在 dev 模式返回发现清单(非 51 静态)', () => {
    const prev = process.env.CRABPAW_MODE;
    process.env.CRABPAW_MODE = 'electron-dev';
    try {
      const bundled = tierLoader.getBundledSkills();
      expect(bundled.length).toBeGreaterThan(60); // 2026-08-18 清理草稿后 75 个真实技能
    } finally {
      if (prev === undefined) delete process.env.CRABPAW_MODE;
      else process.env.CRABPAW_MODE = prev;
    }
  });

  test('isSkillAvailable 基于发现清单判断', () => {
    const prev = process.env.CRABPAW_MODE;
    process.env.CRABPAW_MODE = 'electron-dev';
    try {
      const discovered = tierLoader.getDiscoveredSkillNames();
      expect(tierLoader.isSkillAvailable(discovered[0])).toBe(true);
      expect(tierLoader.isSkillAvailable('__no_such_skill_xyz__')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CRABPAW_MODE;
      else process.env.CRABPAW_MODE = prev;
    }
  });
});
