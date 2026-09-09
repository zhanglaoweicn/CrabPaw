/**
 * Audit Log V2 - 结构化审计日志（JSONL 格式）
 *
 * 参考 JiuwenBox 的审计日志设计：
 * - JSONL 格式（每行一个 JSON 对象）
 * - 原子追加写入（appendFileSync）
 * - 支持结构化查询
 * - 自动轮转和清理
 *
 * 使用方式：
 *   const { writeAuditEntry, queryAuditLog } = require('./audit-log-v2');
 *   writeAuditEntry({
 *     event: 'skill_execute',
 *     actor: 'user_123',
 *     resource: 'skill_456',
 *     action: 'execute',
 *     result: 'success',
 *   });
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('./config');

// ============================================================================
// 配置
// ============================================================================

const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const AUDIT_LOG_FILE = path.join(AUDIT_DIR, 'audit.jsonl');

const DEFAULT_CONFIG = {
  maxFileSizeMB: 100,       // 单个日志文件最大大小
  maxFiles: 10,             // 最多保留文件数
  retentionDays: 90,        // 保留天数
  enableIndex: true,        // 启用索引
  flushIntervalMs: 5000,    // 索引刷新间隔
};

// ============================================================================
// 审计事件定义
// ============================================================================

const AUDIT_EVENTS = {
  // 用户事件
  USER_LOGIN: 'user_login',
  USER_LOGOUT: 'user_logout',
  USER_AUTH_FAILED: 'user_auth_failed',

  // 配置事件
  CONFIG_CHANGE: 'config_change',
  CONFIG_RESET: 'config_reset',

  // 技能事件
  SKILL_CREATE: 'skill_create',
  SKILL_UPDATE: 'skill_update',
  SKILL_DELETE: 'skill_delete',
  SKILL_EXECUTE: 'skill_execute',
  SKILL_EVOLVE: 'skill_evolve',
  SKILL_ROLLBACK: 'skill_rollback',
  SKILL_DERIVED: 'skill_derived',
  SKILL_CAPTURED: 'skill_captured',
  SKILL_DEGRADATION: 'skill_degradation',

  // 工具事件
  TOOL_EXECUTE: 'tool_execute',
  TOOL_DENIED: 'tool_denied',

  // 文件事件
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  FILE_DELETE: 'file_delete',

  // 网络事件
  NETWORK_REQUEST: 'network_request',
  NETWORK_DENIED: 'network_denied',

  // 安全事件
  SECURITY_VIOLATION: 'security_violation',
  SECURITY_WARNING: 'security_warning',
  SECURITY_BLOCK: 'security_block',
  APPROVAL_REQUEST: 'approval_request',
  APPROVAL_DECISION: 'approval_decision',

  // 备份事件
  BACKUP_CREATE: 'backup_create',
  BACKUP_RESTORE: 'backup_restore',
  BACKUP_DELETE: 'backup_delete',

  // 进化事件
  EVOLUTION_TRIGGER: 'evolution_trigger',
  EVOLUTION_SUCCESS: 'evolution_success',
  EVOLUTION_FAILED: 'evolution_failed',
  CONSOLIDATION_RUN: 'consolidation_run',

  // 反馈闭环事件
  FEEDBACK_LOOP_STATE: 'feedback_loop_state',
  FEEDBACK_LOOP_QUALITY: 'feedback_loop_quality',

  // Webhook 事件
  WEBHOOK_REGISTER: 'webhook_register',
  WEBHOOK_DELIVER: 'webhook_deliver',
  WEBHOOK_FAILED: 'webhook_failed',

  // 指令事件
  DIRECTIVE_ADD: 'directive_add',
  DIRECTIVE_UPDATE: 'directive_update',
  DIRECTIVE_DELETE: 'directive_delete',

  // 错误事件
  ERROR_OCCURRED: 'error_occurred',
  ERROR_RECOVERED: 'error_recovered',
};

// ============================================================================
// 风险等级
// ============================================================================

const RISK_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/**
 * 根据事件类型推断风险等级
 * @param {string} event - 事件类型
 * @returns {string}
 */
