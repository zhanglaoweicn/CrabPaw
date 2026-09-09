'use strict';
const { resolveActiveProfile, profileManifest } = require('../core/plugin/plugin-manager');

describe('resolveActiveProfile', () => {
  test('env CRABPAW_PROFILE 优先', () => {
    process.env.CRABPAW_PROFILE = 'headless';
    expect(resolveActiveProfile({})).toBe('headless');
    delete process.env.CRABPAW_PROFILE;
  });
  test('无 env 且无显式 → server(默认全量, 兼容现状)', () => {
    expect(resolveActiveProfile({})).toBe('server');
  });
  test('显式 profile 参数 > env', () => {
    process.env.CRABPAW_PROFILE = 'headless';
    expect(resolveActiveProfile({ profile: 'desktop' })).toBe('desktop');
    delete process.env.CRABPAW_PROFILE;
  });
});

describe('profileManifest', () => {
  const full = {
    builtin: { stock: {}, weather: {}, typhoon: {} },
    bundled: { docx: {}, pptx: {} },
    user: { myplugin: {} },
  };

  test('未配置 profiles → 返回全量(现状无变化)', () => {
    const out = profileManifest({}, 'server', full);
    expect(out).toEqual(full);
  });

  test('profile 未键控的层保持全量, 键控层只列清单内插件(缩编不增编)', () => {
    const cfg = { plugins: { profiles: { desktop: { builtin: ['stock', 'weather'] } } } };
    const out = profileManifest(cfg, 'desktop', full);
    expect(out.builtin).toEqual({ stock: {}, weather: {} });
    expect(out.bundled).toEqual(full.bundled);
    expect(out.user).toEqual(full.user);
  });

  test('键控层空数组 → 该层清空(缩编到零)', () => {
    const cfg = { plugins: { profiles: { headless: { bundled: [] } } } };
    const out = profileManifest(cfg, 'headless', full);
    expect(out.bundled).toEqual({});
    expect(out.builtin).toEqual(full.builtin);
  });

  test('引用不存在的插件名 → throw 点名', () => {
    const cfg = { plugins: { profiles: { desktop: { builtin: ['stock', 'ghost'] } } } };
    expect(() => profileManifest(cfg, 'desktop', full)).toThrow(/profile desktop 引用了不存在的 builtin 插件: ghost/);
  });

  test('显式 pluginCfg 层且 profile 未键控该层 → 保留显式(现有优先级)', () => {
    const cfg = { plugins: { builtin: { stock: {} }, profiles: { desktop: { bundled: ['docx'] } } } };
    const out = profileManifest(cfg, 'desktop', full);
    expect(out.builtin).toEqual({ stock: {} }); // 显式优先, 未键控不缩编
    expect(out.bundled).toEqual({ docx: {} }); // 键控层覆盖
    expect(out.user).toEqual(full.user);
  });

  test('兼容 pluginCfg 形态传入(config.profiles 直读)', () => {
    const cfg = { profiles: { headless: { user: ['myplugin'] } } };
    const out = profileManifest(cfg, 'headless', full);
    expect(out.user).toEqual({ myplugin: {} });
    expect(out.builtin).toEqual(full.builtin);
  });
});
