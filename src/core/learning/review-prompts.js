/**
 * review-prompts — 后对话学习 review 提示模板
 *
 * 区分三种 review 类型：skill_review（技能）、memory_review（记忆）、combined（两者）
 */

/**
 * 检测用户消息中是否包含学习信号
 */
function detectLearningSignals(messages) {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : m.content?.text || '')
    .join(' ');

  const signals = {
    hasCorrection: false,
    hasNewWorkflow: false,
    hasPreference: false,
    hasNegative: false,
  };

  // 纠正信号
  if (/不要|不是|不对|错了|应该这样|重新来|换一种|用.*方式|按照.*方法|其实/i.test(userText)) {
    signals.hasCorrection = true;
  }

  // 新工作流信号
  if (/每次|以后|每次都|每次都要|先.*然后.*再|步骤|流程|方法|技巧/i.test(userText)) {
    signals.hasNewWorkflow = true;
  }

  // 偏好信号
  if (/我喜欢|我习惯|我更|我倾向|最好|建议用|用.*比较好/i.test(userText)) {
    signals.hasPreference = true;
  }

  // 负面信号
  if (/不好用|不行|太慢|太难|复杂|看不懂|不对/i.test(userText)) {
    signals.hasNegative = true;
  }

  const hasSignal = signals.hasCorrection || signals.hasNewWorkflow || signals.hasPreference;

  return { hasSignal, ...signals };
}

/**
 * 技能 review 主提示（简洁版，使用较小模型）
 */
const SKILL_REVIEW_PROMPT = `你是一个技能学习系统。分析本次对话，判断是否需要创建新技能或更新现有技能。

## 技能定义
技能是一组可复用的指令，告诉 AI 如何处理特定类型的任务。好的技能名称应该概括一类任务，而非单次对话。

## 分析维度
1. 用户是否教了你新的工作方法？（-> 创建或更新技能）
2. 用户是否纠正了你的做法？（-> 更新已有技能）
3. 本次任务是否具有可复用的模式？（-> 考虑创建技能）

## 输出格式
如果你认为需要创建或更新技能，请调用 SkillManage 工具。
如果你认为不需要任何改动，回复 "NO_CHANGES_NEEDED"。`;

/**
 * 记忆 review 主提示
 */
const MEMORY_REVIEW_PROMPT = `你是一个记忆学习系统。分析本次对话，判断是否有值得保存的用户信息。

## 分析维度
1. 用户的身份、职业、角色信息
2. 用户的明确偏好（语言风格、格式偏好、输出偏好）
3. 用户的长期目标或项目信息
4. 重要的上下文约束（技术栈限制、环境限制）

如果你认为需要保存任何信息，请调用 memory_save 工具。
如果不需要，回复 "NO_CHANGES_NEEDED"。`;

module.exports = {
  detectLearningSignals,
  SKILL_REVIEW_PROMPT,
  MEMORY_REVIEW_PROMPT,
};
