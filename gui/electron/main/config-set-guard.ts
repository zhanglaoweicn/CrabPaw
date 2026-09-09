// 2026-08-15 审查返工: config:set 顶层校验从 index.ts 抽为纯函数(对齐 window-mode.ts
// 模式)以便单测。修复要点: _ 前缀内部注入字段(config:get 注入的 _isLarkConfigured /
// _isWecomConfigured)必须在 unknownFields 校验之前剥离——此前顺序相反, SetupWizard
// 把 config:get 整包回传 config:set 修改唤醒词时被误拒(静默失败、数据丢失)。

export const CONFIG_SET_TOP_LEVEL_WHITELIST = new Set([
  'lark', 'wecom', 'chatChannel', 'setupCompleted', 'wakeWord', 'defaultModel',
  'security', 'imageGeneration', 'videoGeneration', 'visionGeneration', 'voice', 'search',
  'models', 'agent', 'user', 'schedule', 'adminUsers', 'enableWhitelist', 'allowedUsers', 'update',
  // 2026-08-15 复核补入: 后端真实落盘顶层字段, 此前遗漏会导致 GUI 整包回传被误拒。
  // 同步维护点: src/core/config.js defaultConfig(:254-400, 17 个顶层键) +
  // src/handlers/config-handler.js HTTP 保存路径(providers / modelAssignments / pushTargets);
  // 后端新增顶层键时必须同步此白名单。
  'tts', 'stt', 'pushTargets', 'providers', 'modelAssignments',
  // 2026-08-28 审计 L2: permissions.mode 是 GUI 外唯一权限模式入口(ai.js 启动读
  // config.json permissions.mode)——用户手动写入后 SetupWizard 整包回传 config:set
  // 曾被「未知配置字段」误拒。assistant 走 config.agent 合并与独立 IPC 通道, 无需加。
  'permissions',
])

export type ConfigSetGuardResult =
  | { ok: true; config: any }
  | { ok: false; error: string }

/**
 * config:set 载荷守卫: 非对象拒绝 → _ 前缀内部字段剥离 → 顶层白名单校验。
 * 注意顺序敏感: 剥离必须先于白名单校验, 否则 get→set 整包回传会被误拒。
 */
export function sanitizeConfigSetPayload(config: any): ConfigSetGuardResult {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    console.error('[config:set] 非法配置对象(非对象)')
    return { ok: false, error: '配置对象非法' }
  }
  // 必须先剥离再校验: _ 前缀字段是 config:get 注入的内部态, 每次 get 都会重新注入
  for (const k of Object.keys(config)) {
    if (k.startsWith('_')) delete config[k]
  }
  const unknownFields = Object.keys(config).filter(k => !CONFIG_SET_TOP_LEVEL_WHITELIST.has(k))
  if (unknownFields.length > 0) {
    console.error('[config:set] 拒绝未知配置字段:', unknownFields.join(','))
    return { ok: false, error: `未知配置字段: ${unknownFields.join(', ')}` }
  }
  return { ok: true, config }
}
