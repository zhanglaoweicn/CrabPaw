/**
 * poster/index.js — 海报渲染引擎（P0）
 *
 * 双层渲染：底层 Seedream AI 底图（可选）+ 上层 HTML 模板确定性排版 → playwright 截图 PNG。
 * 产品保真红线：产品照片原样合成，AI 不重绘产品本体。
 *
 * 用法（经 tools/poster-tools.js 的 PosterGenerate / PosterBrandKit 工具，或程序化）：
 *   renderPoster({ templateId, aspect, title, subtitle, bullets, price, cta,
 *                  bgImagePath?, productImagePath?, brandOverride?, outPath? })
 *   loadBrandKit() / saveBrandKit(data)
 */
const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('./escape');
const { TEMPLATES } = require('./templates');

// 2026-09-08: DATA_DIR 单源化——本模块在 src/core/poster/ 下，需上溯三级到仓库根
// （此前少一层导致产物写进 src/data/，实测冒烟抓包）
const { DATA_DIR } = require('../config');
const BRAND_KIT_PATH = path.join(DATA_DIR, '..', 'workspace', 'brand-kit.json');
const POSTER_OUTPUT_DIR = path.join(DATA_DIR, '..', 'workspace', 'posters');

// ─── 尺寸：aspect → [W, H]（≥1920 短边满足 Seedream 最低像素约束）───
const ASPECT_SIZES = {
  '1:1': [1080, 1080],
  '9:16': [1080, 1920],
  '16:9': [1920, 1080],
  '3:4': [1080, 1440],
  '4:3': [1440, 1080],
};
// 底图生成用的更高分辨率（AI 底图按此出图，排版层缩放使用）
const ASPECT_BG_SIZE = {
  '1:1': '2048x2048',
  '9:16': '1440x2560',
  '16:9': '2560x1440',
  '3:4': '1440x1920',
  '4:3': '1920x1440',
};
const ACCENTS = { product: '#38bdf8', festival: '#e8b64c', greeting: '#6fb3ff' };

// ─── 品牌资产包 ───
const BRAND_DEFAULTS = {
  companyName: '', slogan: '', logo: '',
  colors: { primary: '#38bdf8' },
  contact: { phone: '', address: '', wechat: '' },
};

function loadBrandKit() {
  try {
    const raw = JSON.parse(fs.readFileSync(BRAND_KIT_PATH, 'utf-8'));
    return {
      ...BRAND_DEFAULTS,
      ...raw,
      colors: { ...BRAND_DEFAULTS.colors, ...(raw.colors || {}) },
      contact: { ...BRAND_DEFAULTS.contact, ...(raw.contact || {}) },
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(BRAND_DEFAULTS));
  }
}

function saveBrandKit(data) {
  const merged = { ...loadBrandKit(), ...(data || {}) };
  merged.colors = { ...loadBrandKit().colors, ...((data || {}).colors || {}) };
  merged.contact = { ...loadBrandKit().contact, ...((data || {}).contact || {}) };
  fs.mkdirSync(path.dirname(BRAND_KIT_PATH), { recursive: true });
  const tmp = BRAND_KIT_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, BRAND_KIT_PATH);
  return loadBrandKit();
}

function listTemplates() {
  return Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label }));
}

// ─── 图片 → data URL（截图页内嵌，规避 file:// 权限与路径问题）───
function toDataUrl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// ─── Chromium 可执行文件探测（playwright-core 无浏览器下载时用系统/缓存二进制）───
function findChromiumExecutable() {
  if (process.env.POSTER_CHROMIUM_PATH) return process.env.POSTER_CHROMIUM_PATH;
  const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const root = path.join(localAppData, 'ms-playwright');
  try {
    const dirs = fs.readdirSync(root)
      .filter(d => d.startsWith('chromium-'))
      .map(d => ({ d, mtime: fs.statSync(path.join(root, d)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { d } of dirs) {
      for (const rel of ['chrome-win\\chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
        const p = path.join(root, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) { /* 无缓存浏览器 */ }
  return null;
}

let _browserPromise = null;
async function getBrowser() {
  if (_browserPromise) return _browserPromise;
  _browserPromise = (async () => {
    let pw;
    try { pw = require('playwright-core'); } catch (e) {
      throw new Error('playwright-core 不可用：npm install playwright-core');
    }
    const executablePath = findChromiumExecutable();
    const launchOpts = { headless: true };
    if (executablePath) launchOpts.executablePath = executablePath;
    return pw.chromium.launch(launchOpts);
  })();
  // 失败时清缓存以便下次重试
  _browserPromise.catch(() => { _browserPromise = null; });
  return _browserPromise;
}

async function closeBrowser() {
  if (!_browserPromise) return;
  try { const b = await _browserPromise; await b.close(); } catch { /* 已关闭 */ }
  _browserPromise = null;
}

// ─── 主渲染 ───
async function renderPoster(opts = {}) {
  const templateId = TEMPLATES[opts.templateId] ? opts.templateId : 'product';
  const template = TEMPLATES[templateId];
  const aspect = ASPECT_SIZES[opts.aspect] ? opts.aspect : '1:1';
  const [W, H] = ASPECT_SIZES[aspect];
  const accent = (opts.brandOverride && opts.brandOverride.accent) || ACCENTS[templateId] || '#38bdf8';

  const brand = { ...loadBrandKit(), ...(opts.brandOverride || {}) };
  const bgDataUrl = toDataUrl(opts.bgImagePath);
  const productDataUrl = toDataUrl(opts.productImagePath);

  const html = template.render({
    W, H,
    title: opts.title || '',
    subtitle: opts.subtitle || '',
    bullets: Array.isArray(opts.bullets) ? opts.bullets.filter(Boolean).slice(0, 4) : [],
    price: opts.price || '',
    cta: opts.cta || '',
    brand,
    bgDataUrl,
    productDataUrl,
    accent,
  });

  fs.mkdirSync(POSTER_OUTPUT_DIR, { recursive: true });
  const outPath = opts.outPath || path.join(POSTER_OUTPUT_DIR, `poster_${templateId}_${Date.now()}.png`);

  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(250); // 字体/图片解码稳定
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: W, height: H } });
  } finally {
    await page.close().catch(() => {});
  }
  const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  return { success: true, path: outPath, width: W, height: H, bytes: size, templateId, aspect };
}

module.exports = {
  renderPoster,
  loadBrandKit,
  saveBrandKit,
  listTemplates,
  toDataUrl,
  findChromiumExecutable,
  closeBrowser,
  ASPECT_SIZES,
  ASPECT_BG_SIZE,
  BRAND_KIT_PATH,
  POSTER_OUTPUT_DIR,
};
