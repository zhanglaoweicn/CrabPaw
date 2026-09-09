/** safe-zip — 统一安全解压（extract-zip 全版本 zip-slip 无上游修复的收口）。
 *  校验先行：任何条目名越界/绝对路径/符号链接 → 整体拒绝（全有或全无），不落半包。
 *  供 document-tools / skill-handler / skill-market / skill-importer 等处理
 *  用户可上传 ZIP 的链路统一调用，杜绝 CVE 级越界写（CWE-22, CVSS 8.1）。 */
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

/** 符号链接判定：unix external attributes 高 16 位是 st_mode，S_IFLNK = 0xA000 */
function _isSymlinkEntry(entry) {
  try {
    const mode = (entry.attr >>> 16) & 0xf000;
    return mode === 0xa000;
  } catch (_) {
    return false;
  }
}

/**
 * 安全解压 ZIP 到 destDir。
 * @param {string} zipPath ZIP 文件路径
 * @param {string} destDir 目标目录（自动逐条目 mkdir，不要求预存在）
 * @param {object} [opts] { maxEntries=2000, maxTotalBytes=512MB }
 * @returns {Promise<string[]>} 成功解出的文件相对路径列表（目录条目不计入）
 * @throws 任何条目名绝对路径/含 ../解析越界/符号链接/超条目或总量上限 → 整体拒绝（不落任何文件）
 */
async function safeExtractZip(zipPath, destDir, opts = {}) {
  const maxEntries = opts.maxEntries || 2000;
  const maxTotalBytes = opts.maxTotalBytes || 512 * 1024 * 1024;
  const resolvedDest = path.resolve(destDir);
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > maxEntries) {
    throw new Error(`unsafe zip: ${entries.length} 条目超上限 ${maxEntries}`);
  }
  let total = 0;
  const planned = [];
  for (const e of entries) {
    const name = e.entryName;
    // 空条目名/"." 会被 resolve 归一到 destDir 本身从而绕过越界检查,
    // 且后续写盘会覆盖目标目录本身——前置拒绝(防 crafted zip 触发 IO 半包)
    if (name === '' || name === '.') {
      throw new Error(`unsafe zip entry (空条目名): "${name}"`);
    }
    const target = path.resolve(resolvedDest, name);
    // 解析后必须仍落在 destDir 内（含 destDir 本身，即目录条目）
    if (!target.startsWith(resolvedDest + path.sep) && target !== resolvedDest) {
      throw new Error(`unsafe zip entry (越界): "${name}"`);
    }
    // 危险路径形态前置拒绝（双保险：resolve 已拦 ../ 上跳，这里再拦显式形态——
    // 反斜杠/任意段位盘符（如 abs/C:/x）在 Windows 上可被解析出设备路径）
    if (name.startsWith('/') || name.includes('\\') || /(^|\/)[a-zA-Z]:/.test(name) || name.includes('..')) {
      throw new Error(`unsafe zip entry (危险路径形态): "${name}"`);
    }
    if (_isSymlinkEntry(e)) {
      throw new Error(`unsafe zip entry (符号链接): "${name}"`);
    }
    if (e.isDirectory) continue;
    const sz = (e.header && e.header.size) || 0;
    total += sz;
    if (total > maxTotalBytes) {
      throw new Error(`unsafe zip: 解压总量超上限 ${maxTotalBytes}`);
    }
    planned.push([e, target]);
  }
  // 校验全部通过后才落盘——全有或全无
  const written = [];
  for (const [e, target] of planned) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
    written.push(path.relative(resolvedDest, target));
  }
  return written;
}

module.exports = { safeExtractZip };
