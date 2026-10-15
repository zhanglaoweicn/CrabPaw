/**
 * image-gen-agnes.test.js — Agnes Image 2.5 Flash Provider(2026-10-09)
 *
 * 锁定: Provider 注册 / 档位映射与官方档位矩阵对齐 / 宽高比反推与吸附 /
 * VALID_SIZES 与 ASPECT_RATIO_TO_SIZE 白名单一致(存量脱节修复) /
 * 配置驱动的 Provider 派发。全部纯逻辑,不发网络请求。
 */

const {
  ImageGenerator,
  IMAGE_GEN_PROVIDERS,
  ASPECT_RATIO_TO_SIZE,
} = require('../core/image-gen');

describe('agnes Provider 注册与配置', () => {
  test('IMAGE_GEN_PROVIDERS 含 agnes,默认模型与端点正确', () => {
    expect(IMAGE_GEN_PROVIDERS.agnes).toBeTruthy();
    expect(IMAGE_GEN_PROVIDERS.agnes.model).toBe('agnes-image-2.5-flash');
    expect(IMAGE_GEN_PROVIDERS.agnes.url).toContain('apihub.agnes-ai.com');
    expect(IMAGE_GEN_PROVIDERS.agnes.maxN).toBe(1);
  });

  test('imageGeneration.provider=agnes 时派发到 agnes(注入 fake key)', () => {
    const gen = new ImageGenerator({
      config: {
        imageGeneration: {
          provider: 'agnes',
          providers: { agnes: { apiKey: 'sk-test-not-real', model: 'agnes-image-2.5-flash' } },
        },
      },
    });
    expect(gen._providerOrder[0]).toBe('agnes');
    expect(gen._hasValidKey('agnes')).toBe(true);
  });

  test('无 key 的 agnes 不参与派发(降级到 doubao 主链)', () => {
    const gen = new ImageGenerator({ config: { imageGeneration: { provider: 'doubao' } } });
    // _getProviderConfig 回退聊天模型 registry,无配置时返回 null(同样 falsy 不派发)
    expect(gen._hasValidKey('agnes')).toBeFalsy();
  });
});

describe('agnes 档位与宽高比映射', () => {
  const gen = new ImageGenerator({ config: {} });

  test('像素尺寸 → 档位与官方档位矩阵对齐', () => {
    expect(gen._agnesSizeToTier('1024x1024')).toBe('1K');
    expect(gen._agnesSizeToTier('1440x1920')).toBe('2K');   // ≈2.8M
    expect(gen._agnesSizeToTier('1920x1920')).toBe('2K');   // ≈3.7M
    expect(gen._agnesSizeToTier('2560x1440')).toBe('2K');   // ≈3.7M(官方 2K 16:9≈3.9M)
    expect(gen._agnesSizeToTier('3936x2208')).toBe('3K');   // 官方 3K 16:9 样例
    expect(gen._agnesSizeToTier('4096x4096')).toBe('4K');   // ≈16.8M
  });

  test('显式 aspectRatio 直接透传', () => {
    expect(gen._agnesRatioFromSize('1024x1024', '16:9')).toBe('16:9');
  });

  test('无显式比例: 精确命中 ASPECT_RATIO_TO_SIZE 反查', () => {
    expect(gen._agnesRatioFromSize('1440x1920')).toBe('3:4');
    expect(gen._agnesRatioFromSize('1920x1440')).toBe('4:3');
    expect(gen._agnesRatioFromSize('2560x1097')).toBe('21:9');
  });

  test('无精确映射时按比值吸附最近受支持比例', () => {
    expect(gen._agnesRatioFromSize('1080x1920')).toBe('9:16');
    expect(gen._agnesRatioFromSize('1024x1024')).toBe('1:1');
    // 1280x1280 不在 ASPECT_RATIO_TO_SIZE 值集,但比值 1:1 → 吸附 1:1
    expect(gen._agnesRatioFromSize('1280x1280')).toBe('1:1');
  });

  test('白名单覆盖全部 ASPECT_RATIO_TO_SIZE 映射值(存量脱节修复)', () => {
    const { VALID_SIZES } = require('../core/image-gen');
    for (const [ratio, size] of Object.entries(ASPECT_RATIO_TO_SIZE)) {
      expect(VALID_SIZES.has(size)).toBe(true);
      // 语句级守卫: 失败时报出是哪个比例脱节
      if (!VALID_SIZES.has(size)) throw new Error(`比例 ${ratio} 的映射尺寸 ${size} 不在 VALID_SIZES`);
    }
  });
});
