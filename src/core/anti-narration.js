/**
 * anti-narration.js — 反口播引导
 *
 * 背景(2026-08-13): scene 工具(scene-tools.js / scene-kinds-tool.js)通过
 * display 字段表明"卡片已实时渲染给用户"。但 LLM 拿到工具结果后常常再
 * 复述一遍卡片正文/进度,形成双份通知。此模块在工具结果序列化后追加一条
 * 系统提示,引导 LLM 只给结论、不复述卡片。
 *
 * 用法: contentResult = withAntiNarrationHint(contentResult, result)
 */
const HINT = '\n[系统提示] 以上工具结果已通过界面卡片直接展示给用户。你的回复请只给结论与下一步，不要复述卡片上的标题、进度数字或正文内容。';

/**
 * 判断工具结果是否携带"卡片已展示"语义
 * @param {*} result 工具执行返回的原始对象
 * @returns {boolean}
 */
function hasSurfaceDisplay(result) {
  return !!(
    result &&
    typeof result === 'object' &&
    (result.display || (result.data && result.data.display))
  );
}

/**
 * 若工具结果含 display 字段,向 contentResult 追加反口播引导标记
 * @param {string} contentResult 已序列化的工具结果文本
 * @param {*} result 原始工具结果对象
 * @returns {string}
 */
function withAntiNarrationHint(contentResult, result) {
  if (typeof contentResult !== 'string') return contentResult;
  if (!hasSurfaceDisplay(result)) return contentResult;
  return contentResult + HINT;
}

module.exports = { withAntiNarrationHint, hasSurfaceDisplay, HINT };
