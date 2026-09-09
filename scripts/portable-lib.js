'use strict'
// CrabPaw 免安装 U 盘版(文件夹形态)——构建纯函数库
// 设计: docs/superpowers/specs/2026-08-25-crabpaw-portable-usb-design.md §5/§6
// 约定: 所有路径比较统一为前向斜杠;模块无副作用,可单测

const GH_PROXY_BASE = 'https://gh-proxy.com/'

/** 给 GitHub 基址加 gh-proxy 前缀(幂等);非字符串原样返回 */
function proxyWrap(githubBase) {
  if (typeof githubBase !== 'string' || githubBase.startsWith(GH_PROXY_BASE)) return githubBase
  return GH_PROXY_BASE + githubBase
}

// 打包违禁模式(spec §6b)。分两类:
// GLOBAL —— 任何路径都拦截(版本库/环境/脚手架残留、根 node_modules 的 dev 工具包)
// SOURCE_TREE —— 仅针对"我们的源码树"(resources/src、resources/data、dist 等)——
// 第三方 npm 包仓储自带测试/源映射/声明/夹具(如 pg-protocol 的 *.test.ts、
// pptxgenjs 嵌套 @types/node)属其正常内容, 按原样放行; 洁净度拦截的是我们的开发残留。
// 防误伤: sherpa-onnx-node / @larksuite / cloakbrowser 不在排除名单
const GLOBAL_PATTERNS = [
  /(^|\/)\.git($|\/)/,
  /(^|\/)\.env($|\.)/,
  /__pycache__/,
  /\.pyc$/,
  /\.pytest_cache/,
  /(^|\/)node_modules\/\.cache($|\/)/,
  /(^|\/)\.bin($|\/)/,
  // 根 node_modules(资源树)的 dev 工具包——与 gui/package.json T4 filter 互防;
  // 锚定 ^resources/node_modules/: 嵌套 @types/jest 等同名包属第三方自己依赖, 放行
  /^resources\/node_modules\/(jest|@types|@babel|eslint|prettier|typescript|vite|vitest|electron|@electron|electron-builder|electron-packager|electron-icon-builder|@vitejs|playwright|@playwright|jsdom|ts-node|tsx|concurrently|wait-on|postcss|tailwindcss|autoprefixer|@testing-library|@tailwindcss|@typescript-eslint)(\/|$)/,
]
const SOURCE_TREE_PATTERNS = [
  /\.test\.(js|ts|jsx|tsx)$/,
  /\.spec\.(js|ts)$/,
  /\.map$/,
  /\.(log|db|db-shm|db-wal)$/,
]
const VIOLATION_PATTERNS = [...GLOBAL_PATTERNS, ...SOURCE_TREE_PATTERNS]

/** 对相对路径列表做违禁扫描,返回命中名单(原样字符串,不归一化) */
function findViolations(relPaths) {
  const bad = []
  for (const p of relPaths) {
    const norm = String(p).replace(/\\/g, '/')
    // 第三方包内容: 仅 GLOBAL 拦截; 我们的源码树: 全部拦截
    const apply = norm.includes('/node_modules/') ? GLOBAL_PATTERNS : VIOLATION_PATTERNS
    for (const re of apply) {
      if (re.test(norm)) {
        bad.push(p)
        break
      }
    }
  }
  return bad
}

module.exports = { GH_PROXY_BASE, proxyWrap, VIOLATION_PATTERNS, GLOBAL_PATTERNS, SOURCE_TREE_PATTERNS, findViolations }
