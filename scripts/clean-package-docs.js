'use strict'
// 包内文档清扫(2026-09-09)——发行包(免安装 zip / NSIS 载荷)中只允许:
//   1. 产品提示词/专家人设:  resources/src/**           (Prompt as Code 运行必需)
//   2. 技能定义:             resources/skills/**        (技能加载器读取)
//   3. 产品数据:             resources/data/**
//   4. 许可证类文件:         LICENSE*/LICENSES*/COPYING*/NOTICE*(任意位置, 法律合规)
//   5. 根 README.txt:        打包管线注入的使用说明
// 其余一切 .md/.markdown(第三方 README/CHANGELOG/npm docs 等)一律删除——
// 用户不应在发行包里接触到任何系统说明文档。
// 用法: node scripts/clean-package-docs.js <unpackedDir>
// 退出码: 0=完成(无论删了多少) 2=用法错误 1=目录不存在
const fs = require('fs')
const path = require('path')

const KEEP_DIR_RE = /^(resources\/)?(src|skills|data)\//i
const LEGAL_NAME_RE = /^(licen[cs]e|copying|notice)/i

function isStrayDocFile(normRel) {
  if (!/\.(md|markdown)$/i.test(normRel)) return false
  if (KEEP_DIR_RE.test(normRel)) return false
  const base = normRel.split('/').pop() || ''
  return !LEGAL_NAME_RE.test(base)
}

function main() {
  const root = process.argv[2]
  if (!root) {
    console.error('用法: node scripts/clean-package-docs.js <unpackedDir>')
    process.exit(2)
  }
  if (!fs.existsSync(root)) {
    console.error('[FAIL] 目录不存在:', root)
    process.exit(1)
  }

  const deleted = []
  const kept = []
  ;(function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(abs)
      } else {
        const rel = path.relative(root, abs).replace(/\\/g, '/')
        if (isStrayDocFile(rel)) {
          fs.unlinkSync(abs)
          deleted.push(rel)
        } else if (/\.(md|markdown)$/i.test(rel)) {
          kept.push(rel)
        }
      }
    }
  })(root)

  // 自底向上清掉因删除变空的目录(如 resources/npm/docs)
  let pruned = 0
  ;(function prune(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) prune(path.join(dir, ent.name))
    }
    const entries = fs.readdirSync(dir)
    if (dir !== root && entries.length === 0) {
      fs.rmdirSync(dir)
      pruned++
    }
  })(root)

  console.log(`[DOCS-CLEAN] 删除文档 ${deleted.length} 个, 保留(产品/许可) ${kept.length} 个, 清除空目录 ${pruned} 个`)
  for (const d of deleted.slice(0, 12)) console.log('  -', d)
  if (deleted.length > 12) console.log(`  ... 等共 ${deleted.length} 个`)
  process.exit(0)
}

main()
