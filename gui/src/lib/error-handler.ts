// EH2: Expanded error categories for better coverage
const USER_FRIENDLY_MESSAGES: Record<string, string> = {
  'ECONNREFUSED': '无法连接到服务器，请确认服务已启动',
  'ECONNRESET': '连接被中断，请稍后重试',
  'ETIMEDOUT': '请求超时，请检查网络连接',
  'ENOTFOUND': '无法解析服务器地址',
  'EAI_AGAIN': 'DNS 查询暂时失败，请稍后重试',
  'EPIPE': '连接已关闭，请重试',
  'EACCES': '权限不足，无法访问资源',
  'ENOENT': '请求的文件或资源不存在',
  'EMFILE': '系统打开文件过多，请稍后重试',
  'ENOMEM': '系统内存不足，请关闭部分程序后重试',
  '401': '认证失败，请重新启动服务',
  '403': '没有权限执行此操作',
  '404': '请求的资源不存在',
  '400': '请求参数错误，请检查配置',
  '409': '资源冲突，请刷新后重试',
  '413': '发送的数据过大，请减少内容后重试',
  '415': '不支持的媒体类型，请检查文件格式',
  '422': '请求数据验证失败，请检查输入内容',
  '429': '请求过于频繁，请稍后再试',
  '500': '服务器内部错误，请稍后重试',
  '502': '服务暂时不可用，请稍后重试',
  '503': '服务正在维护中，请稍后重试',
  '504': '网关超时，请稍后重试',
  'Failed to fetch': '网络连接失败，请检查网络设置',
  'fetch failed': '网络连接失败，请检查网络设置',
  'network': '网络异常，请检查网络连接',
  'API Key': 'API 密钥未配置，请在设置中填写',
  'apiKey': 'API 密钥无效，请检查设置',
  'rate_limit': '请求频率超限，请稍后再试',
  'context_length': '对话内容过长，请开启新对话',
  'invalid_signature': '安全验证失败',
  'PAYLOAD_TOO_LARGE': '文件过大，请减小文件大小',
  'model_not_found': '模型不存在，请检查模型配置',
  'insufficient_quota': 'API 配额不足，请升级计划或稍后重试',
  'stream_interrupted': '响应流中断，请重新发送',
  'ssl': 'SSL 证书错误，请检查网络配置',
  'cors': '跨域请求被拒绝，请检查服务配置',
  'timeout': '操作超时，请稍后重试',
  // 2026-08-19: 主进程 proxy 超时文本 'Request timed out' 不含单词 'timeout'——
  // \btimeout\b 匹配不到(单词是 timed/out)落兜底「操作失败」。补映射。
  'timed out': '操作超时，请稍后重试',
  'abort': '请求已取消',
  'cancelled': '操作已取消',
}

export function toUserFriendlyError(error: Error | string): string {
  const msg = typeof error === 'string' ? error : error.message || ''
  // 2026-08-28 CK2: 后端操作指引文案(含"去哪里开启"路径)直接透传——此前被通用
  // 映射吞成「操作失败，请稍后重试」, 用户不知道如何解锁(远程技能安装默认关闭门)。
  if (msg.includes('远程技能安装')) return msg
  // EH1: Use word-boundary matching for error codes to avoid false positives
  // (e.g., "ECONNREFUSED" should not match inside "ECONNREFUSEDxyz")
  for (const [key, friendly] of Object.entries(USER_FRIENDLY_MESSAGES)) {
    // Numeric HTTP status codes and underscore-separated codes use word boundaries
    if (/^\d+$/.test(key) || key.includes('_') || key === key.toUpperCase()) {
      // Use word boundary for error codes
      const regex = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      if (regex.test(msg)) return friendly
    } else {
      // For multi-word or mixed-case keys (e.g., "API Key"), use includes
      if (msg.includes(key)) return friendly
    }
  }
  if (msg.includes('API错误') || msg.includes('API Error')) {
    return '服务暂时不可用，请稍后重试'
  }
  if (/\b(?:认证|auth|token)\b/.test(msg)) {
    return '认证失败，请重新启动服务'
  }
  return '操作失败，请稍后重试'
}
