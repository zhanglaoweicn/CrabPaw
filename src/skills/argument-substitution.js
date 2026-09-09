/**
 * 参数替换模块
 * 
 * 从用户消息中提取参数并替换技能文档中的占位符
 * 所有功能都是可选的，不影响现有技能
 */

/**
 * 从用户消息中提取参数值
 * 
 * @param {string} userMessage - 用户消息
 * @param {string[]} argNames - 参数名称列表
 * @returns {Object} 参数键值对
 */
function extractArguments(userMessage, argNames) {
  if (!argNames || argNames.length === 0) {
    return {}
  }

  const params = {}
  const words = userMessage.split(/\s+/).filter(w => w.length > 0)

  argNames.forEach((name, index) => {
    if (index < words.length) {
      params[name] = words[index]
    }
  })

  return params
}

/**
 * 替换内容中的参数占位符
 * 
 * @param {string} content - 原始内容
 * @param {Object} params - 参数键值对
 * @returns {string} 替换后的内容
 */
function substituteArguments(content, params) {
  if (!params || Object.keys(params).length === 0) {
    return content
  }

  return content.replace(/\${(\w+)}/g, (match, name) => {
    const value = params[name]
    if (value === undefined) {
      return match
    }
    return sanitizeArg(value)
  })
}

/**
 * 安全转义参数值
 * 防止命令注入攻击
 * 
 * @param {string} value - 原始值
 * @returns {string} 转义后的值
 */
function sanitizeArg(value) {
  if (typeof value !== 'string') {
    return String(value)
  }

  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
}

/**
 * 智能参数提取
 * 尝试从自然语言中提取参数
 * 
 * @param {string} userMessage - 用户消息
 * @param {string[]} argNames - 参数名称列表
 * @param {Object} options - 选项
 * @returns {Object} 参数键值对
 */
// eslint-disable-next-line no-unused-vars
function smartExtractArguments(userMessage, argNames, options = {}) {
  if (!argNames || argNames.length === 0) {
    return {}
  }

  const params = {}
  const message = userMessage.toLowerCase()

  if (argNames.includes('city')) {
    if (!/天气|weather/i.test(message)) {
      return params
    }
    
    const cityPatterns = [
      /([^\s]+?)(?:今天|明天|后天)?(?:的)?天气/,
      /天气[是为]?\s*([^\s]+)/,
    ]

    for (const pattern of cityPatterns) {
      const match = message.match(pattern)
      if (match && match[1]) {
        let city = match[1].trim()
        city = city.replace(/今天|明天|后天|天气|的|问的是|我问的是/g, '').trim()
        if (city && city.length >= 2 && city.length <= 10) {
          params.city = city
          break
        }
      }
    }
  }

  if (argNames.includes('keyword')) {
    const keywordPatterns = [
      /搜索\s*(.+)/,
      /查找\s*(.+)/,
      /查询\s*(.+)/,
      /找\s*(.+)/,
    ]

    for (const pattern of keywordPatterns) {
      const match = message.match(pattern)
      if (match && match[1]) {
        params.keyword = match[1].trim()
        break
      }
    }
  }

  if (argNames.includes('file') || argNames.includes('path')) {
    const filePatterns = [
      /文件\s*[:：]?\s*([^\s]+)/,
      /路径\s*[:：]?\s*([^\s]+)/,
      /([a-zA-Z]:\\[^\s]+)/,
      /([/~][^\s]*)/,
    ]

    for (const pattern of filePatterns) {
      const match = userMessage.match(pattern)
      if (match && match[1]) {
        const key = argNames.includes('file') ? 'file' : 'path'
        params[key] = match[1].trim()
        break
      }
    }
  }

  if (Object.keys(params).length === 0) {
    return extractArguments(userMessage, argNames)
  }

  return params
}

/**
 * 构建参数提示文本
 * 
 * @param {Object} skill - 技能对象
 * @returns {string} 参数提示文本
 */
function buildArgumentHint(skill) {
  if (!skill.arguments || skill.arguments.length === 0) {
    return ''
  }

  if (skill.argumentHint) {
    return skill.argumentHint
  }

  return `参数: ${skill.arguments.join(', ')}`
}

module.exports = {
  extractArguments,
  substituteArguments,
  sanitizeArg,
  smartExtractArguments,
  buildArgumentHint
}
