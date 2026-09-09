// 捕获 React "Rendered more hooks" 错误的完整组件栈（诊断用）
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('hooks') || text.includes('Error')) {
      errors.push(`[console.${msg.type()}] ${text.slice(0, 2000)}`);
    }
  });
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}\n${(err.stack || '').slice(0, 3000)}`);
  });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 60000 }).catch(e => console.log('goto warn:', e.message));
  // 等待启动画面流程（brand→loading→主界面）
  await page.waitForTimeout(12000);
  if (errors.length === 0) console.log('NO HOOK ERRORS CAPTURED');
  else console.log(errors.join('\n\n---\n\n'));
  await browser.close();
})();