function inferRiskLevel(event) {
  const criticalEvents = [
    AUDIT_EVENTS.SECURITY_VIOLATION,
    AUDIT_EVENTS.SECURITY_BLOCK,
    AUDIT_EVENTS.USER_AUTH_FAILED,
  ];

  const highEvents = [
    AUDIT_EVENTS.CONFIG_CHANGE,
    AUDIT_EVENTS.SKILL_DELETE,
    AUDIT_EVENTS.FILE_DELETE,
    AUDIT_EVENTS.BACKUP_RESTORE,
    AUDIT_EVENTS.EVOLUTION_FAILED,
  ];

  const mediumEvents = [
    AUDIT_EVENTS.SKILL_UPDATE,
    AUDIT_EVENTS.SKILL_EVOLVE,
    AUDIT_EVENTS.TOOL_DENIED,
    AUDIT_EVENTS.NETWORK_DENIED,
    AUDIT_EVENTS.WEBHOOK_FAILED,
  ];

  if (criticalEvents.includes(event)) return RISK_LEVELS.CRITICAL;
  if (highEvents.includes(event)) return RISK_LEVELS.HIGH;
  if (mediumEvents.includes(event)) return RISK_LEVELS.MEDIUM;
  return RISK_LEVELS.LOW;
}

// ============================================================================
// 敏感字段脱敏
// ============================================================================

const SENSITIVE_FIELDS = [
  'apiKey',
  'api_key',
  'password',
  'token',
  'secret',
  'credential',
  'authorization',
  'cookie',
];

/**
 * 脱敏敏感字段
 * @param {any} obj - 对象
 * @param {number} depth - 递归深度
 * @returns {any}
 */
function redactSensitive(obj, depth = 0) {
  if (depth > 10) return '[MAX_DEPTH]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitive(item, depth + 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_FIELDS.some(s => lowerKey.includes(s.toLowerCase()));

    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitive(value, depth + 1);
    }
  }
  return result;
}

// ============================================================================
// 审计条目写入
// ============================================================================

/**
 * 生成审计条目 ID
 * @returns {string}
 */
function generateAuditId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `audit_${timestamp}_${random}`;
}

// C2(Runtime差距分析): 从异步上下文读取当前 run/trace——工具执行链经
// registry.execute 的 runWithRunId 包装后,内部审计调用无需逐层传参
function _currentRunId() {
  try {
    const { globalTraceContext } = require('./trace-context');
    return (typeof globalTraceContext.getRunId === 'function' && globalTraceContext.getRunId()) || null;
  } catch (e) { return null; }
}
function _currentTraceId() {
  try {
    const { globalTraceContext } = require('./trace-context');
    return globalTraceContext.getTraceId() || null;
  } catch (e) { return null; }
}

/**
 * 写入审计条目
 * @param {Object} entry - 审计条目
 * @param {string} entry.event - 事件类型（必需）
 * @param {string} [entry.actor] - 执行者 ID
 * @param {string} [entry.actorType] - 执行者类型 (user/system/agent)
 * @param {string} [entry.resource] - 资源 ID
 * @param {string} [entry.resourceType] - 资源类型
 * @param {string} [entry.action] - 动作
 * @param {string} [entry.result] - 结果 (success/failed/denied)
 * @param {string} [entry.riskLevel] - 风险等级
 * @param {Object} [entry.metadata] - 元数据
 * @param {string} [entry.reason] - 原因/描述
 * @returns {Object} 完整的审计条目
 */
function writeAuditEntry(entry) {
  // 确保目录存在
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  // 构建完整条目
  const fullEntry = {
    id: generateAuditId(),
    timestamp: new Date().toISOString(),
    event: entry.event,
    actor: entry.actor || null,
    actorType: entry.actorType || 'system',
    resource: entry.resource || null,
    resourceType: entry.resourceType || null,
    action: entry.action || null,
    result: entry.result || 'success',
    riskLevel: entry.riskLevel || inferRiskLevel(entry.event),
    reason: entry.reason || null,
    metadata: redactSensitive(entry.metadata || {}),
    durationMs: entry.durationMs || null,
    errorCode: entry.errorCode || null,
    sessionId: entry.sessionId || null,
    // C2(Runtime差距分析): run/trace 关联——调用方显式传入优先,否则从
    // AsyncLocalStorage(runWithRunId 包装的工具执行链)自动获取,实现
    // run_id ↔ audit ↔ trace 三向贯通
    runId: entry.runId || _currentRunId() || null,
    traceId: entry.traceId || _currentTraceId() || null,
    ip: entry.ip || null,
    userAgent: entry.userAgent || null,
  };

  // JSONL 格式：每行一个 JSON
  const line = JSON.stringify(fullEntry) + '\n';

  // 原子追加写入
  fs.appendFileSync(AUDIT_LOG_FILE, line, { encoding: 'utf8' });

  // 检查是否需要轮转
  _checkRotation();

  return fullEntry;
}

