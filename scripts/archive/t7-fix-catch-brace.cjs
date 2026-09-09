// T7 分部四修复 v2：为 sweep 产出的无 `{` catch 头补回 ` {`（行尾 catch，含行中 `} catch (e)`）。
// 内容行(空白/注释/日志)统一缩进 lineIndent+2；原 `}` 保留。每文件 node --check 验证，失败回滚。
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

// 该行前缀是否为代码（无未闭合字符串/注释；以 catch 头结尾）
function linePrefixIsCode(prefix) {
  let inStr = null;
  for (let i = 0; i < prefix.length; i++) {
    const ch = prefix[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && prefix[i + 1] === '/') return false; // 行注释吞掉 catch
  }
  return !inStr;
}

let fixed = 0, files = 0, failed = 0;
for (const root of ROOTS) for (const f of walk(root)) {
  let s; try { s = fs.readFileSync(f, 'utf-8'); } catch { continue; }
  if (!s.includes(MARKER)) continue;
  const orig = s;
  const lines = s.split(/\r\n|\n/);
  const eol = s.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(.*?)catch\s*(\([^()]*\))?[ \t]*$/);
    if (!m) continue;
    const prefix = m[1] || '';
    if (!linePrefixIsCode(prefix)) continue;
    // 前缀必须是代码结尾（`}`、`)`、`;`、或纯空白）——避免误匹配 `x.catch(` 等
    const trimmed = prefix.trimEnd();
    if (trimmed !== '' && !/[})\];]/.test(trimmed.slice(-1))) continue;
    if (/catch\s*(\([^)]*\))?$/.test(trimmed)) continue; // 前缀自身以 catch 结尾(嵌套罕见)——跳过

    const lineIndentMatch = line.match(/^[ \t]*/);
    const lineIndent = lineIndentMatch ? lineIndentMatch[0] : '';
    const newIndent = lineIndent + '  ';

    let j = i + 1;
    const content = [];
    let sawMarker = false;
    while (j < lines.length) {
      const t = lines[j].trim();
      if (t === '') { content.push({ line: '', blank: true }); j++; continue; }
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.includes(MARKER)) {
        if (t.includes(MARKER)) sawMarker = true;
        content.push({ line: lines[j], blank: false });
        j++;
        continue;
      }
      if (/^\}\s*$/.test(t)) break;
      break;
    }
    if (!sawMarker || j >= lines.length) continue;
    const closeLine = j;
    const newHeader = line.replace(/\s*$/, '') + ' {';
    const replaced = [newHeader, ...content.map((c) => (c.blank ? '' : newIndent + c.line.trim())), lines[closeLine]];
    lines.splice(i, (closeLine - i) + 1, ...replaced);
    fixed++;
    changed = true;
  }
  if (!changed) continue;
  const out = lines.join(eol);
  fs.writeFileSync(f, out);
  if (f.endsWith('.js') || f.endsWith('.cjs')) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) {
      console.error('SYNTAX-FAIL after fix (rolled back):', f);
      fs.writeFileSync(f, orig);
      failed++;
      continue;
    }
  }
  files++;
}
console.log(`fixed ${fixed} S-form catch sites in ${files} files, rollbacks: ${failed}`);
