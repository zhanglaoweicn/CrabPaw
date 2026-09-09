/**
 * loop-contract.js — Agent 循环契约（Loop 独立成层·第一刀, 2026-09-04）
 *
 * 背景（五层映射结论）：执行循环的参数散在 ai.js 两处 IterationBudget 构造
 * （chat 与 chatStream），且已经出现分叉——chat 恒 15、chatStream 单代理 10/
 * 多代理 15。参数无单一事实源 = 漂移温床（同款问题曾发生在 task-mode 阈值：
 * 0.25/0.35/0.45 三处不一致, 2026-08-15 才收敛为 TASK_THRESHOLD 单一常量）。
 *
 * 本模块是循环参数的**单一事实源**：ai.js 两处构造必须从契约取值，
 * evals/test-cases/agent-loop.js 锁定"源码引用契约而非裸字面量"。
 *
 * 层语义（Pi/dsh 对标）：本文件属于 agent 层（执行循环层），只声明循环自身的
 * 边界参数，不知道任何产品语义（不感知语音/面板/渠道）。
 */

const AGENT_LOOP_CONTRACT = Object.freeze({
  /** 轮次上限——chat 与 chatStream 共用（IterationBudget.maxIterations） */
  maxRounds: 8,
  /**
   * 强制收答轮——depth/iter 达到该值即不再允许常规工具调用。
   * 2026-09-07 实测修复：此前 ai.js 两处硬编码 `depth >= 3`，把 8 轮预算实际
   * 压成 3 轮——"上传表格分析"类任务（读表→探活→写脚本→执行→核对 ≥5 步）必然
   * 中途被掐断，模型只能凭残缺信息拼最终回复。现纳入契约单源，收答前保留
   * 7 个可用工具轮（0-6，与 maxRounds=8 及预算弹性扩展配合）；7 轮工具 +
   * 1 轮文件生成保底轮（toolset 收窄，见 ai.js 收答保底）。
   */
  finalAnswerRound: 7,
  /** 单回合工具调用总数上限（IterationBudget.maxTotalToolCalls）——按执行模式分档 */
  maxTotalToolCalls: Object.freeze({
    /** 非流式 chat 路径 */
    chat: 15,
    /**
     * 流式路径·单代理（ReAct 主链）。
     * 2026-09-07: 10 → 15——多步创作工作流(视频生成: 探索项目~5 + 写组件~3 +
     * 渲染/状态查询~3)在 10 的预算下死于探索期(宣传片实测: 三轮全没走到
     * Write/Render); 且与 chat(15)/多代理(15) 不一致本无依据。
     */
    chatStreamSingleAgent: 15,
    /** 流式路径·多代理委派（task-mode 命中） */
    chatStreamMultiAgent: 15,
  }),
  /** 回合超时（ms）——超过即 IterationBudget 强制收口 */
  roundTimeoutMs: 120000,
});

/** 便捷取值：chat 路径参数包 */
function chatLoopParams() {
  const { maxRounds, maxTotalToolCalls, roundTimeoutMs } = AGENT_LOOP_CONTRACT;
  return { maxIterations: maxRounds, maxTotalToolCalls: maxTotalToolCalls.chat, timeoutMs: roundTimeoutMs };
}

/** 便捷取值：chatStream 路径参数包（按是否多代理分档） */
function chatStreamLoopParams(useMultiAgent) {
  const { maxRounds, maxTotalToolCalls, roundTimeoutMs } = AGENT_LOOP_CONTRACT;
  return {
    maxIterations: maxRounds,
    maxTotalToolCalls: useMultiAgent ? maxTotalToolCalls.chatStreamMultiAgent : maxTotalToolCalls.chatStreamSingleAgent,
    timeoutMs: roundTimeoutMs,
  };
}

module.exports = { AGENT_LOOP_CONTRACT, chatLoopParams, chatStreamLoopParams };