/**
 * 批量写入审计条目
 * @param {Array<Object>} entries - 审计条目数组
 */
function writeAuditEntries(entries) {
  if (!entries || entries.length === 0) return;

  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  const lines = entries.map(entry => {
    const fullEntry = {
      id: generateAuditId(),
      timestamp: new Date().toISOString(),
      event: entry.event,
      actor: entry.actor || null,
      actorType: entry.actorType || 'system',
      resource: entry.resource || null,
      resourceType: entry.resourceType || null,
      action: entry.action || null,
      result: entry.result || 'success',
      riskLevel: entry.riskLevel || inferRiskLevel(entry.event),
      reason: entry.reason || null,
      metadata: redactSensitive(entry.metadata || {}),
      durationMs: entry.durationMs || null,
      errorCode: entry.errorCode || null,
      sessionId: entry.sessionId || null,
      // C2(Runtime差距分析): 同 writeAuditEntry——run/trace 关联
      runId: entry.runId || _currentRunId() || null,
      traceId: entry.traceId || _currentTraceId() || null,
      ip: entry.ip || null,
      userAgent: entry.userAgent || null,
    };
    return JSON.stringify(fullEntry);
  }).join('\n') + '\n';

  fs.appendFileSync(AUDIT_LOG_FILE, lines, { encoding: 'utf8' });
  _checkRotation();
}

// ============================================================================
// 审计日志查询
// ============================================================================

/**
 * 查询审计日志
 * @param {Object} options - 查询选项
 * @param {string} [options.event] - 事件类型过滤
 * @param {string} [options.actor] - 执行者过滤
 * @param {string} [options.resource] - 资源过滤
 * @param {string} [options.result] - 结果过滤
 * @param {string} [options.riskLevel] - 风险等级过滤
 * @param {string} [options.startDate] - 开始日期 (ISO string)
 * @param {string} [options.endDate] - 结束日期 (ISO string)
 * @param {number} [options.limit] - 限制条数
 * @param {number} [options.offset] - 偏移量
 * @param {string} [options.sortOrder] - 排序方向 (asc/desc)
 * @returns {Array<Object>}
 */
function queryAuditLog(options = {}) {
  const {
    event,
    actor,
    resource,
    result,
    riskLevel,
    startDate,
    endDate,
    limit = 100,
    offset = 0,
    sortOrder = 'desc',
  } = options;

  if (!fs.existsSync(AUDIT_LOG_FILE)) {
    return [];
  }

  const entries = [];
  // 遗留流式读取占位（现实现用 readFileSync）：补 error 处理器防未处理异常（无监听时 'error' 事件会致 worker 崩溃），并立即销毁避免空挂文件描述符
  const stream = fs.createReadStream(AUDIT_LOG_FILE, { encoding: 'utf8' });
  stream.on('error', (e) => console.warn('[audit-log] 兼容流打开失败（readFileSync 查询路径不受影响）:', e && e.message));
  stream.destroy();

  // 同步读取（简化实现）
  const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
  const lines = content.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line);

      // 应用过滤条件
      if (event && entry.event !== event) continue;
      if (actor && entry.actor !== actor) continue;
      if (resource && entry.resource !== resource) continue;
      if (result && entry.result !== result) continue;
      if (riskLevel && entry.riskLevel !== riskLevel) continue;
      if (startDate && entry.timestamp < startDate) continue;
      if (endDate && entry.timestamp > endDate) continue;

      entries.push(entry);
    } catch (e) {
      // 跳过解析失败的行（记录丢弃，避免审计数据无声丢失）
      console.error('[audit-log] 审计日志解析失败，该行已跳过:', e.message, '| line:', line.slice(0, 200));
    }
  }

  // 排序
  entries.sort((a, b) => {
    const cmp = a.timestamp.localeCompare(b.timestamp);
    return sortOrder === 'desc' ? -cmp : cmp;
  });

  // 分页
  return entries.slice(offset, offset + limit);
}

