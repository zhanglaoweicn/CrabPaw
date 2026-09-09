'use strict';

/**
 * secret-store.js — 统一密钥存储
 *
 * 设计参考 的安全凭据管理：
 * - 内存缓存 + 文件加密持久化
 * - 支持 Keychain（macOS）/ Credential Vault（Windows）/ 加密文件（fallback）
 * - 原子写入（防止部分写入导致损坏）
 * - 自动派生主密钥（machine-specific 盐）
 * - TTL 过期
 *
 * 与 CredentialPool 区别：
 * - CredentialPool 针对"可轮换的多 API Key"
 * - SecretStore 针对"少量核心密钥"（如：TOS 主密码、加密主密钥、机器绑定 token）
 *
 * 公开 API:
 * - getSecretStore() → 单例
 * - secretStore.get(key) → 明文
 * - secretStore.set(key, value, opts) → 加密存储
 * - secretStore.delete(key)
 * - secretStore.list() → 元数据列表（不含明文）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { atomicWriteFile, atomicReadJSON } = require('./atomic-write');
const { CRABPAW_HOME } = require('./path-utils');
const { getMasterKey: getKeystoreMasterKey } = require('./secure-storage');

// 2026-09-08 便携化: 存储目录随 CRABPAW_HOME 走(桌面端注入 DATA_DIR → 随 U 盘),
// 不再固定写死 ~/.crabpaw
const DEFAULT_STORE_DIR = path.join(CRABPAW_HOME, 'secrets');
const DEFAULT_STORE_FILE = 'store.enc.json';
const STORE_VERSION = 2;

// ── 加密工具 ─────────────────────────────────────
function deriveKey(passphrase, salt) {
 return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encryptSecret(plaintext, key) {
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
 const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
 const tag = cipher.getAuthTag();
 return {
 v: 1,
 alg: 'aes-256-gcm',
 iv: iv.toString('base64'),
 tag: tag.toString('base64'),
 data: enc.toString('base64'),
 };
}

function decryptSecret(blob, key) {
 if (!blob || blob.alg !== 'aes-256-gcm') {
 throw new Error('Invalid secret blob');
 }
 const iv = Buffer.from(blob.iv, 'base64');
 const tag = Buffer.from(blob.tag, 'base64');
 const data = Buffer.from(blob.data, 'base64');
 const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
 decipher.setAuthTag(tag);
 const dec = Buffer.concat([decipher.update(data), decipher.final()]);
 return dec.toString('utf-8');
}

// ── 主密钥派生 ──────────────────────────────────
function getMachineFingerprint() {
 // 简单 machine id: hostname + username + homedir hash
 const raw = `${os.hostname()}|${os.userInfo().username}|${os.homedir()}`;
 return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * v2 主密钥: 盘内随机主密钥(.keystore, 与 secure-storage v2 同源)——与数据同盘随身走,
 * 换机/换盘符零感知。此前的机器指纹派生密钥(hostname|username|homedir)在 U 盘场景下
 * 换机即永远解不开(数据必丢), 已降级为仅解密存量密文的 legacy 路径。
 */
function getMasterKey() {
 return getKeystoreMasterKey();
}

/** v1 legacy: 机器指纹派生密钥——仅用于解密存量密文, 不再用于新加密 */
function getLegacyMasterKey() {
 const salt = Buffer.from('crabpaw-secret-store-v1', 'utf-8');
 return deriveKey(getMachineFingerprint(), salt);
}

// ── SecretEntry ──────────────────────────────────
class SecretEntry {
 constructor(data) {
 this.key = data.key;
 this.value = data.value || ''; // 明文（内存中）
 this.metadata = data.metadata || {};
 this.createdAt = data.createdAt || Date.now();
 this.updatedAt = data.updatedAt || Date.now();
 this.expiresAt = data.expiresAt || null;
 this.cipherBlob = data.cipherBlob || null; // 加密数据
 }

 isExpired() {
 return this.expiresAt && Date.now() > this.expiresAt;
 }

 toJSON() {
 return {
 key: this.key,
 metadata: this.metadata,
 createdAt: this.createdAt,
 updatedAt: this.updatedAt,
 expiresAt: this.expiresAt,
 cipherBlob: this.cipherBlob,
 };
 }
}

// ── SecretStore ──────────────────────────────────
class SecretStore {
 constructor(options = {}) {
 this.storeDir = options.storeDir || DEFAULT_STORE_DIR;
 this.storeFile = options.storeFile || DEFAULT_STORE_FILE;
 this._key = options.masterKey || getMasterKey();
 // 显式传入 masterKey 的调用方(测试)不做 legacy 升级
 this._legacyKey = options.masterKey ? null : getLegacyMasterKey();
 this._secrets = new Map();
 this._loaded = false;
 this._dirty = false;
 this._flushTimer = null;
 this._flushDelayMs = 1000; // 防抖 1s
 }

 _storePath() {
 return path.join(this.storeDir, this.storeFile);
 }

