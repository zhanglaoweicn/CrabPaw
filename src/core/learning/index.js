/**
 * Learning System — 后对话自动学习系统
 *
 * 在每次对话完成后自动 review，检测可复用的模式并创建/更新技能。
 *
 * 模块：
 *   PostTurnReview — 后对话 review 引擎（工具调用计数触发）
 *   review-prompts — review 提示模板和信号检测
 */
const { PostTurnReview } = require('./post-turn-review');
const { detectLearningSignals } = require('./review-prompts');

module.exports = {
  PostTurnReview,
  detectLearningSignals,
};
