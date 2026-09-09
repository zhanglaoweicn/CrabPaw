/**
 * Download CloakBrowser binary to data/cloakbrowser/ for portable deployment.
 * Run once to cache ~400MB so U盘 users don't wait on first launch.
 */
const fs = require('fs');
const path = require('path');
const TARGET_DIR = path.join(__dirname, '..', 'data', 'cloakbrowser');

(async () => {
  process.env.CLOAKBROWSER_CACHE_DIR = TARGET_DIR;
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  const cb = await import('cloakbrowser');
  const info = cb.binaryInfo();

  if (info.installed) {
    console.log(`CloakBrowser already cached: ${info.binaryPath}`);
    process.exit(0);
  }

  console.log(`Downloading CloakBrowser to ${TARGET_DIR} (~400MB)...`);
  await cb.ensureBinary();
  console.log('Download complete. CloakBrowser is now portable.');
})();
