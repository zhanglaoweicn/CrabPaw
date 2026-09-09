/**
 * patch-playwright-electron.js — 修复 playwright 与 Electron 28 的启动兼容性
 *
 * 根因（2026-08-14 诊断）：
 *   Electron 28 的 Windows electron.exe 启动器只转发 app 路径之后的 Chromium 开关；
 *   而 playwright-core 硬编码把 `--remote-debugging-port=0` 放在参数最前 →
 *   electron.exe 报 "bad option: --remote-debugging-port=0"，Electron e2e 全部无法启动。
 *
 * 修复方式（Electron 官方推荐）：
 *   1. electron.js:  不再传 `--remote-debugging-port=0` 命令行参数（避免 electron.exe 拒绝）
 *   2. loader.js:    splice 标记改用 Electron 28 认识的 `--inspect=0`，
 *                    并用 app.commandLine.appendSwitch('remote-debugging-port', '0')
 *                    在主进程 ready 前注入该开关（loader 恰好运行在 ready 前）
 *
 * 用法：node scripts/patch-playwright-electron.js   （npm install 后重跑即可）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_JS = path.join(ROOT, 'node_modules', 'playwright-core', 'lib', 'server', 'electron', 'electron.js');
const LOADER_JS = path.join(ROOT, 'node_modules', 'playwright-core', 'lib', 'server', 'electron', 'loader.js');

let changed = 0;

function patch(file, from, to, desc) {
  if (!fs.existsSync(file)) {
    console.warn(`[patch] SKIP ${desc}: ${path.relative(ROOT, file)} 不存在`);
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes(to)) {
    console.log(`[patch] OK (already): ${desc}`);
    return;
  }
  if (!src.includes(from)) {
    console.error(`[patch] FAIL ${desc}: 未找到目标片段，文件可能已随版本变化。`);
    console.error(`  期望片段: ${from.slice(0, 80)}...`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(file, src.replace(from, to), 'utf8');
  changed++;
  console.log(`[patch] DONE: ${desc}`);
}

// 1. electron.js: 去掉 --remote-debugging-port=0（由 loader appendSwitch 注入）
patch(
  ELECTRON_JS,
  `      // --remote-debugging-port=0 must be the last playwright's argument, loader.ts relies on it.
      let electronArguments = ['--inspect=0', '--remote-debugging-port=0', ...args];`,
  `      // --remote-debugging-port=0 must be the last playwright's argument, loader.ts relies on it.
      // (CrabPaw patch: Electron 28 拒绝路径前 Chromium 开关——remote-debugging-port 改由 loader.js
      //  app.commandLine.appendSwitch 注入,见 scripts/patch-playwright-electron.js)
      let electronArguments = ['--inspect=0', ...args];`,
  'electron.js 去 remote-debugging-port 命令行参数'
);

// 2. loader.js: splice 标记改 --inspect=0 + appendSwitch 注入
patch(
  LOADER_JS,
  `// [Electron, -r, loader.js[, --no-sandbox>], --inspect=0, --remote-debugging-port=0, ...args]
process.argv.splice(1, process.argv.indexOf('--remote-debugging-port=0'));`,
  `// [Electron, -r, loader.js[, --no-sandbox>], --inspect=0, ...args]
// (CrabPaw patch: Electron 28 不认路径前 --remote-debugging-port=0,标记改用 --inspect=0)
process.argv.splice(1, process.argv.indexOf('--inspect=0'));`,
  'loader.js splice 标记改 --inspect=0'
);

patch(
  LOADER_JS,
  `for (const arg of chromiumSwitches) {
  const match = arg.match(/--([^=]*)=?(.*)/);
  app.commandLine.appendSwitch(match[1], match[2]);
}`,
  `for (const arg of chromiumSwitches) {
  const match = arg.match(/--([^=]*)=?(.*)/);
  app.commandLine.appendSwitch(match[1], match[2]);
}
// (CrabPaw patch: Electron 28 需在主进程注入 remote-debugging-port——官方 appendSwitch 方式)
app.commandLine.appendSwitch('remote-debugging-port', '0');`,
  'loader.js appendSwitch 注入 remote-debugging-port'
);

console.log(`[patch] 完成, 修改 ${changed} 个文件${process.exitCode ? '（有失败）' : ''}`);
