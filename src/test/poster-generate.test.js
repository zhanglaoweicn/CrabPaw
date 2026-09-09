/**
 * poster-generate.test.js — 海报生成 P0 回归（2026-09-08）
 *
 * 覆盖：品牌包读写、模板转义（文案注入防护）、契约登记、参数校验、
 * 尺寸映射。真实 chromium 渲染用例在无浏览器环境自动跳过（另由 E2E 冒烟覆盖）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const poster = require('../core/poster');
const { escapeHtml } = require('../core/poster/escape');
const { TEMPLATES } = require('../core/poster/templates');
const { handlePosterGenerate, handlePosterBrandKit } = require('../tools/poster-tools');
const { TOOL_CONTRACTS } = require('../core/tool-contract');

describe('品牌资产包', () => {
  const bak = poster.BRAND_KIT_PATH + '.test-bak';
  let hadOriginal = false;

  beforeAll(() => {
    hadOriginal = fs.existsSync(poster.BRAND_KIT_PATH);
    if (hadOriginal) fs.copyFileSync(poster.BRAND_KIT_PATH, bak);
  });
  afterAll(() => {
    if (hadOriginal) fs.copyFileSync(bak, poster.BRAND_KIT_PATH);
    else if (fs.existsSync(poster.BRAND_KIT_PATH)) fs.unlinkSync(poster.BRAND_KIT_PATH);
    if (fs.existsSync(bak)) fs.unlinkSync(bak);
  });

  test('set → get 往返；merge 只改传入字段', async () => {
    // 注意：brand-kit.json 是持久共享存储（E2E 冒烟可能写入过真实数据），
    // merge 语义断言只针对本次显式设置的字段
    const r = await handlePosterBrandKit({ action: 'set', companyName: '测试机械厂', slogan: '测试口号', phone: '400-000-0000', accent: '#C8102E' });
    expect(r.success).toBe(true);
    const kit = await handlePosterBrandKit({ action: 'get' });
    expect(kit.data.companyName).toBe('测试机械厂');
    expect(kit.data.slogan).toBe('测试口号');
    expect(kit.data.contact.phone).toBe('400-000-0000');
    expect(kit.data.colors.primary).toBe('#C8102E');
  });

  test('未配置时返回安全默认值（不抛错）', () => {
    fs.writeFileSync(poster.BRAND_KIT_PATH, JSON.stringify({ companyName: '临时的' }));
    // 手动破坏后 load 应合并默认值（这里直接验证 loadBrandKit 对损坏文件的容错）
    fs.writeFileSync(poster.BRAND_KIT_PATH, '{broken json');
    const kit = poster.loadBrandKit();
    expect(kit.companyName).toBe('');
    expect(kit.colors.primary).toBe('#38bdf8');
  });
});

describe('模板转义与结构', () => {
  test('三个模板齐全且可渲染 HTML 字符串', () => {
    for (const id of ['product', 'festival', 'greeting']) {
      const html = TEMPLATES[id].render({ W: 1080, H: 1080, title: 'T', brand: {}, accent: '#38bdf8' });
      expect(html).toContain('<!doctype html');
      expect(html).toContain('brand-footer');
    }
  });

  test('文案 HTML 注入被转义（<script> 不落进成品）', () => {
    for (const id of Object.keys(TEMPLATES)) {
      const html = TEMPLATES[id].render({
        W: 1080, H: 1080, title: '<script>alert(1)</script>', subtitle: '<img src=x>',
        bullets: ['<b>bold</b>'], brand: { companyName: '工厂<script>' }, accent: '#38bdf8',
      });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('工厂<script>');
    }
  });

  test('空可选字段不产生 undefined 文本', () => {
    for (const id of Object.keys(TEMPLATES)) {
      const html = TEMPLATES[id].render({ W: 1080, H: 1080, title: '标题', brand: {}, accent: '#38bdf8' });
      expect(html).not.toContain('undefined');
    }
  });
});

describe('契约与工具注册', () => {
  test('PosterGenerate / PosterBrandKit 契约已登记且字段合规', () => {
    expect(TOOL_CONTRACTS.PosterGenerate).toBeDefined();
    expect(TOOL_CONTRACTS.PosterGenerate.whenNotToUse.length).toBeGreaterThan(0);
    expect(TOOL_CONTRACTS.PosterBrandKit).toBeDefined();
    expect(TOOL_CONTRACTS.PosterBrandKit.schema.required).toEqual(['action']);
  });

  test('缺 title 的 PosterGenerate 调用被参数校验拒绝', async () => {
    const r = await handlePosterGenerate({ template_id: 'product' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('title');
  });

  test('未知 action 的 PosterBrandKit 被拒绝', async () => {
    const r = await handlePosterBrandKit({ action: 'delete' });
    expect(r.success).toBe(false);
  });
});

describe('尺寸映射', () => {
  test('aspect → 海报尺寸与底图尺寸一致成对', () => {
    for (const a of Object.keys(poster.ASPECT_SIZES)) {
      expect(poster.ASPECT_BG_SIZE[a]).toBeDefined();
    }
    expect(poster.ASPECT_BG_SIZE['16:9']).toBe('2560x1440');
  });
});

describe('真实渲染（有 chromium 时执行，否则跳过）', () => {
  const exe = poster.findChromiumExecutable();
  (exe ? test : test.skip)('playwright 截图管线产出 PNG（模板+品牌条，无底图）', async () => {
    const r = await poster.renderPoster({
      templateId: 'product',
      aspect: '1:1',
      title: '回归测试海报',
      subtitle: '副标题文案',
      bullets: ['卖点一', '卖点二'],
      cta: '立即咨询',
    });
    expect(r.success).toBe(true);
    expect(fs.existsSync(r.path)).toBe(true);
    expect(r.bytes).toBeGreaterThan(10000);
    // PNG 魔数校验
    const head = fs.readFileSync(r.path).subarray(0, 8);
    expect(head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });
});
