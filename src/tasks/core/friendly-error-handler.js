const ERROR_MESSAGES = {
  'TASK_NOT_FOUND': {
    message: '任务不存在',
    description: '您尝试操作的任务已被删除或不存在',
    solution: '请刷新任务列表，或重新创建该任务',
    severity: 'warning'
  },
  'INVALID_CRON': {
    message: '时间配置格式错误',
    description: 'Cron表达式格式不正确，无法解析执行时间',
    solution: '请选择预设时间选项，或检查自定义时间格式是否正确',
    severity: 'error'
  },
  'UNREGISTERED_ACTION': {
    message: '不支持的任务类型',
    description: '系统暂不支持该任务类型',
    solution: '请选择其他任务类型，或联系管理员添加支持',
    severity: 'error'
  },
  'TASK_EXECUTION_FAILED': {
    message: '任务执行失败',
    description: '任务在执行过程中遇到错误',
    solution: '请检查任务配置是否正确，或稍后重试',
    severity: 'error'
  },
  'TASK_TIMEOUT': {
    message: '任务执行超时',
    description: '任务执行时间超过了设定的超时限制',
    solution: '请检查任务是否需要更长的执行时间，或优化任务逻辑',
    severity: 'warning'
  },
  'SKILL_NOT_FOUND': {
    message: '技能不存在',
    description: '指定的技能未安装或已被删除',
    solution: '请安装所需技能，或选择其他技能',
    severity: 'error'
  },
  'SKILL_EXECUTION_ERROR': {
    message: '技能执行错误',
    description: '技能在执行过程中发生错误',
    solution: '请检查技能参数是否正确，或查看技能文档',
    severity: 'error'
  },
  'NETWORK_ERROR': {
    message: '网络连接失败',
    description: '无法连接到服务器或外部服务',
    solution: '请检查网络连接，或稍后重试',
    severity: 'warning'
  },
  'PERMISSION_DENIED': {
    message: '权限不足',
    description: '您没有权限执行此操作',
    solution: '请联系管理员获取相应权限',
    severity: 'error'
  },
  'VALIDATION_ERROR': {
    message: '数据验证失败',
    description: '提交的数据不符合要求',
    solution: '请检查输入内容是否符合格式要求',
    severity: 'warning'
  },
  'DUPLICATE_TASK': {
    message: '任务已存在',
    description: '相同名称或配置的任务已存在',
    solution: '请修改任务名称或配置，或删除现有任务后重新创建',
    severity: 'warning'
  },
  'RESOURCE_LIMIT_EXCEEDED': {
    message: '资源限制超出',
    description: '已达到任务数量或执行频率限制',
    solution: '请删除不需要的任务，或升级服务套餐',
    severity: 'warning'
  },
  'CONFIGURATION_ERROR': {
    message: '配置错误',
    description: '系统配置存在问题',
    solution: '请检查系统配置，或联系管理员',
    severity: 'error'
  },
  'SERVICE_UNAVAILABLE': {
    message: '服务暂时不可用',
    description: '相关服务正在维护或暂时不可用',
    solution: '请稍后重试，或联系管理员了解详情',
    severity: 'warning'
  },
  'UNKNOWN_ERROR': {
    message: '未知错误',
    description: '发生了未预期的错误',
    solution: '请刷新页面重试，或联系技术支持',
    severity: 'error'
  }
};

const ERROR_PATTERNS = [
  { pattern: /未注册的任务类型[:：]\s*(.+)/i, code: 'UNREGISTERED_ACTION' },
  { pattern: /无效的\s*cron\s*表达式/i, code: 'INVALID_CRON' },
  { pattern: /任务不存在/i, code: 'TASK_NOT_FOUND' },
  { pattern: /技能不存在|未找到技能/i, code: 'SKILL_NOT_FOUND' },
  { pattern: /执行超时/i, code: 'TASK_TIMEOUT' },
  { pattern: /网络错误|连接失败|ECONNREFUSED|ETIMEDOUT/i, code: 'NETWORK_ERROR' },
  { pattern: /权限不足|无权访问/i, code: 'PERMISSION_DENIED' },
  { pattern: /验证失败|格式错误|参数错误/i, code: 'VALIDATION_ERROR' },
  { pattern: /已存在|重复/i, code: 'DUPLICATE_TASK' },
  { pattern: /限制|超出/i, code: 'RESOURCE_LIMIT_EXCEEDED' },
  { pattern: /配置错误|配置无效/i, code: 'CONFIGURATION_ERROR' },
  { pattern: /服务不可用|维护中/i, code: 'SERVICE_UNAVAILABLE' }
];

