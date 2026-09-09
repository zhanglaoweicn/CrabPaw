const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function atomicWriteFile(filePath, data, options = {}) {
  const encoding = options.encoding || 'utf-8';
  const mode = options.mode;
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const suffix = '.' + Date.now() + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const tmpPath = filePath + suffix;

  try {
    if (mode !== undefined) {
      fs.writeFileSync(tmpPath, data, { encoding, mode });
    } else {
      fs.writeFileSync(tmpPath, data, encoding);
    }

    // Windows: renameSync 在目标文件已存在时可能失败，先删除目标
    try {
      if (process.platform === 'win32' && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      /* Windows 删除目标文件失败，忽略 */
      console.warn('[atomic-write.js] 空 catch 补日志:', e && e.message);
    }


    fs.renameSync(tmpPath, filePath);
    return { success: true, path: filePath };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) {
      /* 清理临时文件，忽略 */
      console.warn('[atomic-write.js] 空 catch 补日志:', e && e.message);
    }

    throw err;
  }
}

function atomicWriteJSON(filePath, obj, options = {}) {
  const indent = options.indent !== undefined ? options.indent : 2;
  const data = JSON.stringify(obj, options.replacer || null, indent);
  return atomicWriteFile(filePath, data, options);
}

function atomicReplace(filePath, data, options = {}) {
  return atomicWriteFile(filePath, data, options);
}

function atomicReadJSON(filePath, options = {}) {
  const encoding = options.encoding || 'utf-8';
  const reviver = options.reviver || null;

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const tmpPath = filePath + '.reading.' + Date.now() + '.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.copyFileSync(filePath, tmpPath);
    const content = fs.readFileSync(tmpPath, encoding);
    // 立即清理临时文件
    try { fs.unlinkSync(tmpPath); } catch (e) {
      /* 清理临时文件，忽略 */
      console.warn('[atomic-write.js] 空 catch 补日志:', e && e.message);
    }

    return JSON.parse(content, reviver);
  } catch (err) {
      // 确保异常时也清理临时文件
      try { fs.unlinkSync(tmpPath); } catch (e) {
        /* 清理临时文件，忽略 */
        console.warn('[atomic-write.js] 空 catch 补日志:', e && e.message);
      }

    if (err instanceof SyntaxError) {
      const backupPath = filePath + '.corrupted.' + Date.now();
      try {
        fs.copyFileSync(filePath, backupPath);
        fs.unlinkSync(filePath);
      } catch (e) { console.warn('备份损坏文件失败:', e.message) }
      throw new Error(`Corrupted JSON in ${filePath}, backup saved to ${backupPath}: ${err.message}`);
    }
    throw err;
  }
}

function safeWriteWithBackup(filePath, data, options = {}) {
  const backupPath = filePath + '.bak';
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (e) { console.warn('创建备份失败:', e.message) }
  }
  return atomicWriteFile(filePath, data, options);
}

module.exports = {
  atomicWriteFile,
  atomicWriteJSON,
  atomicReplace,
  atomicReadJSON,
  safeWriteWithBackup,
};