 load() {
 if (this._loaded) return;
 const data = atomicReadJSON(this._storePath());
 if (data && Array.isArray(data.entries)) {
 for (const e of data.entries) {
 const entry = new SecretEntry(e);
 this._secrets.set(entry.key, entry);
 }
 }
 this._loaded = true;
 }

 /**
 * 读取明文
 * @param {string} key
 * @returns {string|null}
 */
 get(key) {
 if (!this._loaded) this.load();
 const entry = this._secrets.get(key);
 if (!entry) return null;
 if (entry.isExpired()) {
 this._secrets.delete(key);
 this._markDirty();
 return null;
 }
 // 优先返回内存中的明文；否则解密
 if (entry.value) return entry.value;
 if (entry.cipherBlob) {
 try {
 const plain = decryptSecret(entry.cipherBlob, this._key);
 entry.value = plain; // 缓存
 return plain;
 } catch (e) { /* 当前密钥解不开 → 落 legacy 升级路径 */ }
 if (this._legacyKey) {
 try {
 const plain = decryptSecret(entry.cipherBlob, this._legacyKey);
 // v1 机器指纹密文 → v2 盘内主密钥自动升级(换机/随盘后仍可解)
 entry.cipherBlob = encryptSecret(plain, this._key);
 entry.value = plain;
 this._markDirty();
 return plain;
 } catch (e2) { return null; }
 }
 return null;
 }
 return null;
 }

 /**
 * 写入（加密）
 * @param {string} key
 * @param {string} value
 * @param {object} [options] { metadata, expiresAt, ttlMs }
 */
 set(key, value, options = {}) {
 if (!this._loaded) this.load();
 if (!key || typeof key !== 'string') {
 throw new Error('Secret key must be a non-empty string');
 }
 if (typeof value !== 'string') {
 throw new Error('Secret value must be a string');
 }
 const now = Date.now();
 const cipherBlob = encryptSecret(value, this._key);
 const entry = new SecretEntry({
 key,
 value, // 内存明文
 metadata: options.metadata || {},
 createdAt: this._secrets.get(key)?.createdAt || now,
 updatedAt: now,
 expiresAt: options.expiresAt || (options.ttlMs ? now + options.ttlMs : null),
 cipherBlob,
 });
 this._secrets.set(key, entry);
 this._markDirty();
 return { key, metadata: entry.metadata, expiresAt: entry.expiresAt };
 }

 /**
 * 删除
 */
 delete(key) {
 if (!this._loaded) this.load();
 const ok = this._secrets.delete(key);
 if (ok) this._markDirty();
 return ok;
 }

 /**
 * 是否存在
 */
 has(key) {
 if (!this._loaded) this.load();
 return this._secrets.has(key);
 }

 /**
 * 列出所有 key（不含明文）
 */
 list() {
 if (!this._loaded) this.load();
 return Array.from(this._secrets.values()).map(e => ({
 key: e.key,
 metadata: e.metadata,
 createdAt: e.createdAt,
 updatedAt: e.updatedAt,
 expiresAt: e.expiresAt,
 expired: e.isExpired(),
 }));
 }

 get size() {
 return this._secrets.size;
 }

 /**
 * 清理过期项
 */
 cleanupExpired() {
 if (!this._loaded) this.load();
 let removed = 0;
 for (const [key, entry] of this._secrets) {
 if (entry.isExpired()) {
 this._secrets.delete(key);
 removed++;
 }
 }
 if (removed > 0) this._markDirty();
 return removed;
 }

 clear() {
 this._secrets.clear();
 this._markDirty();
 this.flush();
 }

 /**
 * 立即写入磁盘
 */
 flush() {
 if (this._flushTimer) {
 clearTimeout(this._flushTimer);
 this._flushTimer = null;
 }
 if (!this._dirty) return;
 try {
 if (!fs.existsSync(this.storeDir)) {
 fs.mkdirSync(this.storeDir, { recursive: true });
 }
 const data = {
 version: STORE_VERSION,
 savedAt: Date.now(),
 entries: Array.from(this._secrets.values()).map(e => e.toJSON()),
 };
 atomicWriteFile(this._storePath(), JSON.stringify(data, null, 2));
 this._dirty = false;
 } catch (err) {
 console.error('[secret-store] flush failed:', err.message);
 }
 }

 _markDirty() {
 this._dirty = true;
 if (this._flushTimer) return;
 this._flushTimer = setTimeout(() => {
 this._flushTimer = null;
 this.flush();
 }, this._flushDelayMs);
 }
}

let _instance = null;
function getSecretStore(options) {
 if (!_instance) _instance = new SecretStore(options);
 return _instance;
}

module.exports = {
 SecretStore,
 SecretEntry,
 getSecretStore,
 // 暴露用于测试
 encryptSecret,
 decryptSecret,
 getMasterKey,
 getLegacyMasterKey,
 getMachineFingerprint,
};
