const path = require('path');
const os = require('os');
const fs = require('fs');

function getHomeDir() {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
  }
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
const HOME_DIR = getHomeDir();
const CRABPAW_HOME = process.env.CRABPAW_HOME || path.join(HOME_DIR, '.crabpaw');

function normalizePath(inputPath) {
  if (!inputPath) return '';
  let normalized = path.normalize(inputPath);

  if (normalized.startsWith('~')) {
    normalized = path.join(HOME_DIR, normalized.slice(1));
  }

  if (process.platform === 'win32') {
    normalized = normalized.replace(/\//g, '\\');
    const lowerNormalized = normalized.toLowerCase();
    const lowerHome = HOME_DIR.toLowerCase();
    if (lowerNormalized.startsWith(lowerHome)) {
      normalized = HOME_DIR + normalized.slice(HOME_DIR.length);
    }
  }

  return normalized;
}

function isSubPath(parentPath, childPath) {
  const normParent = normalizePath(parentPath).toLowerCase();
  const normChild = normalizePath(childPath).toLowerCase();
  return normChild.startsWith(normParent + path.sep) || normChild === normParent;
}

function ensureDir(dirPath) {
  const normalized = normalizePath(dirPath);
  if (!fs.existsSync(normalized)) {
    fs.mkdirSync(normalized, { recursive: true });
  }
  return normalized;
}

function safeJoin(...parts) {
  const joined = path.join(...parts);
  return normalizePath(joined);
}

function getCrabPawSubDir(...subPath) {
  const dir = safeJoin(CRABPAW_HOME, ...subPath);
  return ensureDir(dir);
}

function toPosixPath(inputPath) {
  return normalizePath(inputPath).replace(/\\/g, '/');
}

function toNativePath(inputPath) {
  return normalizePath(inputPath);
}

module.exports = {
  HOME_DIR,
  CRABPAW_HOME,
  getHomeDir,
  normalizePath,
  isSubPath,
  ensureDir,
  safeJoin,
  getCrabPawSubDir,
  toPosixPath,
  toNativePath,
};
