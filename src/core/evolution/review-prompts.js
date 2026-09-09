/**
 * Review Prompts — 技能自进化学习信号定义
 *
 * 从 Hermes-Agent 的 _SKILL_REVIEW_PROMPT 改造而来，为 ConversationReviewFork
 * 提供语义级别的学习信号检测。核心理念：
 *   - 语义信号 > 统计指标。用户说"不对"比成功率下降 10% 更有价值。
 *   - 逐轮触发 > 阈值触发。每次对话后都有学习机会，不等待指标恶化。
 *   - 渐进式积累 > 一次性大改。每次 Review 做一个小改动。
 */

/**
 * 技能审查提示词 — 发给 Background Review Fork 的 user message
 */
const SKILL_REVIEW_PROMPT = `Review the conversation above and update the skill library. Be
ACTIVE — most sessions produce at least one skill update, even if
small. A pass that does nothing is a missed learning opportunity,
not a neutral outcome.

Target shape of the library: CLASS-LEVEL skills, each with a rich
SKILL.md and a references/ directory for session-specific detail.
Not a long flat list of narrow one-session-one-skill entries.

Signals to look for (any one of these warrants action):
  - User corrected your style, tone, format, legibility, or verbosity.
    Frustration signals like "stop doing X", "this is too verbose",
    "dont format like this", "why are you explaining", "just give me
    the answer", "you always do Y and I hate it", or an explicit
    "remember this" are FIRST-CLASS skill signals. Update the relevant
    skill(s) to embed the preference so the next session starts fixed.
  - User corrected your workflow, approach, or sequence of steps.
    Encode the correction as a pitfall or explicit step in the skill
    that governs that class of task.
  - Non-trivial technique, fix, workaround, debugging path, or
    tool-usage pattern emerged that a future session would benefit
    from. Capture it.
  - A skill that got loaded or consulted this session turned out
    to be wrong, missing a step, or outdated. Patch it NOW.

Preference order — prefer the earliest action that fits:
  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the conversation
     for skills the user loaded or you read. If any covers the learning,
     PATCH it first. It was in play; it is the right one.
  2. UPDATE AN EXISTING UMBRELLA. If no loaded skill fits but an
     existing class-level skill does, patch it.
  3. ADD A SUPPORT FILE under an existing umbrella:
     - references/<topic>.md — detail or condensed knowledge banks
     - templates/<name>.<ext> — starter files to copy and modify
     - scripts/<name>.<ext> — re-runnable actions
  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists.
     Name at the class level — NOT a PR number or "fix-X" artifact.

Do NOT capture these:
  - Environment-dependent failures (missing binaries, unconfigured creds)
  - Negative claims about tools ("X tool is broken")
  - Session-specific transient errors that resolved
  - One-off task narratives with no reusable pattern

If a tool failed because of setup state, capture the FIX (install
command, config step) under an existing setup skill — never "this
tool does not work" as a standalone constraint.

"Nothing to save." is a real option but should NOT be the default.
If the session ran smoothly with no corrections and produced no new
technique, just say "Nothing to save." and stop. Otherwise, act.`;

/**
 * 记忆审查提示词
 */
const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory.

Focus on:
1. Has the user revealed things about themselves — persona, desires,
   preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave,
   their work style, or ways they want you to operate?

If something stands out, save it using the memory tool.
If nothing is worth saving, just say "Nothing to save." and stop.`;

/**
 * 合并审查提示词 — 同时检查技能和记忆
 */
const COMBINED_REVIEW_PROMPT = `Review the conversation above and update two things:

**Memory**: who the user is. Save persona, preferences, and
expectations about how you should behave.

**Skills**: how to do this class of task. Be ACTIVE — most sessions
produce at least one skill update.

Signals that warrant a skill update (any one is enough):
  - User corrected your style, tone, format, or approach
  - Non-trivial technique, fix, or debugging path emerged
  - A skill that was loaded turned out wrong or outdated

Preference order: 1) current loaded skill 2) existing umbrella
3) support file under umbrella 4) new class-level umbrella.

"Nothing to save." is an option but not the default.`;

/**
 * 学习信号分类 — 程序化预筛选
 */
const LEARNING_SIGNALS = {
  CORRECTION: {
    label: 'user_correction',
    priority: 'critical',
    patterns: [
      /不对/, /不是这样/, /别这样/, /错了/,
      /太啰嗦/, /简洁点/, /别废话/, /直接点/,
      /不要.*格式/, /别.*markdown/, /记住/,
      /你应该/, /下次.*记得/, /以后/,
      /我讨厌/, /不喜欢/, /烦/,
    ],
  },
  WORKFLOW_FIX: {
    label: 'workflow_correction',
    priority: 'high',
    patterns: [
      /步骤.*错/, /顺序.*不对/, /先.*再/,
      /跳过/, /不用.*那/, /换个.*方法/,
      /不用.*检查/, /不要.*确认/,
    ],
  },
  NEW_DISCOVERY: {
    label: 'new_discovery',
    priority: 'medium',
    patterns: [
      /原来可以/, /更简单/, /这样可以/,
      /发现.*可以/, /试试.*这个/, /用这个.*更好/,
    ],
  },
  EXPLICIT_REQUEST: {
    label: 'explicit_request',
    priority: 'critical',
    patterns: [
      /记住.*技能/, /保存.*技能/, /创建.*技能/,
      /学到.*记录/, /把这个.*记下/,
    ],
  },
};

const PRIORITY_ORDER = { critical: 3, high: 2, medium: 1, none: 0 };

/**
 * 快速预筛选：检测用户消息中是否包含学习信号
 * @param {Array<string|object>} messages - 用户最近的消息
 * @returns {{ hasSignal: boolean, signals: string[], priority: string }}
 */
function detectLearningSignals(messages) {
  if (!messages || messages.length === 0) {
    return { hasSignal: false, signals: [], priority: 'none' };
  }

  const detected = [];
  let highestPriority = 'none';

  for (const msg of messages.slice(-10)) {
    const text = typeof msg === 'string' ? msg : (msg.content || msg.text || '');
    for (const [key, signal] of Object.entries(LEARNING_SIGNALS)) {
      for (const pattern of signal.patterns) {
        if (pattern.test(text)) {
          detected.push(key);
          if (PRIORITY_ORDER[signal.priority] > PRIORITY_ORDER[highestPriority]) {
            highestPriority = signal.priority;
          }
          break;
        }
      }
    }
  }

  return {
    hasSignal: detected.length > 0,
    signals: [...new Set(detected)],
    priority: highestPriority,
  };
}

module.exports = {
  SKILL_REVIEW_PROMPT,
  MEMORY_REVIEW_PROMPT,
  COMBINED_REVIEW_PROMPT,
  LEARNING_SIGNALS,
  detectLearningSignals,
};