/**
 * 获取审计统计
 * @param {Object} options - 统计选项
 * @param {string} [options.startDate] - 开始日期
 * @param {string} [options.endDate] - 结束日期
 * @returns {Object}
 */
function getAuditStats(options = {}) {
  const { startDate, endDate } = options;

  const entries = queryAuditLog({
    startDate,
    endDate,
    limit: Infinity,
  });

  const stats = {
    total: entries.length,
    byEvent: {},
    byResult: {},
    byRiskLevel: {},
    byActor: {},
    failed: 0,
    denied: 0,
  };

  for (const entry of entries) {
    // 按事件类型统计
    stats.byEvent[entry.event] = (stats.byEvent[entry.event] || 0) + 1;

    // 按结果统计
    stats.byResult[entry.result] = (stats.byResult[entry.result] || 0) + 1;
    if (entry.result === 'failed') stats.failed++;
    if (entry.result === 'denied') stats.denied++;

    // 按风险等级统计
    if (entry.riskLevel) {
      stats.byRiskLevel[entry.riskLevel] = (stats.byRiskLevel[entry.riskLevel] || 0) + 1;
    }

    // 按执行者统计
    if (entry.actor) {
      stats.byActor[entry.actor] = (stats.byActor[entry.actor] || 0) + 1;
    }
  }

  return stats;
}

// ============================================================================
// 日志轮转
// ============================================================================

/**
 * 检查并执行日志轮转
 */
function _checkRotation() {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return;

  const stats = fs.statSync(AUDIT_LOG_FILE);
  const sizeMB = stats.size / (1024 * 1024);

  if (sizeMB >= DEFAULT_CONFIG.maxFileSizeMB) {
    _rotateLog();
  }
}

/**
 * 执行日志轮转
 */
function _rotateLog() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rotatedFile = path.join(AUDIT_DIR, `audit-${timestamp}.jsonl`);

  // 重命名当前日志文件
  fs.renameSync(AUDIT_LOG_FILE, rotatedFile);

  // 清理旧文件
  _cleanOldFiles();
}

/**
 * 清理旧的日志文件
 */
function _cleanOldFiles() {
  const files = fs.readdirSync(AUDIT_DIR)
    .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(AUDIT_DIR, f),
      time: fs.statSync(path.join(AUDIT_DIR, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  // 删除超出数量限制的文件
  while (files.length > DEFAULT_CONFIG.maxFiles) {
    const toDelete = files.pop();
    fs.unlinkSync(toDelete.path);
  }

  // 删除超出保留时间的文件
  const cutoffTime = Date.now() - DEFAULT_CONFIG.retentionDays * 24 * 60 * 60 * 1000;
  for (const file of files) {
    if (file.time < cutoffTime) {
      fs.unlinkSync(file.path);
    }
  }
}

// ============================================================================
// 兼容旧 API
// ============================================================================

/**
 * 兼容旧的 logAuditEvent 函数
 * @deprecated 使用 writeAuditEntry 代替
 */
function logAuditEvent(event, details = {}) {
  return writeAuditEntry({
    event,
    actor: details.userId,
    resource: details.resourceId,
    action: details.action,
    // 2026-08-15 T7(累积D): 显式 false → 'failed'（规范枚举），其余沿用原回退。
    result: details.result === false ? 'failed' : (details.result || 'success'),
    reason: details.reason,
    metadata: details,
  });
}

/**
 * 兼容旧的 getAuditLogs 函数
 * @deprecated 使用 queryAuditLog 代替
 */
function getAuditLogs(options = {}) {
  return queryAuditLog({
    event: options.event,
    actor: options.userId,
    startDate: options.startDate,
    endDate: options.endDate,
    limit: options.limit,
  });
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  // 核心函数
  writeAuditEntry,
  writeAuditEntries,
  queryAuditLog,
  getAuditStats,

  // 事件定义
  AUDIT_EVENTS,
  RISK_LEVELS,

  // 工具函数
  inferRiskLevel,
  redactSensitive,

  // 兼容旧 API
  logAuditEvent,
  getAuditLogs,

  // 配置
  AUDIT_DIR,
  AUDIT_LOG_FILE,
};
