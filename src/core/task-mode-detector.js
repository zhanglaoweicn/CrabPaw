/**
 * Task Mode Detector — detects whether user input is a long-running task
 *
 * Strategy (multi-factor heuristic with negative filtering):
 * 1. Task-positive signals: keywords, structural patterns, length
 * 2. Task-negative signals: quick-turn patterns (translations, simple questions)
 * 3. Intent analyzer integration: delegates to existing intent-analyzer when available
 */

const TASK_KEYWORDS = [
  '分析', '调研', '规划', '方案', '计划', '研究', '评估',
  '设计', '报告', '总结', '架构', '优化', '迭代',
  '重构', '开发', '实现', '搭建', '部署',
  '搜索', '查一下', '数据', '整理', '生成', '创建',
  'analyze', 'research', 'design', 'report', 'plan', 'build',
  'develop', 'evaluate', 'create', 'generate', 'search',
  'find', 'analyze', 'design', 'build', 'research',
];

const TASK_PATTERNS = [
  /帮我(做|写|搞|出|做一份?|实现|开发|搭建|部署|规划|设计|搜索|查|分析|研究).{2,}/,
  /(搜索|查一下|查找).{2,}/,
  /(行业|市场|竞品|产品|项目|系统|架构|工程).{0,}(分析|调研|报告|规划|方案|设计)/,
  /(深度|全面|系统|详细).{0,}(研究|调研|分析|评估|报告)/,
  /(制定|编写|撰写|起草).{0,}(计划|方案|报告|文档|规范)/,
  /全面(检查|审查|审计|评估|整理|优化|重构)/,
  /(create|generate|design|build|develop|analyze|research|evaluate)\s+\w+/i,
  /(help me|i want|can you|please).{2,}(analyze|research|design|build|create|report|search)/i,
];

/**
 * S6: 任务判定阈值——三处统一。
 * 旧实现: task-mode-detector.js 判定用 0.25 但 reasoning 文案写 0.35;
 * ai.js L987 独立用 0.25;文档写 0.45。现收敛为单一常量,各消费方引用。
 * 0.25 是历史实测"语音下任务"能稳定触发的门限(低于 0.25 多是闲聊/单轮问答)。
 */
const TASK_THRESHOLD = 0.25;

/**
 * @param {string} userMessage
 * @returns {{isTask: boolean, confidence: number, reasoning: string[]}}
 */
function detectTaskMode(userMessage) {
  const msg = userMessage || '';
  const reasoning = [];

  // Pure greetings/farewells — never tasks
  if (/^(你好|hi|hello|hey|拜拜|再见|谢谢|晚安|早上好|下午好|good\s*(morning|afternoon|evening|night)|bye|thanks|thank you)$/i.test(msg.trim())) {
    reasoning.push('pure_greeting');
    return { isTask: false, confidence: 0, reasoning };
  }

  // Very short messages without task keywords — not tasks
  if (msg.trim().length <= 2 && !/[分析设计研究调研报告评估规划搭建实现]/.test(msg)) {
    reasoning.push('too_short_no_task_keyword');
    return { isTask: false, confidence: 0, reasoning };
  }

  // Positive signal detection
  let scoreWeight = 0;

  // Keywords match
  const matchedKeywords = TASK_KEYWORDS.filter(k => msg.toLowerCase().includes(k));
  if (matchedKeywords.length > 0) {
    scoreWeight += Math.min(matchedKeywords.length * 0.2, 0.5);
    reasoning.push('keywords: ' + matchedKeywords.join(', '));
  }

  // Pattern match
  const matchedPatterns = TASK_PATTERNS.filter(p => p.test(msg));
  if (matchedPatterns.length > 0) {
    scoreWeight += 0.35;
    reasoning.push('pattern_match');
  }

  // Length > 15 chars → signal
  if (msg.length > 15) {
    scoreWeight += 0.1;
    reasoning.push('length > 15');
  }

  // Task keyword + not pure greeting → small bonus for short but clear tasks
  if (matchedKeywords.length > 0 && msg.trim().length > 3) {
    scoreWeight += 0.05;
    reasoning.push('keyword_with_content');
  }

  // Multi-line
  if (msg.includes('\n') && msg.split('\n').length > 2) {
    scoreWeight += 0.2;
    reasoning.push('multiline');
  }

  // Code blocks or URLs
  if (msg.includes('```') || /https?:\/\//.test(msg)) {
    scoreWeight += 0.1;
  }

  const isTask = scoreWeight >= TASK_THRESHOLD;
  reasoning.push('score: ' + scoreWeight.toFixed(2) + ' (threshold: ' + TASK_THRESHOLD + ')');

  return { isTask, confidence: Math.min(scoreWeight, 1.0), reasoning };
}

/**
 * Check if intent-analyzer matches a known workflow
 */
function matchIntentWorkflow(userMessage) {
  try {
    const { getIntentAnalyzer } = require('../taskflow/intent-analyzer');
    const intent = getIntentAnalyzer().analyze(userMessage);
    if (intent && intent.workflowId) {
      if (intent.plan) return intent; // planner result
      if (intent.confidence >= 0.5) return intent;
    }
  } catch (_) { console.warn('[task-mode-detector] failed to parse intent:', _.message); }
  return null;
}

module.exports = { detectTaskMode, matchIntentWorkflow, TASK_THRESHOLD };