class FriendlyErrorHandler {
  constructor() {
    this.errorLog = [];
    this.maxLogSize = 100;
  }
  
  parseError(error) {
    if (!error) {
      return this.createFriendlyError('UNKNOWN_ERROR');
    }
    
    const errorMessage = typeof error === 'string' ? error : 
                         error.message || error.error || String(error);
    
    for (const { pattern, code } of ERROR_PATTERNS) {
      if (pattern.test(errorMessage)) {
        return this.createFriendlyError(code, errorMessage);
      }
    }
    
    return this.createFriendlyError('UNKNOWN_ERROR', errorMessage);
  }
  
  createFriendlyError(code, originalMessage = '') {
    const errorConfig = ERROR_MESSAGES[code] || ERROR_MESSAGES['UNKNOWN_ERROR'];
    
    const friendlyError = {
      code,
      message: errorConfig.message,
      description: errorConfig.description,
      solution: errorConfig.solution,
      severity: errorConfig.severity,
      originalMessage,
      timestamp: Date.now(),
      userFriendly: true
    };
    
    this.logError(friendlyError);
    
    return friendlyError;
  }
  
  logError(error) {
    this.errorLog.push({
      ...error,
      loggedAt: Date.now()
    });
    
    if (this.errorLog.length > this.maxLogSize) {
      this.errorLog = this.errorLog.slice(-this.maxLogSize);
    }
  }
  
  getErrorLog(limit = 20) {
    return this.errorLog.slice(-limit);
  }
  
  clearErrorLog() {
    this.errorLog = [];
  }
  
  formatForDisplay(error) {
    const friendlyError = this.parseError(error);
    
    return {
      title: friendlyError.message,
      message: friendlyError.description,
      solution: friendlyError.solution,
      severity: friendlyError.severity,
      icon: this.getSeverityIcon(friendlyError.severity),
      color: this.getSeverityColor(friendlyError.severity)
    };
  }
  
  getSeverityIcon(severity) {
    switch (severity) {
      case 'error': return '❌';
      case 'warning': return '⚠️';
      case 'info': return 'ℹ️';
      default: return '❓';
    }
  }
  
  getSeverityColor(severity) {
    switch (severity) {
      case 'error': return 'red';
      case 'warning': return 'orange';
      case 'info': return 'blue';
      default: return 'gray';
    }
  }
  
  createToastMessage(error) {
    const friendlyError = this.parseError(error);
    
    return {
      type: friendlyError.severity === 'error' ? 'error' : 'warning',
      title: friendlyError.message,
      description: friendlyError.solution
    };
  }
  
  createModalContent(error) {
    const friendlyError = this.parseError(error);
    
    return {
      title: `${this.getSeverityIcon(friendlyError.severity)} ${friendlyError.message}`,
      content: `
**问题描述：**
${friendlyError.description}

**解决方法：**
${friendlyError.solution}

${friendlyError.originalMessage ? `**详细信息：**\n\`${friendlyError.originalMessage}\`` : ''}
      `.trim(),
      severity: friendlyError.severity
    };
  }
  
  addCustomError(code, config) {
    ERROR_MESSAGES[code] = {
      message: config.message || '自定义错误',
      description: config.description || '',
      solution: config.solution || '',
      severity: config.severity || 'error'
    };
    
    if (config.pattern) {
      ERROR_PATTERNS.push({
        pattern: config.pattern,
        code
      });
    }
  }
  
  getErrorStatistics() {
    const stats = {
      total: this.errorLog.length,
      byCode: {},
      bySeverity: {
        error: 0,
        warning: 0,
        info: 0
      }
    };
    
    for (const error of this.errorLog) {
      stats.byCode[error.code] = (stats.byCode[error.code] || 0) + 1;
      stats.bySeverity[error.severity] = (stats.bySeverity[error.severity] || 0) + 1;
    }
    
    return stats;
  }
}

let instance = null;

function getFriendlyErrorHandler() {
  if (!instance) {
    instance = new FriendlyErrorHandler();
  }
  return instance;
}

function parseError(error) {
  return getFriendlyErrorHandler().parseError(error);
}

function formatErrorForDisplay(error) {
  return getFriendlyErrorHandler().formatForDisplay(error);
}

function createErrorToast(error) {
  return getFriendlyErrorHandler().createToastMessage(error);
}

module.exports = {
  FriendlyErrorHandler,
  getFriendlyErrorHandler,
  parseError,
  formatErrorForDisplay,
  createErrorToast,
  ERROR_MESSAGES,
  ERROR_PATTERNS
};
