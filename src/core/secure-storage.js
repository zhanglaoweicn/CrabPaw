const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');


const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;          // v1（指纹公式）IV 长度，仅解密旧密文用
const V2_IV_LENGTH = 12;       // v2（主密钥方案）标准 GCM IV
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ITERATIONS = 100000;
const MASTER_KEY_LENGTH = 32;

let machineKey = null;
let masterKeyCache = null;

/**
 * ── 方案演进（2026-09-02 便携化改造）────────────────────────────
 * v1（enc: 无版本头）：密钥 = PBKDF2(机器指纹)。指纹含 MAC 地址列表——
 *   VPN/网卡/Wi-Fi 切换即变，每次重启都在掷骰子，密钥反复"消失"；
 *   且项目将跑在 U 盘/移动硬盘上，任何主机绑定方案都不可用。
 * v2（enc:v2:）：盘内随机主密钥 .keystore（与数据同盘随身走，换机零感知）。
 *   旧格式解密成功后由 config.loadApiKeys 自动重加密升级（详见 isCurrentFormat）。
 * ──────────────────────────────────────────────────────────────
 */

/** .keystore 路径——与 config.js 同源解析（env 优先，随盘走） */
function getKeystorePath() {
  const dataDir = process.env.CRABPAW_DATA_DIR
    || path.join(__dirname, '..', '..', 'data', '.crabpaw');
  return path.join(dataDir, '.keystore');
}

/** 盘内随机主密钥：首次生成（wx 独占创建防竞态），此后只读 */
function getMasterKey() {
  if (masterKeyCache) return masterKeyCache;
  const keystorePath = getKeystorePath();

  if (fs.existsSync(keystorePath)) {
    try {
      const buf = Buffer.from(fs.readFileSync(keystorePath, 'utf8').trim(), 'base64');
      if (buf.length === MASTER_KEY_LENGTH) {
        masterKeyCache = buf;
        return buf;
      }
      console.warn(`[secure-storage] .keystore 长度异常(${buf.length}B，应为 ${MASTER_KEY_LENGTH}B)——将重新生成；已有 v2 密文将无法解密`);
    } catch (e) {
      console.warn(`[secure-storage] .keystore 读取失败(${e.message})——将重新生成`);
    }
  }

  const key = crypto.randomBytes(MASTER_KEY_LENGTH);
  try {
    fs.mkdirSync(path.dirname(keystorePath), { recursive: true });
    fs.writeFileSync(keystorePath, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      // 并发进程已创建——读取对方的
      const buf = Buffer.from(fs.readFileSync(keystorePath, 'utf8').trim(), 'base64');
      if (buf.length === MASTER_KEY_LENGTH) {
        masterKeyCache = buf;
        return buf;
      }
    }
    throw e;
  }
  masterKeyCache = key;
  return key;
}

// ── 机器指纹（v1/legacy 仅用于解密存量密文，不再用于新加密）────────

function getMachineId() {
  const interfaces = os.networkInterfaces();
  const macs = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macs.push(iface.mac);
      }
    }
  }

  const hostname = os.hostname();
  const platform = os.platform();
  const arch = os.arch();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';

  // 仅使用稳定特征：MAC/hostname/platform/arch/cpuModel
  // 不包含 totalMem（OS更新/Docker会变）和 homeDir（盘符变化会变）
  const machineData = [
    macs.sort().join(','),
    hostname,
    platform,
    arch,
    cpuModel,
  ].join('|');

  return crypto.createHash('sha256').update(machineData).digest('hex');
}

// 旧版 getMachineId（Release v3 及之前），用于兼容旧加密数据
function getMachineIdLegacy() {
  const interfaces = os.networkInterfaces();
  const macs = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
        macs.push(iface.mac);
      }
    }
  }

  const hostname = os.hostname();
  const platform = os.platform();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';

  const machineData = [
    macs.sort().join(','),
    hostname,
    platform,
    cpuModel
  ].join('|');

  return crypto.createHash('sha256').update(machineData).digest('hex');
}

function deriveKey(salt) {
  if (!machineKey) {
    machineKey = getMachineId();
  }
  return crypto.pbkdf2Sync(machineKey, salt, ITERATIONS, 32, 'sha256');
}

function deriveKeyLegacy(salt) {
  const legacyKey = getMachineIdLegacy();
  return crypto.pbkdf2Sync(legacyKey, salt, ITERATIONS, 32, 'sha256');
}

