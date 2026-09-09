'use strict';
// B1-5: getSkillsManifestCheck 纯函数直测——mock manifest-registry 断言透传与失败兜底
// (validateSkillManifest 语义=整册清单声明↔目录实况交叉, 非 per-skill; /skills 顶层附加一次)。
// skill-handler 模块级依赖沿用 skill-overview-stats.test.js 的 mock 策略(被测函数外部依赖全部 mock)。

jest.mock('../core/skill-system', () => ({ getRegistry: jest.fn(() => ({})) }));
jest.mock('../core/skill-flow', () => ({
  SkillFlow: class { async initialize() {} async getFlowsAsTools() { return []; } },
}));
jest.mock('../core/skill-lifecycle', () => ({
  getSkillLifecycleManager: jest.fn(() => ({ getSkillSource: () => 'unknown', getSkillDetail: () => null })),
}));
jest.mock('../core/portable-deps', () => ({
  installPipDeps: jest.fn(), installNpmDeps: jest.fn(),
  checkPipDepsInstalled: jest.fn(), getSkillLibDir: jest.fn(() => ''),
}));

// skill-handler 顶层 path.join(DATA_DIR, 'disabled-skills.json') 需要 DATA_DIR 非空
const mockTmpDir = require('os').tmpdir();
jest.mock('../core/config', () => ({ DATA_DIR: mockTmpDir, GLOBAL_SKILLS_DIR: mockTmpDir, DEFAULT_PORT: 38767 }));

jest.mock('../core/skills/manifest-registry', () => ({
  loadSkillManifest: jest.fn(),
  validateSkillManifest: jest.fn(),
}));

const { getSkillsManifestCheck } = require('../handlers/skill-handler');
const { loadSkillManifest, validateSkillManifest } = require('../core/skills/manifest-registry');

describe('getSkillsManifestCheck — 整册清单校验透传(失败不阻断)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('清单有效 → {valid:true, problems:[]} 且透传清单对象', () => {
    const manifest = { bundles: { core: { skills: ['shell-enhance'] } } };
    loadSkillManifest.mockReturnValue(manifest);
    validateSkillManifest.mockReturnValue({ valid: true, problems: [], counts: { bundled: 1, global: 0, declared: 1 } });
    expect(getSkillsManifestCheck()).toEqual({ valid: true, problems: [] });
    expect(validateSkillManifest).toHaveBeenCalledWith(manifest);
  });

  test('校验报问题 → valid:false 且透传 problems', () => {
    loadSkillManifest.mockReturnValue({});
    validateSkillManifest.mockReturnValue({ valid: false, problems: ['清单声明但不存在: ghost'], counts: {} });
    expect(getSkillsManifestCheck()).toEqual({ valid: false, problems: ['清单声明但不存在: ghost'] });
  });

  test('清单文件缺失(loadSkillManifest→null) → 视为通过, 不调校验器', () => {
    loadSkillManifest.mockReturnValue(null);
    expect(getSkillsManifestCheck()).toEqual({ valid: true, problems: [] });
    expect(validateSkillManifest).not.toHaveBeenCalled();
  });

  test('校验器抛异常 → 视为通过(console.warn 告警, 不阻断列表)', () => {
    loadSkillManifest.mockReturnValue({});
    validateSkillManifest.mockImplementation(() => { throw new Error('boom'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getSkillsManifestCheck()).toEqual({ valid: true, problems: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('problems 非数组(形状异常) → 兜底空数组, 不抛', () => {
    loadSkillManifest.mockReturnValue({});
    validateSkillManifest.mockReturnValue({ valid: false, problems: undefined });
    expect(getSkillsManifestCheck()).toEqual({ valid: false, problems: [] });
  });
});
