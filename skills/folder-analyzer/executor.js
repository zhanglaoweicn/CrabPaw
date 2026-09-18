/**
 * folder-analyzer — 文件夹结构分析执行器（零外部依赖，Node 内置模块）
 *
 * 提供以下操作（通过 input.action 指定）：
 *   - analyze   综合结构报告（默认）：概览 + 目录树 + 扩展名分布 + 最大文件/子目录 + 疑似重复
 *   - tree      仅目录树
 *   - dupes     仅疑似重复文件（同名校验，name+size 相同）
 *
 * 调用约定：execute(input, options, params)
 *   input 可选字段：
 *     path          目标目录（默认进程 cwd；相对路径按 cwd 解析）
 *     action        'analyze' | 'tree' | 'dupes'（默认 'analyze'）
 *     maxDepth      递归深度上限（默认 8，最大 20）
 *     topN          各 TOP 榜单条数（默认 10，最大 30）
 *     exclude       排除的目录名数组（默认 node_modules/.git/__pycache__/.crabpaw/dist/build）
 *     includeHidden 是否包含 . 开头的隐藏条目（默认 false）
 *
 * 安全护栏：maxEntries=30000 上限防巨型目录拖垮；符号链接不递归（防环）。
 */

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 30000;
const MAX_DEPTH_HARD = 20;
const DEFAULT_EXCLUDE = ['node_modules', '.git', '__pycache__', '.crabpaw', 'dist', 'build', '.svn', '.hg'];
const TREE_MAX_LINES = 220;

function _fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function _walk(rootDir, opts) {
  const { maxDepth, excludeSet, includeHidden } = opts;
  const entries = [];
  const stack = [{ dir: rootDir, depth: 0, rel: '' }];
  let truncated = false;

  while (stack.length > 0) {
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    const { dir, depth, rel } = stack.pop();
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }

    for (const ent of names) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const name = ent.name;
      if (!includeHidden && name.startsWith('.')) continue;
      if (ent.isDirectory() && excludeSet.has(name.toLowerCase())) continue;

      const full = path.join(dir, name);
      const relPath = rel ? rel + '/' + name : name;

      if (ent.isSymbolicLink()) {
        // 符号链接不递归(防环), 记为一项
        entries.push({ rel: relPath, full, isDir: false, size: 0, ext: path.extname(name).toLowerCase(), depth, symlink: true });
        continue;
      }

      if (ent.isDirectory()) {
        entries.push({ rel: relPath, full, isDir: true, size: 0, ext: '', depth, symlink: false });
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1, rel: relPath });
        continue;
      }

      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) { /* 不可读按 0 */ }
      entries.push({ rel: relPath, full, isDir: false, size, ext: path.extname(name).toLowerCase(), depth, symlink: false });
    }
  }
  return { entries, truncated };
}

function _renderTree(entries, rootDir, topN) {
  // 目录树: 目录在前; 每层渲染上限 topN*2 项(其余计数), 全树 220 行封顶
  const byParent = new Map();
  for (const e of entries) {
    const parent = e.rel.includes('/') ? e.rel.slice(0, e.rel.lastIndexOf('/')) : '';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(e);
  }
  const lines = [`📂 ${rootDir}`];
  const renderLevel = (parent, prefix, depth) => {
    if (depth > 12 || lines.length > TREE_MAX_LINES) return;
    const kids = (byParent.get(parent) || [])
      .slice()
      .sort((a, b) => (b.isDir - a.isDir) || a.rel.localeCompare(b.rel));
    const shown = kids.slice(0, topN * 2);
    for (const k of shown) {
      if (lines.length > TREE_MAX_LINES) { lines.push(prefix + '…（已达渲染上限）'); return; }
      const tag = k.isDir ? '📁' : '📄';
      const size = k.isDir ? '' : ` (${_fmtSize(k.size)})`;
      lines.push(`${prefix}${tag} ${k.rel.split('/').pop()}${size}${k.symlink ? ' [链接]' : ''}`);
      if (k.isDir) renderLevel(k.rel, prefix + '  ', depth + 1);
    }
    if (kids.length > shown.length) lines.push(`${prefix}…另有 ${kids.length - shown.length} 项未展开`);
  };
  renderLevel('', '', 0);
  return lines.join('\n');
}

