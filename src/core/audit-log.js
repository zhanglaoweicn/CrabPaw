/**
 * Audit Log — audit-log-v2 薄适配层 (2026-08-15 P2-7 双审计合并)
 *
 * 旧审计 API 已收敛到 audit-log-v2.js(JSONL 单实现)。本文件保持旧 API 形状
 * ({id,timestamp,event,...details} 顶层平铺),内部转发 v2:
 *   - 写入: writeAuditEntry(细节存入 metadata,userId 映射 actor)
 *   - 读取: queryAuditLog 重建旧条目形状({...metadata, userId, risk})
 * 旧消费方(directive-manager/browser-tools/desktop-tools/tools/index/audit-handler)
 * 无需改动。v2 消费方(activity-stream/mcp-manager)继续直接使用 audit-log-v2。
 *
 * 已知遗留: 历史 audit-log.json(旧文件格式)不再被读取;如需迁移旧数据,
 * 可在部署时一次性导入 v2 JSONL(本任务未做,避免启动期迁移风险)。
 */

const v2 = require('./audit-log-v2');
const fs = require('fs');

// 旧事件名全集: v2 已含多数键,此处补齐旧版独有键
const AUDIT_EVENTS = {
  ...v2.AUDIT_EVENTS,
  API_KEY_SET: 'api_key_set',
  CHAT_MESSAGE: 'chat_message',
  FILE_OPERATION: 'file_operation',
  SECURITY_CHANGE: 'security_change',
  UPDATE_CHECK: 'update_check',
  UPDATE_INSTALL: 'update_install',
  DESKTOP_CONTROL: 'desktop_control',
  MESSAGE_FEEDBACK: 'message_feedback',
};

const RISK_LEVELS = v2.RISK_LEVELS;

/** 将 v2 条目重建为旧条目形状({id,timestamp,event,...details}) */
function _toLegacyEntry(e) {
  return {
    id: e.id,
    timestamp: e.timestamp,
    event: e.event,
    ...(e.metadata && typeof e.metadata === 'object' ? e.metadata : {}),
    ...(e.actor ? { userId: e.actor } : {}),
    // 旧格式仅显式写入的条目带 risk(参与 computeRiskScore);不引入 v2 inferRiskLevel
    ...(e.metadata && e.metadata.risk !== undefined ? { risk: e.metadata.risk } : {}),
  };
}

function logAuditEvent(event, details = {}) {
  const entry = v2.writeAuditEntry({
    event,
    actor: details.userId,
    // 2026-08-15 T7(累积D): 显式 result:false 不再被存成 'success'——
    // false → 'failed'（v2 规范枚举, stats.failed 计数口径）, 其余沿用原回退。
    result: details.result === false ? 'failed' : (details.result || 'success'),
    riskLevel: details.risk,
    metadata: details,
  });
  // 保持旧返回形状: details 顶层平铺(未脱敏,与旧行为一致;脱敏仅作用于 v2 存储)
  return { id: entry.id, timestamp: entry.timestamp, event, ...details };
}

