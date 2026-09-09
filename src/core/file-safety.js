const fs = require('fs');
const path = require('path');
const os = require('os');

function _home() {
  return fs.realpathSync(os.homedir());
}

function buildWriteDeniedPaths() {
  const home = _home();
  const crabpawHome = process.env.CRABPAW_DATA_DIR
    ? fs.realpathSync(process.env.CRABPAW_DATA_DIR)
    : path.join(__dirname, '..', '..', 'data', '.crabpaw');
  const paths = [
    path.join(home, '.ssh', 'authorized_keys'),
    path.join(home, '.ssh', 'id_rsa'),
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.ssh', 'config'),
    path.join(crabpawHome, '.env'),
    path.join(home, '.bashrc'),
    path.join(home, '.zshrc'),
    path.join(home, '.profile'),
    path.join(home, '.bash_profile'),
    path.join(home, '.zprofile'),
    path.join(home, '.netrc'),
    path.join(home, '.pgpass'),
    path.join(home, '.npmrc'),
    path.join(home, '.pypirc'),
  ];
  if (process.platform !== 'win32') {
    paths.push('/etc/sudoers', '/etc/passwd', '/etc/shadow');
  }
  return new Set(paths.map(p => {
    try { return fs.realpathSync(p); } catch { return p; }
  }));
}

function buildWriteDeniedPrefixes() {
  const home = _home();
  const prefixes = [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.kube'),
    path.join(home, '.docker'),
    path.join(home, '.azure'),
    path.join(home, '.config', 'gh'),
  ];
  if (process.platform !== 'win32') {
    prefixes.push('/etc/sudoers.d', '/etc/systemd');
  }
  return prefixes.map(p => {
    try { return fs.realpathSync(p) + path.sep; } catch { return p + path.sep; }
  });
}

function getSafeWriteRoot() {
  const root = process.env.CRABPAW_WRITE_SAFE_ROOT || '';
  if (!root) return null;
  try {
    return fs.realpathSync(root);
  } catch {
    return null;
  }
}

const _deniedPathsCache = { value: null, home: '' };
const _deniedPrefixesCache = { value: null, home: '' };

function _getCachedDeniedPaths() {
  const home = _home();
  if (!_deniedPathsCache.value || _deniedPathsCache.home !== home) {
    _deniedPathsCache.value = buildWriteDeniedPaths();
    _deniedPathsCache.home = home;
  }
  return _deniedPathsCache.value;
}

function _getCachedDeniedPrefixes() {
  const home = _home();
  if (!_deniedPrefixesCache.value || _deniedPrefixesCache.home !== home) {
    _deniedPrefixesCache.value = buildWriteDeniedPrefixes();
    _deniedPrefixesCache.home = home;
  }
  return _deniedPrefixesCache.value;
}

function isWriteDenied(filePath) {
  let resolved;
  try {
    resolved = fs.realpathSync(filePath);
  } catch {
    resolved = path.resolve(filePath);
  }
  if (_getCachedDeniedPaths().has(resolved)) {
    return { denied: true, reason: 'protected_path', path: resolved };
  }
  const prefixes = _getCachedDeniedPrefixes();
  for (const prefix of prefixes) {
    if (resolved.startsWith(prefix)) {
      return { denied: true, reason: 'protected_directory', path: resolved, prefix };
    }
  }
  const safeRoot = getSafeWriteRoot();
  if (safeRoot && !resolved.startsWith(safeRoot)) {
    return { denied: true, reason: 'outside_safe_root', path: resolved, safeRoot };
  }
  return { denied: false };
}

function isReadSensitive(filePath) {
  const SENSITIVE_PATTERNS = [
    /\.env($|\.)/,
    /credentials/i,
    /\.netrc$/,
    /\.pgpass$/,
    /\.pypirc$/,
    /id_rsa$/,
    /id_ed25519$/,
    /\.ssh\/config$/,
    /\.aws\//,
    /\.gnupg\//,
    /\.kube\//,
  ];
  const resolved = path.resolve(filePath);
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(resolved)) {
      return { sensitive: true, reason: 'sensitive_file', path: resolved };
    }
  }
  return { sensitive: false };
}

function validateWritePath(filePath) {
  const check = isWriteDenied(filePath);
  if (check.denied) {
    const messages = {
      protected_path: `禁止写入受保护的文件: ${check.path}`,
      protected_directory: `禁止写入受保护的目录: ${check.path}`,
      outside_safe_root: `写入路径超出安全根目录: ${check.path}`,
    };
    return {
      allowed: false,
      reason: check.reason,
      message: messages[check.reason] || '写入被拒绝',
    };
  }
  return { allowed: true };
}

module.exports = {
  buildWriteDeniedPaths,
  buildWriteDeniedPrefixes,
  getSafeWriteRoot,
  isWriteDenied,
  isReadSensitive,
  validateWritePath,
};