// ── v2：盘内随机主密钥 ──────────────────────────────────────────

function encryptV2(plaintext) {
  const iv = crypto.randomBytes(V2_IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return 'enc:v2:' + Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptV2(payload) {
  const data = Buffer.from(payload, 'base64');
  const iv = data.subarray(0, V2_IV_LENGTH);
  const authTag = data.subarray(V2_IV_LENGTH, V2_IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(V2_IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getMasterKey(), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ── v1/legacy：机器指纹公式（存量密文解密 + 测试/迁移种子用）──────

/** 当前指纹公式（enc: 无版本头）——仅供解密存量与迁移种子，不再用于新数据 */
function _encryptWithFingerprint(plaintext) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  const result = Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'base64')]);
  return 'enc:' + result.toString('base64');
}

/** legacy 指纹公式（v3 前，无 arch）——仅供解密存量与迁移种子 */
function _encryptWithLegacyFingerprint(plaintext) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKeyLegacy(salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  const result = Buffer.concat([salt, iv, authTag, Buffer.from(encrypted, 'base64')]);
  return 'enc:' + result.toString('base64');
}

function _decryptWithFingerprints(data) {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  // 尝试当前密钥解密
  try {
    const key = deriveKey(salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    // 当前密钥失败，回退到旧版密钥
    console.warn('[secure-storage.js] 空 catch 补日志:', e && e.message);
  }

  // 回退到旧版密钥解密（兼容 Release v3 及之前版本加密的数据）
  try {
    const legacyKey = deriveKeyLegacy(salt);
    const decipher = crypto.createDecipheriv(ALGORITHM, legacyKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    console.log('🔓 使用旧版密钥解密成功，建议重新加密以升级密钥');
    return decrypted;
  } catch (error) {
    console.error('解密失败（当前密钥和旧版密钥均无法解密）:', error.message);
    return null;
  }
}

// ── 公共 API（消费方契约不变）────────────────────────────────────

/** 当前格式判定：saveApiKeys/loadApiKeys 据此决定是否重加密升级 */
function isCurrentFormat(value) {
  return typeof value === 'string' && value.startsWith('enc:v2:');
}

function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    return plaintext;
  }
  return encryptV2(plaintext);
}

function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    return ciphertext;
  }

  if (ciphertext.startsWith('enc:v2:')) {
    try {
      return decryptV2(ciphertext.slice('enc:v2:'.length));
    } catch (e) {
      console.error('[secure-storage] v2 解密失败（.keystore 缺失/被换？）:', e && e.message);
      return null;
    }
  }

  if (!ciphertext.startsWith('enc:')) {
    return ciphertext;
  }

  const data = Buffer.from(ciphertext.slice(4), 'base64');
  return _decryptWithFingerprints(data);
}

function isEncrypted(value) {
  return value && typeof value === 'string' && value.startsWith('enc:');
}

function encryptApiKey(apiKey) {
  if (!apiKey || isEncrypted(apiKey)) {
    return apiKey;
  }
  return encrypt(apiKey);
}

function decryptApiKey(encryptedKey) {
  if (!encryptedKey) {
    return encryptedKey;
  }
  if (isEncrypted(encryptedKey)) {
    return decrypt(encryptedKey);
  }
  return encryptedKey;
}

function encryptApiKeysFile(apiKeysPath) {
  if (!fs.existsSync(apiKeysPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(apiKeysPath, 'utf-8');
    const apiKeys = JSON.parse(content);

    let changed = false;
    for (const [key, value] of Object.entries(apiKeys)) {
      // 明文 → v2；旧指纹格式（v1/legacy）→ v2（升级真实发生，不再是"建议"）
      if (value && !isCurrentFormat(value)) {
        apiKeys[key] = encryptApiKey(value);
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(apiKeysPath, JSON.stringify(apiKeys, null, 2));
      console.log('✅ API Keys 已加密存储（v2 主密钥格式）');
    }
  } catch (error) {
    console.error('加密 API Keys 文件失败:', error.message);
  }
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  isCurrentFormat,
  encryptApiKey,
  decryptApiKey,
  encryptApiKeysFile,
  getMasterKey,
  // 迁移/测试辅助：旧公式密文种子（勿用于新数据）
  _encryptWithFingerprint,
  _encryptWithLegacyFingerprint
};
