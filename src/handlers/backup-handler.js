/**
 * Backup Handler - 数据备份与导出
 * 
 * 支持导出配置、记忆、技能等数据
 * 支持从备份恢复
 */

const fs = require('fs');
const path = require('path');
const { sendError, sendJson, readJsonBody } = require('./http-utils');
const { DATA_DIR, DEFAULT_PORT } = require('../core/config');

const EXCLUDED_DIRS = new Set([
  '__pycache__',
  'node_modules',
  '.git',
  'cache'
]);

const EXCLUDED_SUFFIXES = [
  '.pyc',
  '.pyo',
  '.log',
  '.pid'
];

const EXCLUDED_NAMES = new Set([
  'gateway.pid',
  'cron.pid',
  '.api_port',
  '.api_token'
]);

function shouldExclude(relPath) {
  const parts = relPath.split(/[/\\]/);
  if (parts.some(p => EXCLUDED_DIRS.has(p))) return true;
  if (EXCLUDED_SUFFIXES.some(s => relPath.endsWith(s))) return true;
  if (EXCLUDED_NAMES.has(path.basename(relPath))) return true;
  return false;
}

async function handleBackupCreate(req, res, _ctx) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `crabpaw-backup-${timestamp}.json`;

    const backup = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      data: {}
    };

    const collectData = (dir, baseRelPath = '') => {
      const result = {};

      if (!fs.existsSync(dir)) return result;

      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const relPath = baseRelPath ? `${baseRelPath}/${item}` : item;

        if (shouldExclude(relPath)) continue;

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          result[item] = collectData(fullPath, relPath);
        } else if (stat.isFile()) {
          try {
            const ext = path.extname(item).toLowerCase();
            if (['.json', '.md', '.yaml', '.yml', '.txt'].includes(ext)) {
              const content = fs.readFileSync(fullPath, 'utf-8');
              if (ext === '.json') {
                try {
                  result[item] = JSON.parse(content);
                } catch (e) {
                  console.warn('[Backup] Failed to parse', item, ':', e.message);
                  result[item] = null;
                }
              } else {
                result[item] = content;
              }
            } else {
              result[item] = `[binary file: ${stat.size} bytes]`;
            }
          } catch (e) {
            result[item] = `[error reading: ${e.message}]`;
          }
        }
      }

      return result;
    };

    backup.data = collectData(DATA_DIR);
    
    const backupsDir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    
    const backupPath = path.join(backupsDir, backupName);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    
    const stats = {
      configFile: backup.data.config ? 1 : 0,
      sessions: backup.data.memory?.sessions ? Object.keys(backup.data.memory.sessions).length : 0,
      skills: backup.data.skills ? Object.keys(backup.data.skills).length : 0,
      workflows: backup.data.workflows ? Object.keys(backup.data.workflows).length : 0
    };
    
    console.log(`✅ 备份已创建: ${backupName}`);
    
    sendJson(res, 200, {
      success: true,
      data: {
        backupName,
        backupPath,
        size: Buffer.byteLength(JSON.stringify(backup)),
        stats,
        createdAt: backup.createdAt
      }
    });
    
  } catch (e) {
    console.error('❌ 创建备份失败:', e.message);
    sendError(res, 500, `创建备份失败: ${e.message}`);
  }
}

async function handleBackupList(req, res, _ctx) {
  try {
    const backupsDir = path.join(DATA_DIR, 'backups');
    
    if (!fs.existsSync(backupsDir)) {
      sendJson(res, 200, { success: true, data: { backups: [] } });
      return;
    }
    
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('crabpaw-backup-') && f.endsWith('.json'))
      .map(f => {
        const fullPath = path.join(backupsDir, f);
        const stat = fs.statSync(fullPath);
        return {
          name: f,
          size: stat.size,
          createdAt: stat.birthtime,
          modifiedAt: stat.mtime
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    sendJson(res, 200, { success: true, data: { backups: files } });
    
  } catch (e) {
    console.error('❌ 列出备份失败:', e.message);
    sendError(res, 500, `列出备份失败: ${e.message}`);
  }
}

async function handleBackupDownload(req, res, _ctx) {
  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const backupName = url.searchParams.get('name');
    
    if (!backupName) {
      return sendError(res, 400, '缺少备份名称');
    }
    
    if (backupName.includes('..') || backupName !== path.basename(backupName)) {
      return sendError(res, 400, '无效的备份名称');
    }
    
    const backupPath = path.join(DATA_DIR, 'backups', backupName);
    
    if (!fs.existsSync(backupPath)) {
      return sendError(res, 404, '备份不存在');
    }
    
    const stat = fs.statSync(backupPath);
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${backupName}"`,
      'Content-Length': stat.size
    });
    
    fs.createReadStream(backupPath).pipe(res);
    
  } catch (e) {
    console.error('❌ 下载备份失败:', e.message);
    sendError(res, 500, `下载备份失败: ${e.message}`);
  }
}

