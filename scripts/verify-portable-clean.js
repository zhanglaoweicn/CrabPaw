'use strict'
// CrabPaw 免安装版洁净度门禁(spec §6b)
// 用法:  node scripts/verify-portable-clean.js <dir>           # 目录全量扫描
//        node scripts/verify-portable-clean.js --zip <f.zip>   # zip 内清单扫描
// 退出码: 0=通过 1=有违禁(打印完整清单)
const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')
const { findViolations } = require('./portable-lib')

function scanDir(root) {
  const out = []
  function walk(dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      console.warn('[WARN] 扫描跳过(可能无权限):', dir, e.message)
      return
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(abs)
      } else {
        out.push(path.relative(root, abs))
      }
    }
  }
  walk(root)
  return out
}

function scanZip(zipFile) {
  const zip = new AdmZip(zipFile)
  return zip.getEntries().map((e) => e.entryName)
}

function main() {
  const args = process.argv.slice(2)
  const zipIdx = args.indexOf('--zip')
  const target = zipIdx >= 0 ? args[zipIdx + 1] : args[0]
  if (!target) {
    console.error('用法: node scripts/verify-portable-clean.js <dir> [--zip <file.zip>]')
    process.exit(2)
  }

  let rels
  if (zipIdx >= 0) {
    if (!fs.existsSync(target)) {
      console.error('[FAIL] zip 文件不存在:', target)
      process.exit(2)
    }
    rels = scanZip(target)
  } else {
    if (!fs.existsSync(target)) {
      console.error('[FAIL] 目录不存在:', target)
      process.exit(2)
    }
    rels = scanDir(target)
  }

  const violations = findViolations(rels)
  if (violations.length === 0) {
    console.log(`[CLEAN] ${zipIdx >= 0 ? 'zip' : '目录'} 通过洁净度门禁(共 ${rels.length} 项)`)
    process.exit(0)
  }
  console.error(`[FAIL] 洁净度门禁拦截 ${violations.length} 项违禁文件:`)
  for (const v of violations) console.error('  -', v)
  process.exit(1)
}

main()