function getAuditLogs(options = {}) {
  const { limit = 100, event, userId, startDate, endDate } = options;
  let logs;
  try {
    const entries = v2.queryAuditLog({
      event,
      actor: userId,
      startDate,
      endDate,
      limit: Number.MAX_SAFE_INTEGER,
    });
    logs = entries.map(_toLegacyEntry);
  } catch (e) {
    console.error('[audit-log] 审计日志读取失败:', e?.message || e);
    logs = [];
  }
  // 本地二次过滤/截断(与旧实现一致: 新→旧顺序,取前 limit 条)
  if (event) logs = logs.filter(l => l.event === event);
  if (userId) logs = logs.filter(l => l.userId === userId);
  if (startDate) {
    const start = new Date(startDate);
    logs = logs.filter(l => new Date(l.timestamp) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    logs = logs.filter(l => new Date(l.timestamp) <= end);
  }
  return logs.slice(0, limit);
}

function getAuditStats() {
  const logs = getAuditLogs({ limit: Number.MAX_SAFE_INTEGER });
  const stats = { total: logs.length, byEvent: {}, byDate: {}, recentErrors: [] };
  for (const log of logs) {
    stats.byEvent[log.event] = (stats.byEvent[log.event] || 0) + 1;
    const date = log.timestamp.split('T')[0];
    stats.byDate[date] = (stats.byDate[date] || 0) + 1;
    if (log.event === AUDIT_EVENTS.ERROR_OCCURRED) {
      if (stats.recentErrors.length < 10) stats.recentErrors.push(log);
    }
  }
  return stats;
}

function clearAuditLogs() {
  try {
    if (fs.existsSync(v2.AUDIT_LOG_FILE)) {
      fs.writeFileSync(v2.AUDIT_LOG_FILE, '');
    }
  } catch (e) {
    console.error('[audit-log] 清空审计日志失败:', e?.message || e);
  }
}

function logUserAction(userId, action, details = {}) {
  return logAuditEvent(action, { userId, ...details });
}

/**
 * 消息级点赞/点踩落库(P0-3, ag-ui MetaEvent 借鉴)
 * @param {string} userId 用户标识
 * @param {object} details { conversationId, messageTs, rating: 'up'|'down', text }
 */
function logMessageFeedback(userId, details = {}) {
  return logAuditEvent(AUDIT_EVENTS.MESSAGE_FEEDBACK, {
    userId,
    conversationId: details.conversationId || '',
    messageTs: details.messageTs || null,
    rating: details.rating || 'up',
    text: typeof details.text === 'string' ? details.text.slice(0, 500) : ''
  });
}

function logConfigChange(userId, field, oldValue, newValue) {
  return logAuditEvent(AUDIT_EVENTS.CONFIG_CHANGE, {
    userId,
    field,
    oldValue: typeof oldValue === 'string' && oldValue.length > 100
      ? oldValue.slice(0, 100) + '...'
      : oldValue,
    newValue: typeof newValue === 'string' && newValue.length > 100
      ? newValue.slice(0, 100) + '...'
      : newValue
  });
}

function logToolExecution(userId, toolName, params, result) {
  return logAuditEvent(AUDIT_EVENTS.TOOL_EXECUTE, {
    userId,
    toolName,
    params: JSON.stringify(params).slice(0, 500),
    success: result?.success !== false,
    error: result?.error
  });
}

// 2026-09-06: 结构化脱敏——params 必须先脱敏再序列化。此前 logDesktopControl 直接
// JSON.stringify(params)，v2 redactSensitive 只递归对象、对字符串原样放行
// (audit-log-v2.js: typeof obj !== 'object' → return obj)，fill 的 value、type 的 text、
// evaluate 的 expression 等敏感输入以明文落库。精确匹配键名，避免 includes 误伤（如 'text' ⊂ 'context'）。
const SENSITIVE_PARAM_KEYS = new Set([
  'value', 'text', 'expression', 'password', 'passwd', 'pwd', 'secret',
  'token', 'credential', 'authorization', 'cookie', 'apikey', 'api_key',
]);

function redactToolParams(params, depth = 0) {
  if (params === null || params === undefined || depth > 8) return params;
  if (Array.isArray(params)) return params.map(item => redactToolParams(item, depth + 1));
  if (typeof params === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
      out[key] = SENSITIVE_PARAM_KEYS.has(key.toLowerCase())
        ? '[REDACTED]'
        : redactToolParams(value, depth + 1);
    }
    return out;
  }
  return params;
}

function logDesktopControl(userId, action, params, result) {
  const riskMap = {
    open_application: RISK_LEVELS.LOW,
    open_url: RISK_LEVELS.MEDIUM,
    open_folder: RISK_LEVELS.LOW,
    search_web: RISK_LEVELS.LOW,
    list_running_apps: RISK_LEVELS.LOW,
    activate_window: RISK_LEVELS.LOW,
    close_window: RISK_LEVELS.MEDIUM,
    type_text: RISK_LEVELS.MEDIUM,
    press_key: RISK_LEVELS.MEDIUM,
    clipboard: RISK_LEVELS.MEDIUM,
    screenshot: RISK_LEVELS.LOW,
    system_info: RISK_LEVELS.LOW,
    execute_command: RISK_LEVELS.HIGH,
  };
  const risk = result?.blocked
    ? RISK_LEVELS.CRITICAL
    : (result?._risk || riskMap[action] || RISK_LEVELS.MEDIUM);

  return logAuditEvent(AUDIT_EVENTS.DESKTOP_CONTROL, {
    userId,
    action,
    params: JSON.stringify(redactToolParams(params) || {}).slice(0, 500),
    success: result?.success !== false,
    blocked: !!result?.blocked,
    risk,
    error: result?.error,
  });
}

function logSecurityBlock(userId, toolName, reason, details = {}) {
  return logAuditEvent(AUDIT_EVENTS.SECURITY_BLOCK, {
    userId,
    toolName,
    reason,
    risk: RISK_LEVELS.CRITICAL,
    ...details,
  });
}

function logSecurityWarning(userId, toolName, message, details = {}) {
  return logAuditEvent(AUDIT_EVENTS.SECURITY_WARNING, {
    userId,
    toolName,
    message,
    risk: RISK_LEVELS.HIGH,
    ...details,
  });
}

function logChatMessage(userId, messageLength, responseLength, model) {
  return logAuditEvent(AUDIT_EVENTS.CHAT_MESSAGE, {
    userId,
    messageLength,
    responseLength,
    model
  });
}

function logError(userId, error, context = {}) {
  return logAuditEvent(AUDIT_EVENTS.ERROR_OCCURRED, {
    userId,
    error: error?.message || String(error),
    stack: error?.stack,
    ...context
  });
}

