/**
 * clean-unused-args — 清理 no-unused-vars 的"未使用函数参数"类 warning（一次性迁移脚本）。
 *
 * 原理: eslint 对未使用函数参数报 "X is defined but never used"。eslint 允许 ^_ 前缀
 * 忽略。对每个报错位置,若该标识符不在对象解构块内({ ctx } 需 ctx: _ctx 才安全),
 * 则在参数名前加 _ 前缀。100% 不改运行时行为——eslint 报 unused 即函数体未引用该参数,
 * 改名只影响签名。jest(806) 兜底验证。
 *
 * 跳过: 解构参数(需改 { ctx: _ctx } 而非加前缀)、已带 _ 的、rest 参数(安全但保守跳过)。
 *
 * 用法: node scripts/clean-unused-args.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function run() {
  let raw;
  try {
    raw = execSync('npx eslint src/ --ext .js --format json', { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    // eslint 有 warning 时 exit code 非 0,但 stdout 仍有 JSON
    raw = e.stdout || '';
  }
  const results = JSON.parse(raw);
  let changed = 0, skipped = 0, skippedDestructure = 0, skippedRest = 0;
  const touchedFiles = new Set();

  for (const f of results) {
    for (const m of f.messages) {
      if (m.ruleId !== 'no-unused-vars') continue;
      if (!m.message.includes('is defined but never used')) continue;
      const name = (m.message.match(/'([^']+)'/) || [])[1];
      if (!name || name.startsWith('_')) continue;
      if (name === 'arguments') continue; // arguments 是关键字,不能加前缀

      const filePath = path.resolve(f.filePath);
      const text = fs.readFileSync(filePath, 'utf-8');
      const lines = text.split('\n');
      const line = lines[m.line - 1];
      const col = m.column - 1; // 0-based

      // 解构块检测: token 前未闭合的 { 数 > } 数 → 在解构内,需 ctx: _ctx 才安全,跳过
      const before = line.slice(0, col);
      const openB = (before.match(/\{/g) || []).length;
      const closeB = (before.match(/\}/g) || []).length;
      if (openB > closeB) { skipped++; skippedDestructure++; continue; }

      // rest 参数保守跳过
      const trimmedBefore = before.replace(/\s+$/, '');
      if (trimmedBefore.endsWith('...')) { skipped++; skippedRest++; continue; }

      // 列位置应为标识符起点(字母/下划线)
      const ch = line[col];
      if (!ch || !/[A-Za-z_$]/.test(ch)) { skipped++; continue; }

      lines[m.line - 1] = line.slice(0, col) + '_' + line.slice(col);
      fs.writeFileSync(filePath, lines.join('\n'));
      touchedFiles.add(filePath);
      changed++;
    }
  }
  console.log(`未使用参数清理: 修改 ${changed} 处 / 涉及 ${touchedFiles.size} 文件`);
  console.log(`跳过 ${skipped} 处(解构 ${skippedDestructure} / rest ${skippedRest} / 其他)`);
}

run();
