/**
 * hint-sanitizer.js — 注入提示剥离器（2026-09-18 会话膨胀治理）
 *
 * 背景：chat 管线会给用户消息追加系统脚手架（语音模式提示/taskflow 提示/专家人设/
 * 实时语音上下文接力等），这些提示随消息原样持久化进会话历史。每条 ~1-4KB 的注入
 * 提示累积后把 voice_shell_user 会话上下文撑到 83K tokens（超限 1022%），压缩器
 * 每轮只能挤掉 2%，每轮语音委托因此变慢。
 *
 * 修复：历史消息装配与持久化两个入口都调用 stripInjectedHints——
 *   - 历史装配侧：存量膨胀立即瘦身（不等新会话）
 *   - 持久化侧：增量不再膨胀
 * 当轮 LLM 消息不受影响（提示对当轮仍然生效）。
 *
 * 覆盖的注入块（均为方括号包裹、追加在原话尾部或前置于原话头部）：
 *   [系统提示：当前是语音对话模式…]
 *   [系统提示: 此任务可能需要创建工作流…推荐模板…推荐专家…]
 *   [系统提示: 本对话将根据「XX」专家视角回答…人设要求: …（长人设块）]
 *   [实时语音上下文（…）]…[/实时语音上下文]（前缀整块）
 */

const INJECTED_BLOCK_PATTERNS = [
  // 前缀整块: 实时语音上下文接力
  /^\[实时语音上下文[^\]]*\][\s\S]*?\[\/实时语音上下文\]\s*/,
  // 尾部/内嵌: 系统提示块（非贪婪到第一个 ']'——人设块内无嵌套方括号）
  /\s*\[系统提示[：:][\s\S]*?\]/g,
];

function stripInjectedHints(text) {
  let t = String(text || '');
  for (const re of INJECTED_BLOCK_PATTERNS) {
    t = t.replace(re, '');
  }
  // 收尾: 多余空白/分隔符规整
  t = t.replace(/^[，,、\s]+/, '').replace(/[，,、\s]+$/, '').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

module.exports = { stripInjectedHints };
