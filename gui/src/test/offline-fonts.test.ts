/**
 * offline-fonts.test.js — UI 字体离线化回归（2026-09-30 离线地基修复）
 *
 * 背景：CrabPaw 面向"买 U 盘、不装环境、随身离线"的用户。此前 `gui/src/index.css`
 * 用 `@import url('https://fonts.googleapis.com/...')` 取 Inter，且仓库无本地字体文件：
 *   - 无网/内网下要等网络连接超时才回落系统字体 → 首屏被网络可用性绑架
 *   - 字体异步到达 → 数字先以系统字体渲染再跳变（FOUT），而数字是老板最看重的部分
 *   - CSP 为此放行 fonts.googleapis.com / fonts.gstatic.com，等于给外网留门
 *
 * 现改为自托管 woff2 子集（gui/src/assets/fonts/，由 scripts/fetch-inter-fonts.js 生成）。
 * 本用例锁住：**CSS/HTML 不得再引入外网字体，本地字体文件必须存在且被正确声明**。
 *
 * 注意：CSP 的注释里会出现 "fonts.googleapis.com" 字样（解释为何移除），因此断言
 * 只检查 CSP 指令行，不检查注释——避免把说明文字误判成违规。
 */
const fs = require('fs');
const path = require('path');

// vitest 下 __dirname = gui/src/test，故 GUI 根是再往上一层（此前多退一级，路径变成 gui/gui/…）
const GUI = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(GUI, p), 'utf8');

describe('UI 字体离线化（U 盘运行前提）', () => {
  test('index.css 不再有指向外网的 @import', () => {
    const css = read('src/index.css');
    const externalImports = [...css.matchAll(/@import\s+url\(\s*['"]?(https?:)?\/\//g)];
    expect(externalImports).toEqual([]);
    expect(css).not.toMatch(/@import\s+url\(\s*['"]?https:\/\/fonts\.googleapis\.com/);
  });

  test('index.css 改为引入本地字体片段', () => {
    expect(read('src/index.css')).toMatch(/@import\s+['"]\.\/assets\/fonts\.css['"]/);
  });

  test('本地字体文件存在且是合法 woff2', () => {
    const dir = path.join(GUI, 'src', 'assets', 'fonts');
    expect(fs.existsSync(dir)).toBe(true);
    const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.woff2'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      // woff2 魔数 'wOF2'
      expect(buf.subarray(0, 4).toString('ascii')).toBe('wOF2');
      expect(buf.length).toBeGreaterThan(1000);
    }
    // 单份可变字体即可覆盖 UI 字重；出现按字重拆分的多份文件说明下载方式退化（浪费体积）
    const staticSplits = files.filter((f: string) => /-(\d{3})\.woff2$/.test(f));
    expect(staticSplits).toEqual([]);
  });

  test('生成的 @font-face 只指向本地相对路径，并声明可变字重区间', () => {
    const css = read('src/assets/fonts.css');
    expect(css).toMatch(/font-family:\s*'Inter'/);
    expect(css).toMatch(/font-weight:\s*400\s+600/); // 可变字体轴区间
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^['"]?\.\/fonts\//);       // 本地相对路径
      expect(u).not.toMatch(/https?:\/\//);          // 绝不允许外网
    }
  });

  test('index.html 预取本地字体（首帧即正确字体），且无外网字体引用', () => {
    const html = read('index.html');
    expect(html).toMatch(/rel="preload"[\s\S]{0,120}as="font"/);
    const fontLinks = [...html.matchAll(/<link[^>]*as="font"[^>]*>/g)].map((m) => m[0]);
    expect(fontLinks.length).toBeGreaterThan(0);
    for (const l of fontLinks) {
      expect(l).toContain('./src/assets/fonts/');
      expect(l).not.toMatch(/https?:\/\//);
    }
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  test('CSP 指令不再放行外网字体（注释里的说明文字不算）', () => {
    const ts = fs.readFileSync(path.join(GUI, 'electron', 'main', 'index.ts'), 'utf8');
    // 只看 CSP 指令行（形如 "font-src ..." / "style-src ..." 的数组元素）
    const cspDirectiveLines = ts.split(/\r?\n/).filter((l: string) => /^\s*["'](default-src|script-src|style-src|font-src|connect-src|img-src|media-src|frame-src) /.test(l));
    expect(cspDirectiveLines.length).toBeGreaterThan(0);
    const offenders = cspDirectiveLines.filter((l: string) => /fonts\.(googleapis|gstatic)\.com/.test(l));
    expect(offenders).toEqual([]);
    // font-src 必须显式存在且只允许本地/内联数据
    const fontSrc = cspDirectiveLines.filter((l: string) => /font-src/.test(l));
    expect(fontSrc.length).toBeGreaterThan(0);
    for (const l of fontSrc) expect(l).toMatch(/'self'/);
  });
});
