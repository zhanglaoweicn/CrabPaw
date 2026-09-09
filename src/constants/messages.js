const NO_CONTENT_MESSAGE = '(no content)';

const ERROR_MESSAGES = {
  NO_API_KEY: '未配置 API Key，请设置环境变量',
  INVALID_API_KEY: 'API Key 无效或已过期',
  RATE_LIMIT: 'API 请求频率超限，请稍后重试',
  NETWORK_ERROR: '网络连接失败',
  TIMEOUT: '请求超时',
  INTERNAL_ERROR: '服务器内部错误',
  UNKNOWN: '未知错误'
};

const SUCCESS_MESSAGES = {
  MESSAGE_SENT: '消息已发送',
  TASK_CREATED: '任务已创建',
  TASK_COMPLETED: '任务已完成',
  SESSION_CLEARED: '会话已重置',
  CONFIG_SAVED: '配置已保存'
};

const INFO_MESSAGES = {
  THINKING: '正在思考...',
  PROCESSING: '处理中...',
  LOADING: '加载中...',
  WAITING: '等待响应...'
};

module.exports = {
  NO_CONTENT_MESSAGE,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
  INFO_MESSAGES
};
