#!/usr/bin/env node
/**
 * bump-version.js — 发版第一步：版本号自增或指定
 * 用法:
 *   node scripts/bump-version.js            # patch +1 (2.2.0 -> 2.2.1)
 *   node scripts/bump-version.js 2.3.0      # 指定版本
 * 输出: 新版本号（供编排脚本捕获）。--dry-run 只打印不写盘。
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'gui', 'package.json');
const dryRun = process.argv.includes('--dry-run');
const argVer = process.argv.find((a, i) => i > 1 && a !== '--dry-run');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const cur = pkg.version || '0.0.0';

let next;
if (argVer) {
  next = argVer.replace(/^v/, '');
} else {
  const parts = cur.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  next = parts.join('.');
}

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error('[FAIL] 非法版本号: ' + next + '（需 x.y.z）');
  process.exit(1);
}
if (next === cur) {
  console.error('[FAIL] 新版本号与当前相同: ' + cur);
  process.exit(1);
}

if (dryRun) {
  console.log(next);
  process.exit(0);
}

pkg.version = next;
// 2 空格缩进 + 尾换行, 与原文件格式一致
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log(next);
