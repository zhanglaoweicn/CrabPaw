'use strict';
// 真实 getSkillsOverviewStats 的单测(不 mock 函数本身)——口径与 handleSkills regStats 一致性守卫。
jest.mock('../core/skill-system', () => ({
  getRegistry: jest.fn(() => ({
    'Fancy-Skill': { name: 'Fancy-Skill', source: 'imported' },   // 大写名 → slug 化 fancy-skill
    tombstone: { name: 'tombstone', source: 'imported' },       // 被禁用
    'builtin-skill': { name: 'builtin-skill', source: 'builtin' },// builtin 恒启用
  })),
}));
jest.mock('../core/skill-flow', () => ({
  SkillFlow: class { async initialize() {} async getFlowsAsTools() { return [{ name: 'flowTool' }]; } },
}));
jest.mock('../core/skill-lifecycle', () => ({ getSkillLifecycleManager: jest.fn(() => ({ getStats: () => ({}) })) }));
// 真实 portable-deps 加载期需 config.BASE_DIR(路径拼接), 而 config mock 仅注入 DATA_DIR——
// portable-deps 属被测函数外部依赖, 一并 mock(与 skill-system/skill-flow 同策略)。
jest.mock('../core/portable-deps', () => ({
  installPipDeps: jest.fn(), installNpmDeps: jest.fn(),
  checkPipDepsInstalled: jest.fn(), getSkillLibDir: jest.fn(() => ''),
}));

// loadDisabledSkills 读 data/.crabpaw/disabled-skills.json(DATA_DIR 拼接)——测试环境用临时文件替换
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skstats-'));
fs.writeFileSync(path.join(tmpDir, 'disabled-skills.json'), JSON.stringify(['tombstone']));

jest.mock('../core/config', () => ({ DATA_DIR: process.env.SKSTATS_DATA_DIR, DEFAULT_PORT: 38767 }));
process.env.SKSTATS_DATA_DIR = tmpDir;

const skillHandler = require('../handlers/skill-handler');

describe('getSkillsOverviewStats 与 handleSkills 口径一致', () => {
  test('slug 化 id 判禁用 + builtin 豁免 + flow 计入 + disabled 计数', async () => {
    const s = await skillHandler.getSkillsOverviewStats();
    expect(s.total).toBe(4);            // 3 registry + 1 flow
    expect(s.active).toBe(3);           // fancy-skill + builtin + flowTool (tombstone 禁用)
    expect(s.disabled).toBe(1);
    expect(s.flowCount).toBe(1);
  });
});
