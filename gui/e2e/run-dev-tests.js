/**
 * CrabPaw E2E 测试启动脚本（开发版）
 *
 * 用法: node e2e/run-dev-tests.js [playwright args...]
 *
 * 流程:
 *   1. 确保 Electron 主进程已构建 (dist-electron/)
 *   2. 启动 Vite dev server（仅 web，不启动 Electron — 使用 vite.test.config.ts）
 *   3. 运行 Playwright E2E 测试（Playwright 自己启动 Electron 连接 dev server）
 *   4. 测试结束后自动关闭 dev server
 *
 * 对比直接用 npx playwright test:
 *   - test:e2e       → 使用预构建的 dist/，无需 dev server
 *   - test:e2e:dev   → 使用 Vite dev server（支持 HMR），适合开发时反复测试
 */
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

const DEV_SERVER_URL = 'http://localhost:5173'
const MAX_WAIT_MS = 60_000
const CHECK_INTERVAL_MS = 1000

const playwrightArgs = process.argv.slice(2)
const projectRoot = path.resolve(__dirname, '..')

function checkDevServer() {
  return new Promise((resolve) => {
    const req = http.get(DEV_SERVER_URL, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(3000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * 确保 Electron 主进程已构建
 * vite-plugin-electron 在 vite build 时构建主进程到 dist-electron/
 */
function ensureMainProcessBuilt() {
  const distElectronMain = path.join(projectRoot, 'dist-electron', 'main', 'index.js')
  // 2026-08-14: 检查新鲜度——主进程源码(electron/main/*.ts)比 dist 新则需重建
  // (旧逻辑只看文件存在,源码改动后 e2e 仍跑旧产物,CDP 端口等新特性不生效)
  const srcMain = path.join(projectRoot, 'electron', 'main', 'index.ts')
  let stale = false
  if (fs.existsSync(distElectronMain) && fs.existsSync(srcMain)) {
    const distTime = fs.statSync(distElectronMain).mtimeMs
    const srcTime = fs.statSync(srcMain).mtimeMs
    stale = srcTime > distTime
  }
  if (fs.existsSync(distElectronMain) && !stale) {
    console.log('[e2e] ✓ Electron 主进程已构建')
    return
  }
  if (stale) console.log('[e2e] Electron 主进程源码有更新，重新构建...')

  console.log('[e2e] Electron 主进程未构建，执行 vite build...')
  try {
    execSync('npx vite build', {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { ...process.env },
    })
    console.log('[e2e] ✓ Electron 主进程构建完成')
  } catch (e) {
    console.error('[e2e] ✗ 主进程构建失败，请先手动运行 npm run dev 构建一次')
    process.exit(1)
  }
}

/**
 * 启动 Vite dev server（仅 web，不启动 Electron）
 * 使用 vite.test.config.ts，不含 vite-plugin-electron
 */
async function startViteDevServer() {
  // 先检查是否已有 dev server 在运行
  if (await checkDevServer()) {
    console.log('[e2e] ✓ Vite dev server 已在运行')
    return null
  }

  console.log('[e2e] 启动 Vite dev server（仅 web，不启动 Electron）...')
  const viteProcess = spawn('npx', [
    'vite',
    '--config', 'vite.test.config.ts',
  ], {
    shell: true,
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let viteOutput = ''
  viteProcess.stdout.on('data', (data) => {
    const text = data.toString()
    viteOutput += text
    if (text.includes('ready') || text.includes('Local') || text.includes('VITE')) {
      process.stdout.write('[vite] ' + text)
    }
  })
  viteProcess.stderr.on('data', (data) => {
    const text = data.toString()
    if (text.includes('error') || text.includes('Error')) {
      process.stderr.write('[vite] ' + text)
    }
  })

  // 等待 dev server 就绪
  const startTime = Date.now()
  while (Date.now() - startTime < MAX_WAIT_MS) {
    if (await checkDevServer()) {
      console.log(`[e2e] ✓ Vite dev server 就绪 (耗时 ${(Date.now() - startTime) / 1000}s)`)
      return viteProcess
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS))
  }

  // 超时
  try { viteProcess.kill() } catch (_) {}
  console.error('[e2e] ✗ Vite dev server 启动超时!')
  console.error('[e2e] 输出:\n' + viteOutput.slice(-2000))
  process.exit(1)
}

/**
 * 检查后端是否已运行 (127.0.0.1:38767)
 */
function checkBackend() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:38767/api/identity', (res) => {
      res.resume()
      resolve(true)  // 任何响应(含 401)都说明服务活着
    })
    req.on('error', () => resolve(false))
    req.setTimeout(3000, () => { req.destroy(); resolve(false) })
  })
}

/**
 * 启动后端服务（与 npm run dev 相同的 clean-start 方式）。
 * dev 模式下 Electron 主进程不自起后端（见 main/index.ts "dev 模式后端由外部管理"），
 * 由本脚本代为管理——否则 GUI 全部 API ECONNREFUSED。
 */
async function startBackend() {
  if (await checkBackend()) {
    console.log('[e2e] ✓ 后端服务已在运行')
    return null
  }
  console.log('[e2e] 启动后端服务 (clean-start, PORT=38767)...')
  // clean-start.js 在仓库根(不在 gui/ 下)——向上找一层
  const repoRoot = path.resolve(projectRoot, '..')
  const backendProcess = spawn('node', ['scripts/clean-start.js'], {
    shell: true,
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backendProcess.stdout.on('data', (d) => {
    const t = d.toString()
    if (t.includes('启动') || t.includes('✓') || t.includes('PORT')) process.stdout.write('[backend] ' + t)
  })
  backendProcess.stderr.on('data', (d) => {
    const t = d.toString()
    if (t.includes('error') || t.includes('Error')) process.stderr.write('[backend] ' + t)
  })
  // 等待后端就绪（最长 60s）
  const startTime = Date.now()
  while (Date.now() - startTime < MAX_WAIT_MS) {
    if (await checkBackend()) {
      console.log(`[e2e] ✓ 后端服务就绪 (耗时 ${(Date.now() - startTime) / 1000}s)`)
      return backendProcess
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS))
  }
  try { backendProcess.kill() } catch (_) {}
  console.error('[e2e] ✗ 后端服务启动超时!')
  process.exit(1)
}

/**
 * 杀掉残留的 Electron 进程（防止单实例锁冲突）
 */
function killOrphanElectron() {
  if (process.platform === 'win32') {
    try {
      execSync('taskkill /IM electron.exe /F', { stdio: 'ignore' })
      console.log('[e2e] 已清理残留 Electron 进程')
    } catch (_) {
      // 没有残留进程，正常
    }
  } else {
    try {
      execSync('pkill -x electron', { stdio: 'ignore' })
    } catch (_) {}
  }
}

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  CrabPaw 开发版 E2E 测试')
  console.log('═══════════════════════════════════════════\n')

  // 1. 清理残留 Electron
  killOrphanElectron()

  // 2. 确保主进程已构建
  ensureMainProcessBuilt()

  // 3. 启动 Vite dev server（不含 Electron）
  const viteProcess = await startViteDevServer()

  // 3.5 启动后端服务（dev 模式 Electron 不自起后端——见 main/index.ts）
  const backendProcess = await startBackend()

  // 4. 运行 Playwright（Playwright 自己启动 Electron，连接 Vite dev server）
  console.log('\n[e2e] 运行 Playwright 测试...\n')
  const pwExitCode = await new Promise((resolve) => {
    const pwProcess = spawn(
      'npx',
      ['playwright', 'test', ...playwrightArgs],
      {
        shell: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          VITE_DEV_SERVER_URL: DEV_SERVER_URL,
        },
      }
    )
    pwProcess.on('close', (code) => resolve(code ?? 1))
    pwProcess.on('error', () => resolve(1))
  })

  // 5. 清理
  if (viteProcess) {
    console.log('\n[e2e] 关闭 Vite dev server...')
    try { viteProcess.kill() } catch (_) {}
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${viteProcess.pid} /T /F`, { stdio: 'ignore' })
      } catch (_) {}
    }
  }
  if (backendProcess) {
    console.log('[e2e] 关闭后端服务...')
    try { backendProcess.kill() } catch (_) {}
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${backendProcess.pid} /T /F`, { stdio: 'ignore' })
      } catch (_) {}
    }
  }

  // 清理残留 Electron
  killOrphanElectron()

  console.log(`\n[e2e] 测试完成，退出码: ${pwExitCode}`)
  process.exit(pwExitCode)
}

main().catch((e) => {
  console.error('[e2e] 致命错误:', e)
  process.exit(1)
})
