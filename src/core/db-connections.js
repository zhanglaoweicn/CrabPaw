/**
 * db-connections — 命名数据源持久化（DatabaseConfig 工具后端）
 *
 * 用户在对话里配置一次数据库连接（host/user/password 等），落盘到
 * DATA_DIR/db-connections.json；此后 DatabaseQuery/ListTables 未传
 * 连接参数时自动回退到默认（或 connection 指定名的）数据源，
 * 无需每次重复提供连接信息。
 *
 * 安全模型：
 *   - 密码经 secure-storage 加密落盘（与 .api_keys.json 同一机制），
 *     历史明文记录在下次 save/加载时原样保留（解不出就当明文用），
 *     新写入一律加密
 *   - 对外列表输出密码掩码，杜绝明文回流对话/日志
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./config');
const { encrypt, decrypt, isEncrypted } = require('./secure-storage');
const { _maskToken } = require('./secret-redactor');

const FILE_VERSION = 1;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const DB_TYPES = ['sqlite', 'mysql', 'postgresql'];

function connectionsPath() {
  return path.join(getDataDir(), 'db-connections.json');
}

function _load() {
  const p = connectionsPath();
  if (!fs.existsSync(p)) return { version: FILE_VERSION, default: null, connections: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { version: FILE_VERSION, default: null, connections: {} };
    return {
      version: raw.version || FILE_VERSION,
      default: raw.default || null,
      connections: raw.connections && typeof raw.connections === 'object' ? raw.connections : {},
    };
  } catch (e) {
    console.warn('[db-connections] 配置文件解析失败，按空库处理:', e.message || e);
    return { version: FILE_VERSION, default: null, connections: {} };
  }
}

function _save(store) {
  const p = connectionsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2), 'utf-8');
}

function _decryptPassword(pw) {
  if (!pw) return '';
  if (isEncrypted(pw)) {
    try {
      return decrypt(pw);
    } catch (e) {
      console.warn('[db-connections] 密码解密失败:', e.message || e);
      return '';
    }
  }
  return pw; // 历史明文记录：原样返回
}

function _validate(record, { requireFull }) {
  const missing = [];
  if (!record.name || !NAME_PATTERN.test(record.name)) {
    return { ok: false, error: `数据源名不合法（须以字母/下划线开头，仅含字母数字下划线连字符，≤64 字符）: ${record.name}` };
  }
  if (!DB_TYPES.includes(record.type)) {
    return { ok: false, error: `不支持的数据库类型: ${record.type}。支持: ${DB_TYPES.join(', ')}` };
  }
  if (record.type === 'sqlite') {
    if (requireFull && !record.database) missing.push('database（SQLite 文件路径）');
  } else {
    if (requireFull && !record.host) missing.push('host');
    if (requireFull && !record.user) missing.push('user');
    if (requireFull && !record.password) missing.push('password');
    if (requireFull && !record.database) missing.push('database');
  }
  if (missing.length) {
    return { ok: false, error: `缺少必填字段: ${missing.join(', ')}` };
  }
  return { ok: true };
}

/**
 * 保存/更新数据源。密码强制加密落盘；首个数据源自动设为默认。
 * @returns {{ ok: boolean, error?: string, record?: object(掩码版) }}
 */
function saveConnection(input) {
  const record = {
    name: input.name,
    type: input.type,
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password: input.password,
  };
  const v = _validate(record, { requireFull: true });
  if (!v.ok) return { ok: false, error: v.error };

  const store = _load();
  store.connections[record.name] = {
    name: record.name,
    type: record.type,
    host: record.host || undefined,
    port: record.port || undefined,
    database: record.database,
    user: record.user || undefined,
    password: record.password ? encrypt(String(record.password)) : undefined,
    updatedAt: new Date().toISOString(),
  };
  // 首个数据源自动成为默认；setDefault=true 显式切换
  if (!store.default) store.default = record.name;
  if (input.setDefault === true) store.default = record.name;
  _save(store);
  return { ok: true, record: maskRecord(store.connections[record.name], store.default) };
}

function removeConnection(name) {
  const store = _load();
  if (!store.connections[name]) {
    return { ok: false, error: `未找到数据源: ${name}` };
  }
  delete store.connections[name];
  if (store.default === name) {
    const rest = Object.keys(store.connections);
    store.default = rest.length ? rest[0] : null;
  }
  _save(store);
  return { ok: true, default: store.default };
}

function setDefaultConnection(name) {
  const store = _load();
  if (!store.connections[name]) {
    return { ok: false, error: `未找到数据源: ${name}` };
  }
  store.default = name;
  _save(store);
  return { ok: true, default: name };
}

/** 掩码版记录（对外输出用，密码绝不明文） */
function maskRecord(rec, defaultName) {
  return {
    name: rec.name,
    type: rec.type,
    host: rec.host || undefined,
    port: rec.port || undefined,
    database: rec.database,
    user: rec.user || undefined,
    password: rec.password ? _maskToken(String(rec.password)) : undefined,
    isDefault: defaultName ? rec.name === defaultName : false,
    updatedAt: rec.updatedAt,
  };
}

/** 列出全部数据源（掩码版） */
function listConnections() {
  const store = _load();
  return Object.values(store.connections).map((c) => maskRecord(c, store.default));
}

/** 取掩码版单条（存在性检查/展示用）；不存在返回 null */
function getConnectionInfo(name) {
  const store = _load();
  const rec = store.connections[name];
  return rec ? maskRecord(rec, store.default) : null;
}

function getDefaultName() {
  return _load().default;
}

/**
 * 工具参数回退合并：params 未提供的连接字段从已保存数据源补齐。
 * 优先级：params.connection 指定 > 默认数据源；显式 params 字段 > 保存值。
 * 无已保存数据源/解析失败时原样返回 params（零侵入）。
 */
function resolveConnectionParams(params) {
  if (!params || typeof params !== 'object') return params;
  try {
    const store = _load();
    const name = params.connection || store.default;
    if (!name) return params;
    const rec = store.connections[name];
    if (!rec) return params;
    const saved = {
      type: rec.type,
      host: rec.host,
      port: rec.port,
      database: rec.database,
      user: rec.user,
      password: _decryptPassword(rec.password),
    };
    const merged = { ...params };
    for (const k of Object.keys(saved)) {
      if (merged[k] === undefined && saved[k] !== undefined) merged[k] = saved[k];
    }
    return merged;
  } catch (e) {
    console.warn('[db-connections] 参数回退合并失败:', e.message || e);
    return params;
  }
}

module.exports = {
  connectionsPath,
  saveConnection,
  removeConnection,
  setDefaultConnection,
  listConnections,
  getConnectionInfo,
  getDefaultName,
  resolveConnectionParams,
  DB_TYPES,
  NAME_PATTERN,
};
