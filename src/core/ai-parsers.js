/**
 * ai-parsers.js — AI 解析工具函数
 *
 * 从 ai.js 中提取的独立解析逻辑，无外部状态依赖（除 toolSystem 通过参数传入）。
 * 保持向后兼容：ai.js 会重新导出这些函数。
 */

/**
 * 解析 [SKILL:name?params={...}] 格式的技能调用
 */
function parseSkillCall(text) {
  const match = text.match(/\[SKILL:([a-zA-Z0-9_-]+)(?:\?params=([^\]]+))?\]/i);
  if (match) {
    return {
      name: match[1].toLowerCase(),
      params: match[2] ? JSON.parse(match[2].replace(/'/g, '"')) : {}
    };
  }
  return null;
}

/**
 * 解析 [TOOL:name?params={...}] 格式的工具调用
 * @param {string} text - 待解析文本
 * @param {object} toolRegistry - 工具注册表（可选，用于查找工具定义）
 */
function parseToolCall(text, toolRegistry) {
  const match = text.match(/\[TOOL:([a-zA-Z0-9_-]+)(?:\?params=([\s\S]*?))?\]/i);
  if (match) {
    let params = {};
    if (match[2]) {
      try {
        let paramsStr = match[2].trim();
        paramsStr = paramsStr.replace(/'/g, '"');
        params = JSON.parse(paramsStr);
      } catch (e) {
        console.error('解析工具参数失败:', e.message, '原始参数:', match[2]);
        return null;
      }
    }
    
    const toolName = match[1];
    const tool = toolRegistry ? (toolRegistry.get(toolName) || toolRegistry.get(toolName.toLowerCase())) : null;
    
    return {
      name: tool ? tool.name : toolName,
      params
    };
  }
  return null;
}

module.exports = {
  parseSkillCall,
  parseToolCall,
};
