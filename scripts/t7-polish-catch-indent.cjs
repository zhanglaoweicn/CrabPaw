// T7 分部四收尾：归一化含 MARKER 的 catch 块闭括号缩进 = catch 行缩进。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOTS = ['src', path.join('gui', 'src')];
const EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
const EXCLUDE = new Set(['node_modules', 'dist', 'dist-electron', 'build', '__tests__']);
const MARKER = '空 catch 补日志';

function* walk(dir) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (EXCLUDE.has(e.name)) continue; yield* walk(p); }
    else if (EXTS.has(path.extname(e.name))) yield p;
  }
}

function codeMask(src) {
  const mask = new Uint8Array(src.length);
  let inStr = null, inBlock = false, inLine = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inLine) { if (ch === '\n' || ch === '\r') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && src[i + 1] === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '/' && src[i + 1] === '/') { inLine = true; i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    mask[i] = 1;
  }
  return mask;
}

function matchingBrace(src, openIdx) {
  let depth = 0, inStr = null, inBlock = false, inLine = false;
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

let polished = 0, files = 0, failed = 0;
for (const root of ROOTS) for (const f of walk(root)) {
  let s; try { s = fs.readFileSync(f, 'utf-8'); } catch { continue; }
  if (!s.includes(MARKER)) continue;
  const orig = s;
  const mask = codeMask(s);
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  const edits = [];
  const re = /catch\s*(\([^(){}]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(s))) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(s, open);
    if (close < 0) continue;
    if (!s.slice(open + 1, close).includes(MARKER)) continue;
    // 闭括号行：按 catch 行缩进重写
    const closeLineStart = s.lastIndexOf('\n', close) + 1;
    const closeLineEnd = s.indexOf('\n', close);
    const actualEnd = closeLineEnd === -1 ? s.length : closeLineEnd;
    const catchLineStart = s.lastIndexOf('\n', m.index) + 1;
    const indent = s.slice(catchLineStart, m.index).match(/^[ \t]*/)[0];
    const newCloseLine = indent + '}';
    if (s.slice(closeLineStart, close) !== indent) {
      edits.push({ start: closeLineStart, end: actualEnd, text: newCloseLine + (closeLineEnd === -1 ? '' : eol) });
    }
  }
  if (edits.length === 0) continue;
  let out = s;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  fs.writeFileSync(f, out);
  if (f.endsWith('.js') || f.endsWith('.cjs')) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { console.error('SYNTAX-FAIL after polish (rolled back):', f); fs.writeFileSync(f, orig); failed++; continue; }
  }
  polished += edits.length;
  files++;
}
console.log(`polished ${polished} closing braces in ${files} files, rollbacks: ${failed}`);
