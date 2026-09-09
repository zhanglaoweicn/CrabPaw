/**
 * upload-path.js — 企微发送路径白名单判定（发布 S-2b 安全，2026-09-07 扩展）。
 * wecom 代理（handlers/local-handlers/wecom.js）与工具层（tools/file-tools.js）
 * 共用同一判定。
 *
 * 2026-09-07 扩展（用户需求：语音/文本/文件卡直发生成的文档与网页）：
 * 允许集合从仅 DATA_DIR/uploads 扩展为——
 *   1. DATA_DIR/uploads                  用户上传的文件（原白名单）
 *   2. <repo>/data/workspace             生成产物落盘目录（documents/、html 看板等）
 * 同时加**敏感文件黑名单**双层防护：config.json/user.json/.env/.api_token/
 * approval.key 等数据目录敏感文件与 *.key/*.pem 证书，即使将来被移入白名单目录
 * 也一律拒绝外发。
 *
 * 纯字符串/路径逻辑，无 fs 依赖——单测无需真实目录。
 */
const path = require('path');

// 敏感文件黑名单（按文件名/扩展名，大小写不敏感）——无论位于哪个目录都不允许外发
const SENSITIVE_BASENAMES = new Set([
  'config.json', 'user.json', '.env', '.api_token', '.api_keys.json',
  '.instance.lock', 'approval.key', 'secret.key', 'credentials.json',
]);
const SENSITIVE_EXTS = new Set(['.key', '.pem', '.p12', '.pfx']);

function isSensitivePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath);
  const base = path.basename(resolved).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  return SENSITIVE_EXTS.has(path.extname(resolved).toLowerCase());
}

function isAllowedSendPath(filePath, dataDir) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (!dataDir || typeof dataDir !== 'string') return false;
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return false;
  const repoDataDir = path.resolve(dataDir, '..'); // dataDir=data/<X> → <repo>/data
  const allowedRoots = [
    path.resolve(path.join(dataDir, 'uploads')),       // 用户上传
    path.resolve(repoDataDir, 'workspace'),            // 生成产物（data/workspace/documents 等）
  ];
  return allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
}

// 兼容别名——历史调用方（wecom 代理/工具层/测试）沿用旧名
const isAllowedUploadPath = isAllowedSendPath;

module.exports = { isAllowedSendPath, isAllowedUploadPath, isSensitivePath };
