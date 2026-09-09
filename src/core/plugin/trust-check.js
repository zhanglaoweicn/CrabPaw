/**
 * trust-check.js — 插件信任门禁（Phase 4a/D8, 2026-08-25）
 *
 * 商业生态安全基线（fail-closed 语义——声明的必须有效, 未声明的记录但不拒绝）：
 *   ① requiresHarness 兼容宣言：主版本不符 → 拒绝（插件/宿主代际错配绝不静默上线）
 *   ② permissions 权限域声明解析（历史"合法键无处理"病灶——现在解析入 runtime 供安全域消费,
 *      执行域强制（bash 批准链/path-rules 联动）为后续桥接, 本模块先行"声明即受约束记录"）
 *   ③ signature：sha256(稳定清单去 signature) —— 自签 hash-pin；x509 签名预留（商业市场版升级路径）
 */
const crypto = require('crypto');

/** harness 代际版本（权威点；与 HARNESS.md 治理版本对齐, 插件主版本契约以此为准） */
const HARNESS_VERSION = '2.4';

/** 稳定指纹：去 signature 字段的规范化 JSON（sha256 输入） */
function computeManifestFingerprint(manifest) {
  const clone = { ...manifest };
  delete clone.signature;
  delete clone._dir;
  return crypto.createHash('sha256')
    .update(JSON.stringify(clone, Object.keys(clone).sort()))
    .digest('hex');
}

/**
 * 解析权限域声明（manifest.permissions: {files?: string[], network?: bool, exec?: bool}）
 */
function parsePermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') {
    return { files: [], network: false, exec: false };
  }
  return {
    files: Array.isArray(permissions.files) ? permissions.files : [],
    network: permissions.network === true,
    exec: permissions.exec === true,
  };
}

/**
 * 信任门禁（纯函数——load() 与 SDK verify 共用）。
 * @returns {{ok: boolean, errors: string[], warnings: string[], trustLevel: string}}
 */
function checkPluginTrust(manifest) {
  const errors = [];
  const warnings = [];
  const trustLevel = manifest.signature ? 'signed' : 'unsigned';

  // requiresHarness：主版本必须匹配
  if (manifest.requiresHarness) {
    const reqMajor = String(manifest.requiresHarness).split('.')[0];
    const curMajor = String(HARNESS_VERSION).split('.')[0];
    if (reqMajor !== curMajor) {
      errors.push(`requiresHarness=${manifest.requiresHarness} 与当前 harness ${HARNESS_VERSION} 主版本不匹配`);
    } else if (String(manifest.requiresHarness) !== HARNESS_VERSION) {
      warnings.push(`requiresHarness=${manifest.requiresHarness} 高于/低于当前 ${HARNESS_VERSION}（minor 差异, 放行）`);
    }
  } else {
    warnings.push('未声明 requiresHarness（建议插件声明兼容版本）');
  }

  // permissions 解析（合法化——不再静默忽略）
  if (manifest.permissions !== undefined) {
    const p = parsePermissions(manifest.permissions);
    if (p.exec) warnings.push('声明了 exec 权限（高权插件, 运行时应受审批链约束）');
  }

  // signature 校验：声明了就必须有效（fail-closed）；未声明=unsigned（审计记录,不拒绝）
  // 优先级: signatureX509（正式证书签名）> signature（自签 hash-pin）> unsigned（提示）
  if (manifest.signatureX509) {
    try {
      const okX = verifyX509(manifest.signatureX509, manifest);
      if (!okX) errors.push('signatureX509 校验失败（证书签名与清单指纹不匹配—疑似篡改）');
    } catch (e) {
      errors.push(`signatureX509 校验异常: ${e.message}`);
    }
  } else if (manifest.signature) {
    const fp = computeManifestFingerprint(manifest);
    if (manifest.signature.toLowerCase() !== fp.toLowerCase()) {
      errors.push('signature 校验失败（清单内容与签名不匹配——疑似篡改）');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    trustLevel,
    permissions: parsePermissions(manifest.permissions),
  };
}

/**
 * x509 证书签名校验：manifest.signatureX509 = { cert: '<base64 DER 证书>', value: '<base64 签名>' }。
 * 签名原文 = 清单稳定指纹（sha256 hex→utf8）；验签用证书公钥（Node X509Certificate, runtime≥15）。
 * 开发者签名侧：SDK signFingerprintWithPem（或 openssl 标准流程）。
 */
function verifyX509(config, manifest) {
  const { X509Certificate, verify } = require('crypto');
  const cert = new X509Certificate(Buffer.from(config.cert, 'base64'));
  const fingerprint = computeManifestFingerprint(manifest);
  return verify('sha256', Buffer.from(fingerprint, 'utf8'), cert.publicKey, Buffer.from(config.value, 'base64'));
}

module.exports = {
  checkPluginTrust, computeManifestFingerprint, parsePermissions, verifyX509, HARNESS_VERSION,
};
