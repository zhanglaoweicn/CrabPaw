/**
 * FilesystemGuard - 文件系统边界控制
 * 
 * 限制 Agent 只能访问特定目录
 * 阻止访问系统敏感路径
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// 展开 ~ 为实际 home 目录
function _expandHome(p) {
  if (!p) return p;
  const home = os.homedir();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

function _expandPaths(paths) {
  return paths.map(_expandHome).filter(Boolean);
}

const DEFAULT_BLOCKED_PATHS = _expandPaths([
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/root',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '~/.ssh',
  '~/.gnupg',
  '~/.config/gh',
  process.platform === 'win32' ? 'C:\\Windows' : null,
  process.platform === 'win32' ? 'C:\\Windows\\System32' : null,
  process.platform === 'win32' ? 'C:\\Windows\\SysWOW64' : null,
  process.platform === 'win32' ? 'C:\\Program Files' : null,
  process.platform === 'win32' ? 'C:\\Program Files (x86)' : null,
  process.platform === 'win32' ? 'C:\\ProgramData' : null,
  process.platform === 'win32' ? 'C:\\Users\\All Users' : null,
  process.platform === 'win32' ? 'C:\\$Recycle.Bin' : null,
  process.platform === 'win32' ? 'C:\\System Volume Information' : null,
  process.platform === 'win32' ? 'C:\\Recovery' : null,
  process.platform === 'win32' ? 'C:\\PerfLogs' : null,
  // Windows 用户敏感目录
  process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Credentials') : null,
  process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Credentials') : null,
  process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Vault') : null,
]);

const WRITE_DENIED_PATHS = _expandPaths([
  '~/.ssh/authorized_keys',
  '~/.ssh/known_hosts',
  '~/.ssh/id_rsa',
  '~/.ssh/id_ed25519',
  '~/.ssh/id_ecdsa',
  '~/.ssh/id_dsa',
  '~/.ssh/config',
  '~/.gnupg/',
  '~/.bashrc',
  '~/.zshrc',
  '~/.profile',
  '~/.bash_profile',
  '~/.bash_login',
  '~/.netrc',
  '~/.pgpass',
  '~/.gitconfig',
  '~/.npmrc',
  '~/.pypirc',
  '~/.aws/credentials',
  '~/.aws/config',
  '~/.config/gh/hosts.yml',
  '~/.docker/config.json',
  '~/.kube/config',
  '.env',
  '.env.local',
  '.env.production',
  '.env.staging',
  '/etc/sudoers',
  '/etc/passwd',
  '/etc/shadow',
  '/etc/ssh/sshd_config',
  '/etc/hosts',
  '/etc/resolv.conf',
  process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Credentials') : null,
  process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Credentials') : null,
]);

const WRITE_DENIED_PATTERNS = [
  /\.anthropic_oauth\.json$/i,
  /\.claude\/credentials/i,
  /\.openai_api_key/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
  /\.kube\/config$/i,
  /\.docker\/config\.json$/i,
];

const SENSITIVE_PATTERNS = [
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials/i,
  /secrets?$/i,
  /\.htpasswd$/i,
  /\.netrc$/i,
  /_history$/i,
  /\.bash_history$/i
];

const NTFS_ADS_PATTERN = /:[^:\\/]+$|::\$DATA$/i;
const UNC_PATH_PATTERN = /^\\\\[^\\]+\\/;
const WINDOWS_DEVICE_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

class FilesystemGuard {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      strictMode: config.strictMode || false,
      allowedPaths: config.allowedPaths || [],
      blockedPaths: [...DEFAULT_BLOCKED_PATHS, ...(config.blockedPaths || [])],
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024,
      allowSensitivePatterns: config.allowSensitivePatterns || false,
      ...config
    };
    
    this._baseDir = process.cwd();
    this._dataDir = path.join(this._baseDir, 'data');
    
    this._stats = {
      checks: 0,
      allowed: 0,
      blocked: 0,
      warnings: 0
    };
  }

  async initialize() {
    if (this.config.allowedPaths.length === 0) {
      this.config.allowedPaths = [
        this._dataDir,
        path.join(this._dataDir, '.crabpaw'),
        path.join(this._dataDir, 'workspace'),
        path.join(this._dataDir, 'projects')
      ];
    }
    
    for (const allowedPath of this.config.allowedPaths) {
      if (!path.isAbsolute(allowedPath)) {
        const absolutePath = path.join(this._baseDir, allowedPath);
        const idx = this.config.allowedPaths.indexOf(allowedPath);
        this.config.allowedPaths[idx] = absolutePath;
      }
    }
    
    console.log('📁 文件系统守卫已初始化');
    console.log('  允许的路径:', this.config.allowedPaths);
  }

  check(filePath, operation = 'read') {
    this._stats.checks++;
    
    if (!this.config.enabled) {
      this._stats.allowed++;
      return { allowed: true, reason: '文件系统守卫未启用' };
    }
    
    const normalizedPath = this._normalizePath(filePath);

    const winCheck = this._checkWindowsSecurity(normalizedPath, filePath);
    if (winCheck.blocked) {
      this._stats.blocked++;
      return {
        allowed: false,
        blocked: true,
        reason: winCheck.reason,
        path: normalizedPath
      };
    }

    const blockedCheck = this._checkBlocked(normalizedPath);
    if (blockedCheck.blocked) {
      this._stats.blocked++;
      return {
        allowed: false,
        blocked: true,
        reason: blockedCheck.reason,
        path: normalizedPath
      };
    }
    
    if (operation === 'write' || operation === 'delete') {
      const writeDeniedCheck = this._checkWriteDenied(normalizedPath);
      if (writeDeniedCheck.denied) {
        this._stats.blocked++;
        return {
          allowed: false,
          blocked: true,
          reason: writeDeniedCheck.reason,
          path: normalizedPath
        };
      }
    }
    
    if (this.config.strictMode) {
      const allowedCheck = this._checkAllowed(normalizedPath);
      if (!allowedCheck.allowed) {
        this._stats.blocked++;
        return {
          allowed: false,
          blocked: true,
          reason: allowedCheck.reason,
          path: normalizedPath
        };
      }
    }
    
    const sensitiveCheck = this._checkSensitive(normalizedPath);
    if (sensitiveCheck.sensitive && !this.config.allowSensitivePatterns) {
      if (operation === 'write' || operation === 'delete') {
        this._stats.warnings++;
        return {
          allowed: false,
          blocked: true,
          reason: `敏感文件操作被阻止: ${sensitiveCheck.reason}`,
          path: normalizedPath,
          warning: true
        };
      }
    }
    
    if (operation === 'write' || operation === 'read') {
      const sizeCheck = this._checkSize(normalizedPath, operation);
      if (sizeCheck.exceeded) {
        this._stats.blocked++;
        return {
          allowed: false,
          blocked: true,
          reason: sizeCheck.reason,
          path: normalizedPath
        };
      }
    }
    
    this._stats.allowed++;
    return {
      allowed: true,
      path: normalizedPath,
      warning: sensitiveCheck.sensitive ? sensitiveCheck.reason : null
    };
  }

  _normalizePath(filePath) {
    if (typeof filePath !== 'string') {
      throw new Error('路径必须是字符串');
    }

    let normalized = filePath.replace(/\0/g, '');

    if (normalized.includes('..')) {
      const segments = normalized.replace(/\\/g, '/').split('/');
      const resolved = [];
      for (const seg of segments) {
        if (seg === '..') {
          if (resolved.length > 0) resolved.pop();
        } else if (seg !== '.') {
          resolved.push(seg);
        }
      }
      normalized = resolved.join(path.sep);
    }

    if (normalized.startsWith('~')) {
      normalized = path.join(process.env.HOME || process.env.USERPROFILE || '', normalized.slice(1));
    }

    if (!path.isAbsolute(normalized)) {
      normalized = path.join(this._baseDir, normalized);
    }

    normalized = path.resolve(normalized);

    return normalized;
  }

  _normalizeForComparison(filePath) {
    let normalized = filePath.replace(/\0/g, '');
    normalized = normalized.replace(/\\/g, '/').toLowerCase();
    normalized = normalized.replace(/\/+/g, '/');
    return normalized;
  }

  _checkBlocked(filePath) {
    const normalizedInput = this._normalizeForComparison(filePath);

    for (const blocked of this.config.blockedPaths) {
      let normalizedBlocked = this._normalizeForComparison(blocked);

      if (normalizedBlocked.startsWith('~/') || normalizedBlocked === '~') {
        const homePath = this._normalizeForComparison(process.env.HOME || process.env.USERPROFILE || '');
        normalizedBlocked = homePath + normalizedBlocked.slice(1);
      }

      if (normalizedInput.startsWith(normalizedBlocked)) {
        return {
          blocked: true,
          reason: `路径在阻止列表中: ${blocked}`
        };
      }
    }

    return { blocked: false };
  }

  _checkWriteDenied(filePath) {
    const normalizedInput = this._normalizeForComparison(filePath);

    for (const deniedPath of WRITE_DENIED_PATHS) {
      let normalizedDenied = this._normalizeForComparison(deniedPath);

      if (normalizedDenied.startsWith('~/')) {
        const homePath = this._normalizeForComparison(process.env.HOME || process.env.USERPROFILE || '');
        normalizedDenied = homePath + normalizedDenied.slice(1);
      }

      if (normalizedDenied.endsWith('/')) {
        if (normalizedInput.startsWith(normalizedDenied)) {
          return {
            denied: true,
            reason: `写入被拒绝: 受保护路径 ${deniedPath}`
          };
        }
      } else {
        if (normalizedInput === normalizedDenied || normalizedInput.startsWith(normalizedDenied + '/')) {
          return {
            denied: true,
            reason: `写入被拒绝: 受保护文件 ${deniedPath}`
          };
        }
      }
    }

    for (const pattern of WRITE_DENIED_PATTERNS) {
      if (pattern.test(normalizedInput)) {
        return {
          denied: true,
          reason: `写入被拒绝: 文件路径匹配受保护模式`
        };
      }
    }

    return { denied: false };
  }

  _checkWindowsSecurity(normalizedPath, rawPath) {
    if (process.platform !== 'win32') return { blocked: false };

    if (NTFS_ADS_PATTERN.test(rawPath)) {
      return {
        blocked: true,
        reason: 'NTFS 备用数据流(ADS)路径被阻止'
      };
    }

    if (UNC_PATH_PATTERN.test(rawPath)) {
      return {
        blocked: true,
        reason: 'UNC 网络路径被阻止'
      };
    }

    const fileName = path.basename(normalizedPath).replace(/\.[^.]+$/, '');
    if (WINDOWS_RESERVED_NAMES.has(fileName.toUpperCase())) {
      return {
        blocked: true,
        reason: `Windows 保留设备名被阻止: ${fileName}`
      };
    }

    if (WINDOWS_DEVICE_PATTERN.test(path.basename(normalizedPath))) {
      return {
        blocked: true,
        reason: `Windows 设备名被阻止`
      };
    }

    const lowerPath = normalizedPath.toLowerCase();
    const dangerousExtensions = ['.scr', '.pif', '.com', '.vbs', '.vbe', '.wsh', '.wsf', '.hta', '.cpl', '.inf'];
    for (const ext of dangerousExtensions) {
      if (lowerPath.endsWith(ext)) {
        return {
          blocked: true,
          reason: `危险可执行扩展名被阻止: ${ext}`
        };
      }
    }

    return { blocked: false };
  }

  _checkAllowed(filePath) {
    const normalizedInput = this._normalizeForComparison(filePath);

    for (const allowed of this.config.allowedPaths) {
      const normalizedAllowed = this._normalizeForComparison(allowed);
      if (normalizedInput.startsWith(normalizedAllowed)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: '路径不在允许列表中 (严格模式)'
    };
  }

  _checkSensitive(filePath) {
    const fileName = path.basename(filePath);
    
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(fileName)) {
        return {
          sensitive: true,
          reason: `文件名匹配敏感模式: ${pattern.source || pattern}`
        };
      }
    }
    
    return { sensitive: false };
  }

  _checkSize(filePath, operation) {
    if (operation === 'read' && fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > this.config.maxFileSize) {
          return {
            exceeded: true,
            reason: `文件大小超过限制 (${(stats.size / 1024 / 1024).toFixed(2)}MB > ${(this.config.maxFileSize / 1024 / 1024).toFixed(2)}MB)`
          };
        }
      } catch (e) {
        return { exceeded: false };
      }
    }
    
    return { exceeded: false };
  }

  addAllowedPath(dirPath) {
    const normalized = path.isAbsolute(dirPath) 
      ? dirPath 
      : path.join(this._baseDir, dirPath);
    
    if (!this.config.allowedPaths.includes(normalized)) {
      this.config.allowedPaths.push(normalized);
    }
  }

  removeAllowedPath(dirPath) {
    const normalized = path.isAbsolute(dirPath) 
      ? dirPath 
      : path.join(this._baseDir, dirPath);
    
    const idx = this.config.allowedPaths.indexOf(normalized);
    if (idx >= 0) {
      this.config.allowedPaths.splice(idx, 1);
    }
  }

  addBlockedPath(dirPath) {
    if (!this.config.blockedPaths.includes(dirPath)) {
      this.config.blockedPaths.push(dirPath);
    }
  }

  getStats() {
    return { ...this._stats };
  }

  enable() {
    this.config.enabled = true;
  }

  disable() {
    this.config.enabled = false;
  }

  setStrictMode(enabled) {
    this.config.strictMode = enabled;
  }
}

module.exports = FilesystemGuard;
