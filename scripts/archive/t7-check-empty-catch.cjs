// T7 分部四：验证器——扫描剩余空 catch（与 sweep 同规则）。用法: node scripts/t7-check-empty-catch.cjs
const fs = require('fs');
const path = require('path');

const ROOTS = ['src', path.join('gui', 'src')];
const EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'build', '__tests__']);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      yield* walk(p);
    } else if (EXTS.has(path.extname(ent.name))) {
      yield p;
    }
  }
}

function matchingBrace(src, openIdx) {
  let depth = 0;
  let inStr = null, inBlock = false, inLine = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inLine) { if (ch === '\n' || ch === '\r') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && src[i + 1] === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '/' && src[i + 1] === '/') { inLine = true; i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function isInCode(pre) {
  let inStr = null, inBlock = false, inLine = false;
  for (let i = 0; i < pre.length; i++) {
    const ch = pre[i];
    if (inLine) { if (ch === '\n' || ch === '\r') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && pre[i + 1] === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '/' && pre[i + 1] === '/') { inLine = true; i++; continue; }
    if (ch === '/' && pre[i + 1] === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
  }
  return !inStr && !inBlock && !inLine;
}

let remaining = 0;
for (const root of ROOTS) {
  for (const f of walk(root)) {
    const s = fs.readFileSync(f, 'utf-8');
    const re = /catch\s*(\([^(){}]*\))?\s*\{/g;
    let m;
    while ((m = re.exec(s))) {
      if (!isInCode(s.slice(0, m.index))) continue;
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = matchingBrace(s, openIdx);
      if (closeIdx < 0) continue;
      const body = s.slice(openIdx + 1, closeIdx);
      const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
      if (stripped.trim().length === 0) {
        remaining++;
        console.log('EMPTY-CATCH', f, 'line', s.slice(0, m.index).split('\n').length);
      }
    }
  }
}
console.log('remaining empty catches:', remaining);
process.exit(remaining > 0 ? 1 : 0);