async function handleBackupRestore(req, res, _ctx) {
  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const backupName = url.searchParams.get('name') || (await readJsonBody(req).catch(() => ({}))).name;
    
    if (!backupName) {
      return sendError(res, 400, '缺少备份名称');
    }
    
    if (backupName.includes('..') || backupName !== path.basename(backupName)) {
      return sendError(res, 400, '无效的备份名称');
    }
    
    const backupPath = path.join(DATA_DIR, 'backups', backupName);
    
    if (!fs.existsSync(backupPath)) {
      return sendError(res, 404, '备份不存在');
    }
    
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));

    const restoreData = (data, targetDir) => {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      for (const [key, value] of Object.entries(data)) {
        const itemPath = path.join(targetDir, key);

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          if (Object.prototype.hasOwnProperty.call(value, 'content') || key.includes('.')) {
            fs.writeFileSync(itemPath, JSON.stringify(value, null, 2));
          } else {
            restoreData(value, itemPath);
          }
        } else {
          fs.writeFileSync(itemPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        }
      }
    };
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const preBackupName = `pre-restore-${timestamp}.json`;
    const preBackupPath = path.join(DATA_DIR, 'backups', preBackupName);
    
    const preBackup = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      note: '恢复前自动备份',
      data: {}
    };
    
    const collectCurrentData = function collectCurrentData(dir, baseRelPath = '') {
      const result = {};
      if (!fs.existsSync(dir)) return result;
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item === 'backups') continue;
        const fullPath = path.join(dir, item);
        const relPath = baseRelPath ? `${baseRelPath}/${item}` : item;
        if (shouldExclude(relPath)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          result[item] = collectCurrentData(fullPath, relPath);
        } else if (stat.isFile()) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            try {
              result[item] = JSON.parse(content);
            } catch (e) {
              console.warn('[Backup] Failed to parse', item, ':', e.message);
              result[item] = null;
            }
          } catch (e) {
            result[item] = `[error: ${e.message}]`;
          }
        }
      }
      return result;
    }
    
    preBackup.data = collectCurrentData(DATA_DIR);
    fs.writeFileSync(preBackupPath, JSON.stringify(preBackup, null, 2));
    console.log(`📦 恢复前已自动备份: ${preBackupName}`);
    
    restoreData(backup.data, DATA_DIR);
    
    console.log(`✅ 已从备份恢复: ${backupName}`);
    
    sendJson(res, 200, {
      success: true,
      data: {
        restoredFrom: backupName,
        preBackup: preBackupName,
        restoredAt: new Date().toISOString()
      }
    });
    
  } catch (e) {
    console.error('❌ 恢复备份失败:', e.message);
    sendError(res, 500, `恢复备份失败: ${e.message}`);
  }
}

async function handleBackupDelete(req, res, _ctx) {
  try {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const backupName = url.searchParams.get('name') || (await readJsonBody(req).catch(() => ({}))).name;
    
    if (!backupName) {
      return sendError(res, 400, '缺少备份名称');
    }
    
    if (backupName.includes('..') || backupName !== path.basename(backupName)) {
      return sendError(res, 400, '无效的备份名称');
    }
    
    const backupPath = path.join(DATA_DIR, 'backups', backupName);
    
    if (!fs.existsSync(backupPath)) {
      return sendError(res, 404, '备份不存在');
    }
    
    fs.unlinkSync(backupPath);
    
    console.log(`🗑️ 备份已删除: ${backupName}`);
    
    sendJson(res, 200, { success: true, data: { deleted: backupName } });
    
  } catch (e) {
    console.error('❌ 删除备份失败:', e.message);
    sendError(res, 500, `删除备份失败: ${e.message}`);
  }
}

module.exports = {
  handleBackupCreate,
  handleBackupList,
  handleBackupDownload,
  handleBackupRestore,
  handleBackupDelete
};
