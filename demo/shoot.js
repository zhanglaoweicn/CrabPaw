const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const url = 'file:///' + path.resolve(__dirname, 'boss-homepage.html').replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const out = __dirname;

  // after mode (default)
  await page.screenshot({ path: path.join(out, 'shot-after.png'), fullPage: true });

  // switch to before
  await page.click('button[data-mode="before"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, 'shot-before.png'), fullPage: true });

  // both
  await page.click('button[data-mode="both"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, 'shot-both.png'), fullPage: true });

  // back to after, interact: choose customer scenario + click a chip
  await page.click('button[data-mode="after"]');
  await page.waitForTimeout(200);
  const scenBtns = await page.$$('.scen');
  if (scenBtns[1]) await scenBtns[1].click();
  await page.waitForTimeout(150);
  const chips = await page.$$('.chip');
  if (chips[0]) await chips[0].click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'shot-after-interact.png'), fullPage: true });

  // gather diagnostics: page load errors, overlap of note vs content, blankness
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const w = doc.scrollWidth;
    const h = doc.scrollHeight;
    const hasWin = !!document.querySelector('.win');
    const chipCount = document.querySelectorAll('.chip').length;
    const inputVisible = !!document.querySelector('.input-row input');
    return { w, h, hasWin, chipCount, inputVisible };
  });
  console.log(JSON.stringify({ errs, metrics }, null, 2));
  await browser.close();
})().catch(e => { console.error('SHOOT_FAIL', e); process.exit(1); });
