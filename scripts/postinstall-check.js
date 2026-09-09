/**
 * CrabPaw Postinstall Check
 *
 * 安装后验证脚本：
 * - 检查关键依赖是否存在
 * - 验证原生模块是否可加载
 * - 检查 Node.js 版本
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const NATIVE_MODULES = ['better-sqlite3', 'sharp']
const MIN_NODE_VERSION = 18
const MAX_NODE_VERSION = 24

let errors = 0

function check(label, fn) {
  try {
    fn()
    console.log(`  ✅ ${label}`)
  } catch (e) {
    console.log(`  ❌ ${label}: ${e.message}`)
    errors++
  }
}

console.log('')
console.log('🦀 CrabPaw — 安装后检查')
console.log('')

// 1. Node.js 版本
check('Node.js 版本 ' + process.version, () => {
  const parts = process.version.replace('v', '').split('.').map(Number)
  const major = parts[0]
  if (major < MIN_NODE_VERSION || major > MAX_NODE_VERSION) {
    throw new Error(`需要 Node.js v${MIN_NODE_VERSION} ~ v${MAX_NODE_VERSION}，当前 ${process.version}`)
  }
})

// 2. 关键依赖存在性
const rootPkg = require(path.join(__dirname, '..', 'package.json'))
for (const dep of Object.keys(rootPkg.dependencies || {})) {
  const depPath = path.join(__dirname, '..', 'node_modules', dep)
  check(`依赖 ${dep}`, () => {
    if (!fs.existsSync(depPath)) throw new Error('not installed')
  })
}

// 3. 原生模块尝试加载 (仅警告，不阻塞)
for (const mod of NATIVE_MODULES) {
  check(`原生模块 ${mod}`, () => {
    try {
      const modPath = path.join(__dirname, '..', 'node_modules', mod)
      if (fs.existsSync(modPath)) {
        require.resolve(mod, { paths: [path.join(__dirname, '..')] })
        // 实际加载验证
        require(mod)
      }
    } catch (e) {
      // Node.js ABI 不匹配？需要 rebuild
      console.log(`     ⚠  加载失败: ${e.message}`)
      console.log(`     💡 尝试: npm run rebuild:electron`)
      // 不记入 error（可以是构建环境问题）
    }
  })
}

// 4. Electron 配置健康检查 (如果存在)
const guiPkgPath = path.join(__dirname, '..', 'gui', 'package.json')
if (fs.existsSync(guiPkgPath)) {
  const guiPkg = require(guiPkgPath)
  check('Electron builder 配置', () => {
    if (!guiPkg.build) throw new Error('build config missing')
    if (!guiPkg.build.win) throw new Error('win target missing')
    if (!guiPkg.build.nsis) throw new Error('nsis config recommended for installer builds')
  })
}

console.log('')
if (errors > 0) {
  console.log(`⚠️  发现 ${errors} 个问题 — 请检查以上详情\n`)
} else {
  console.log('✅ 所有检查通过\n')
}