const ANOMALY_RULES = [
  {
    name: 'rapid_tool_execution',
    check: (events) => {
      const recent = events.filter(e => e.event === AUDIT_EVENTS.TOOL_EXECUTE);
      if (recent.length < 10) return null;
      const last10 = recent.slice(0, 10);
      const timeSpan = new Date(last10[0].timestamp) - new Date(last10[9].timestamp);
      if (timeSpan < 5000) {
        return { rule: 'rapid_tool_execution', severity: 'high', message: `10次工具调用在${timeSpan}ms内完成` };
      }
      return null;
    },
  },
  {
    name: 'repeated_security_blocks',
    check: (events) => {
      const blocks = events.filter(e => e.event === AUDIT_EVENTS.SECURITY_BLOCK);
      if (blocks.length < 3) return null;
      const recent = blocks.slice(0, 3);
      const timeSpan = new Date(recent[0].timestamp) - new Date(recent[2].timestamp);
      if (timeSpan < 60000) {
        return { rule: 'repeated_security_blocks', severity: 'critical', message: '1分钟内3次安全拦截' };
      }
      return null;
    },
  },
  {
    name: 'sensitive_file_access',
    check: (events) => {
      const fileOps = events.filter(e => e.event === AUDIT_EVENTS.FILE_OPERATION);
      const sensitivePatterns = [/\.env/, /id_rsa/, /\.ssh/, /credentials/, /secret/, /\.pem/];
      for (const op of fileOps.slice(0, 5)) {
        const path = op.path || op.filePath || op.details?.path || '';
        if (sensitivePatterns.some(p => p.test(path))) {
          return { rule: 'sensitive_file_access', severity: 'high', message: `访问敏感文件: ${path.slice(0, 50)}` };
        }
      }
      return null;
    },
  },
  {
    name: 'high_error_rate',
    check: (events) => {
      const recent = events.slice(0, 20);
      const errors = recent.filter(e => e.event === AUDIT_EVENTS.ERROR_OCCURRED);
      if (errors.length >= 5) {
        return { rule: 'high_error_rate', severity: 'medium', message: `最近20条事件中${errors.length}条错误` };
      }
      return null;
    },
  },
];

function detectAnomalies() {
  const logs = getAuditLogs({ limit: Number.MAX_SAFE_INTEGER });
  const anomalies = [];

  for (const rule of ANOMALY_RULES) {
    try {
      const result = rule.check(logs);
      if (result) anomalies.push(result);
    } catch (e) { console.warn('[audit-log] 异常检测规则执行失败:', rule.name, e?.message || e); }
  }

  return anomalies;
}

function computeRiskScore() {
  const logs = getAuditLogs({ limit: Number.MAX_SAFE_INTEGER });
  if (logs.length === 0) return { score: 0, level: 'low' };

  let score = 0;

  const recentHour = logs.filter(l => {
    const age = Date.now() - new Date(l.timestamp).getTime();
    return age < 3600000;
  });

  const criticalCount = recentHour.filter(l => l.risk === RISK_LEVELS.CRITICAL).length;
  const highCount = recentHour.filter(l => l.risk === RISK_LEVELS.HIGH).length;
  const blockCount = recentHour.filter(l => l.event === AUDIT_EVENTS.SECURITY_BLOCK).length;
  const errorCount = recentHour.filter(l => l.event === AUDIT_EVENTS.ERROR_OCCURRED).length;

  score += criticalCount * 30;
  score += highCount * 15;
  score += blockCount * 20;
  score += errorCount * 5;

  const anomalies = detectAnomalies();
  for (const anomaly of anomalies) {
    if (anomaly.severity === 'critical') score += 40;
    else if (anomaly.severity === 'high') score += 20;
    else score += 10;
  }

  score = Math.min(100, score);

  let level = 'low';
  if (score >= 60) level = 'critical';
  else if (score >= 40) level = 'high';
  else if (score >= 20) level = 'medium';

  return { score, level, breakdown: { criticalCount, highCount, blockCount, errorCount, anomalyCount: anomalies.length } };
}

function getSecurityDashboard() {
  const stats = getAuditStats();
  const anomalies = detectAnomalies();
  const risk = computeRiskScore();
  const logs = getAuditLogs({ limit: Number.MAX_SAFE_INTEGER });

  const recentBlocks = logs.filter(l => l.event === AUDIT_EVENTS.SECURITY_BLOCK).slice(0, 10);
  const recentWarnings = logs.filter(l => l.event === AUDIT_EVENTS.SECURITY_WARNING).slice(0, 10);

  return {
    riskScore: risk.score,
    riskLevel: risk.level,
    riskBreakdown: risk.breakdown,
    anomalies,
    totalEvents: stats.total,
    recentBlocks,
    recentWarnings,
    byEvent: stats.byEvent,
  };
}

module.exports = {
  logMessageFeedback,
  AUDIT_EVENTS,
  RISK_LEVELS,
  logAuditEvent,
  getAuditLogs,
  getAuditStats,
  clearAuditLogs,
  logUserAction,
  logConfigChange,
  logToolExecution,
  logDesktopControl,
  redactToolParams,
  logSecurityBlock,
  logSecurityWarning,
  logChatMessage,
  logError,
  detectAnomalies,
  computeRiskScore,
  getSecurityDashboard,
};
