// T7 分部四：空 catch 全库清理（node 脚本批量，保留 CRLF 原样）。
// 规则：src/ 与 gui/src/ 下所有 body 仅空白/注释的 catch 块，统一补日志：
//   console.warn('[<模块名>] 空 catch 补日志[·<前置注释上下文>]:', <e> && <e>.message)
// 仅加日志，不改控制流（Harness 钩子降级不中断语义保留）。
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

// 从 openIdx('{' 位置)找匹配 '}'，跳过字符串/注释
function findMatchingBrace(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let inBlock = false;
  let inLine = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (inLine) { if (ch === '\n' || ch === '\r') inLine = false; continue; }
    if (inBlock) { if (ch === '*' && src[i + 1] === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '/' && src[i + 1] === '/') { inLine = true; i++; continue; }
    if (ch === '/' && src[i + 1] === '*') { inBlock = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return { closeIdx: i, ok: true }; }
  }
  return { closeIdx: -1, ok: false };
}

// 提取 idx 之前最近的注释行文本（作日志上下文，≤48 字符）
function nearestCommentContext(src, idx) {
  const before = src.slice(0, idx);
  const lineComment = before.match(/\/\/[^\r\n]*$/);
  const blockComment = before.match(/\/\*([\s\S]*?)\*\/\s*$/);
  if (blockComment) {
    const lastLine = blockComment[1].split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
    if (lastLine && lastLine.length >= 2) return lastLine.slice(0, 48);
  }
  if (lineComment) {
    const t = lineComment[0].replace(/^\/\/\s*/, '').trim();
    if (t && t.length >= 2) return t.slice(0, 48);
  }
  return '';
}

// 扫描文件：返回 (src 修改后, 修改数, 是否跳过)
function sweepFile(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf-8'); } catch { return { changed: 0, skipped: true }; }
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const base = path.basename(file);

  // 只处理代码区（非字符串/注释内）的 catch
  const codeMask = new Array(src.length).fill(false);
  {
    let inStr = null, inBlock = false, inLine = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inLine) { if (ch === '\n' || ch === '\r') inLine = false; continue; }
      if (inBlock) { if (ch === '*' && src[i + 1] === '/') { inBlock = false; i++; } continue; }
      if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
      if (ch === '/' && src[i + 1] === '/') { inLine = true; i++; continue; }
      if (ch === '/' && src[i + 1] === '*') { inBlock = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      codeMask[i] = true;
    }
  }

  const edits = [];
  const re = /catch\s*(\([^(){}]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    if (!codeMask[m.index]) continue;
    const openIdx = m.index + m[0].length - 1;
    const { closeIdx, ok } = findMatchingBrace(src, openIdx);
    if (!ok) continue;
    const body = src.slice(openIdx + 1, closeIdx);
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
    if (stripped.trim().length > 0) continue; // 已有真实语句

    // catch 参数名（无参则补 (e)）
    let catchText = m[0];
    let paramName = '';
    const pm = m[1] && m[1].match(/\(([^)]+)\)/);
    if (pm) paramName = pm[1].trim().split(',')[0].trim();
    if (!paramName) { catchText = catchText.replace(/\s*\{$/, ' (e) {'); paramName = 'e'; }

    const ctx = nearestCommentContext(src, m.index);
    const logLine = `console.warn('[${base}] 空 catch 补日志${ctx ? '·' + ctx : ''}:', ${paramName} && ${paramName}.message);`;
    const indent1 = (src.slice(0, m.index).match(/[ \t]*$/) || [''])[0];
    const indent2 = indent1 + '  ';
    // 保留原注释(若有)，其后追加日志行
    const commentPart = body.trim().length > 0 ? body.replace(/[ \t]*$/, '') : '';
    let newBody;
    if (commentPart) {
      newBody = eol + commentPart.replace(/^/gm, (l) => indent2 + l) + eol + indent2 + logLine + eol + indent1;
    } else {
      newBody = eol + indent2 + logLine + eol + indent1;
    }
    // 注意：保留 catch 头部的 ` {`（历史版本 slice(0,-1) 误删 `{`，导致块语句形态结构错位）
    edits.push({ start: m.index, end: closeIdx + 1, text: catchText + newBody + '}' });
  }

  if (edits.length === 0) return { changed: 0, skipped: false };
  // 从后往前应用替换
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  fs.writeFileSync(file, out);
  return { changed: edits.length, skipped: false };
}

let totalFiles = 0;
let totalEdits = 0;
const changedFiles = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    totalFiles++;
    const { changed, skipped } = sweepFile(file);
    if (skipped) continue;
    if (changed > 0) { totalEdits += changed; changedFiles.push({ file, changed }); }
  }
}
console.log(`scanned ${totalFiles} files; swept ${totalEdits} empty catch blocks in ${changedFiles.length} files`);
for (const f of changedFiles) console.log(`  ${f.file}: ${f.changed}`);