async function execute(input) {
  input = input || {};
  const target = path.resolve(String(input.path || process.cwd()));
  if (!fs.existsSync(target)) {
    return { success: false, error: `目录不存在: ${target}` };
  }
  let rootStat;
  try { rootStat = fs.statSync(target); } catch (e) { return { success: false, error: `目录不可访问: ${e.message}` }; }
  if (!rootStat.isDirectory()) {
    return { success: false, error: `不是目录: ${target}` };
  }

  const action = String(input.action || 'analyze').toLowerCase();
  const maxDepth = Math.min(Math.max(parseInt(input.maxDepth, 10) || 8, 1), MAX_DEPTH_HARD);
  const topN = Math.min(Math.max(parseInt(input.topN, 10) || 10, 3), 30);
  const excludeArr = Array.isArray(input.exclude) ? input.exclude.map(String) : DEFAULT_EXCLUDE;
  const excludeSet = new Set(excludeArr.map(x => x.toLowerCase()));
  const includeHidden = input.includeHidden === true;

  const { entries, truncated } = _walk(target, { maxDepth, excludeSet, includeHidden });
  const dirs = entries.filter(e => e.isDir);
  const files = entries.filter(e => !e.isDir);
  const totalSize = files.reduce((a, f) => a + f.size, 0);

  if (action === 'tree') {
    return {
      success: true,
      action,
      path: target,
      report: _renderTree(entries, target, topN) + (truncated ? `\n⚠️ 条目超 ${MAX_ENTRIES} 上限, 结果已截断` : ''),
      stats: { dirs: dirs.length, files: files.length, truncated },
    };
  }

  // 扩展名分布
  const byExt = new Map();
  for (const f of files) {
    const key = f.ext || '（无扩展名）';
    const cur = byExt.get(key) || { count: 0, size: 0 };
    cur.count++; cur.size += f.size;
    byExt.set(key, cur);
  }
  const extTop = [...byExt.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, topN);

  // 子目录体量(按直接父目录聚合文件大小)
  const byParentDir = new Map();
  for (const f of files) {
    const parent = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '（根）';
    byParentDir.set(parent, (byParentDir.get(parent) || 0) + f.size);
  }
  const dirTop = [...byParentDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

  // 最大文件
  const fileTop = files.slice().sort((a, b) => b.size - a.size).slice(0, topN);

  // 疑似重复: 同名同大小(跨目录)
  const byNameSize = new Map();
  for (const f of files) {
    const key = f.rel.split('/').pop() + '|' + f.size;
    if (!byNameSize.has(key)) byNameSize.set(key, []);
    byNameSize.get(key).push(f);
  }
  const dupeGroups = [...byNameSize.values()].filter(g => g.length > 1 && g[0].size > 0)
    .sort((a, b) => b[0].size * b.length - a[0].size * a.length)
    .slice(0, topN);

  const L = [];
  L.push(`# 文件夹结构分析: ${target}`);
  L.push('');
  L.push('## 概览');
  L.push(`- 目录 ${dirs.length} 个 | 文件 ${files.length} 个 | 总大小 ${_fmtSize(totalSize)} | 最大深度 ${Math.max(0, ...entries.map(e => e.depth))}`);
  L.push(`- 排除规则: ${excludeArr.join(', ')}${includeHidden ? ' | 含隐藏条目' : ' | 不含隐藏条目'}`);
  if (truncated) L.push(`- ⚠️ 条目超 ${MAX_ENTRIES} 上限, 统计基于截断结果`);

  if (action === 'dupes') {
    L.push('');
    L.push(`## 疑似重复文件（同名同大小, TOP ${dupeGroups.length}）`);
    if (dupeGroups.length === 0) L.push('- 未发现同名同大小的可疑重复');
    for (const g of dupeGroups) {
      L.push(`- ${g[0].rel.split('/').pop()} × ${g.length} 份（各 ${_fmtSize(g[0].size)}）:`);
      for (const f of g.slice(0, 5)) L.push(`  - ${f.rel}`);
    }
  } else {
    L.push('');
    L.push('## 目录树（每层限量渲染）');
    L.push(_renderTree(entries, target, topN));

    L.push('');
    L.push(`## 扩展名分布 TOP ${extTop.length}（按体积）`);
    for (const [ext, v] of extTop) L.push(`- ${ext}: ${v.count} 个, ${_fmtSize(v.size)}`);

    L.push('');
    L.push(`## 最大子目录 TOP ${dirTop.length}（直接文件体积）`);
    for (const [d, size] of dirTop) L.push(`- ${d}: ${_fmtSize(size)}`);

    L.push('');
    L.push(`## 最大文件 TOP ${fileTop.length}`);
    for (const f of fileTop) L.push(`- ${f.rel}: ${_fmtSize(f.size)}`);

    L.push('');
    L.push(`## 疑似重复文件（同名同大小, TOP ${dupeGroups.length}）`);
    if (dupeGroups.length === 0) L.push('- 未发现');
    for (const g of dupeGroups) {
      L.push(`- ${g[0].rel.split('/').pop()} × ${g.length} 份（各 ${_fmtSize(g[0].size)}）`);
    }
    L.push('');
    L.push('> 需要"仅目录树"或"仅查重复"可传 action: "tree" / "dupes"；要含隐藏/排除目录见参数表。');
  }

  return {
    success: true,
    action,
    path: target,
    report: L.join('\n'),
    stats: { dirs: dirs.length, files: files.length, totalSize, truncated, dupeGroups: dupeGroups.length },
  };
}

const schema = {
  input: {
    path: { type: 'string', description: '目标目录（默认当前工作目录）' },
    action: { type: 'string', description: "analyze=综合报告(默认) | tree=仅目录树 | dupes=仅疑似重复" },
    maxDepth: { type: 'number', description: '递归深度上限(默认 8)' },
    topN: { type: 'number', description: 'TOP 榜单条数(默认 10)' },
    exclude: { type: 'array', description: '排除的目录名(默认 node_modules/.git/__pycache__/.crabpaw/dist/build)' },
    includeHidden: { type: 'boolean', description: '是否包含隐藏条目(默认 false)' },
  },
  output: {
    report: { type: 'string', description: '结构分析报告（Markdown 文本）' },
    stats: { type: 'object', description: '统计摘要' },
  },
};

module.exports = { execute, schema };
module.exports.execute = execute;
