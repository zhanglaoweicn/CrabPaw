/**
 * loop-skeleton.js — 循环骨架共享件（Loop 独立成层·第三刀第一小步, 2026-09-04）
 *
 * 背景（双循环测绘结论）：chat() 与 chatStream() 的工具结果→内容构建段逐字重复
 * 且已发生复制漂移——流式版错误提示结尾多一个 ']'（无语义的复制错误）。
 * 本模块把"工具结果 → 模型可见内容"的构建收敛为单一事实源。
 *
 * 层语义：纯函数模块，不知道 budget/消息数组/流（这些留在调用方）。
 */

/** 工具失败统一提示（单一事实源——漂移修复：流式版结尾曾多一个 ']'） */
const TOOL_FAILURE_HINT = '\n\n[系统提示] 此工具调用已失败，请不要再次调用相同工具，请直接根据已有信息回答用户，或尝试其他方法。如怀疑是工具缺失，可尝试使用 ToolEvolution { action: "generateTemplate" } 创建。';

/** 工具缺口自愈提示（chat 路径专属——告诉 Agent 可以自创建缺失工具） */
function buildToolGapHealContent(toolName, toolGap) {
  return `🔧 [工具缺口检测] 工具 '${toolName}' 不存在。

**你可以自己创建这个工具！**

缺口类型: ${toolGap.gapType}
建议名称: ${toolGap.suggestedName}
原因: ${toolGap.reason}

**步骤：**
1. 调用 ToolEvolution { action: "generateTemplate", name: "${toolGap.suggestedName}", description: "你的描述" } 获取契约模板
2. 审查并调整模板（特别注意 schema 和 riskLevel）
3. 调用 ToolEvolution { action: "registerTool", contract: {...} } 注册工具
4. 注册成功后，立即重新调用 ${toolGap.suggestedName}

生成的契约模板参考:
\`\`\`json
${JSON.stringify(toolGap.contractTemplate, null, 2)}
\`\`\``;
}

/**
 * 工具结果 → 模型可见内容（chat/chatStream 共用）。
 * @param {{toolName?: string, toolCall: object, toolResult: object|string, success: boolean,
 *          toolGapHeal?: boolean}} p toolGapHeal: 失败且带 toolGap 标记时输出自愈提示(chat 专属)
 * @returns {string}
 */
function buildToolResultContent({ toolCall, toolResult, success, toolGapHeal = false }) {
  if (success) {
    return typeof toolResult === 'object' ? toolResult.content : toolResult;
  }
  const errMsg = typeof toolResult === 'object' ? (toolResult.error || '未知错误') : toolResult;
  const toolGap = toolGapHeal && typeof toolResult === 'object' ? toolResult.toolGap : null;
  if (toolGap) {
    const toolName = toolCall.function?.name || 'unknown';
    return buildToolGapHealContent(toolName, toolGap);
  }
  return `错误: ${errMsg}` + TOOL_FAILURE_HINT;
}

/**
 * 每轮工具结果批处理（Loop 第五刀, 2026-09-05）——chat() for 循环体的共享件。
 *
 * 逐条处理 executeToolCallsConcurrent 的结果：失败计数、内容构建（第三刀）、
 * 结果持久化、护栏警告、lastToolResult 捕获、needsConfirmation 提前返回信号、
 * 预算警告注入、上下文压力警告、tool 消息回填。
 *
 * @param {object} p
 * @param {Array}  p.toolResults  executeToolCallsConcurrent 的结果
 * @param {Array}  p.messages     会话消息数组（本函数向其 push tool 消息）
 * @param {object} p.budget       IterationBudget 实例（injectBudgetWarning/getIteration）
 * @param {string} p.userId       会话用户
 * @param {string} p.message      原始用户消息
 * @param {number} p.consecutiveFailures 进入本批前的连续失败计数
 * @param {string|null} p.lastToolResult 进入本批前的首个成功工具结果
 * @param {object} deps 注入依赖：persistToolResultContent/unifiedAddMessage/
 *                      contextCache/lifecycleManager/estimateMessagesTokens/
 *                      contextCompressor/toolGuardrail/log
 * @returns {{ consecutiveFailures: number, lastToolResult: string|null, earlyReturn: string|null }}
 *   earlyReturn 非空 = needsConfirmation 确认话术，调用方应立即 return 该值
 */
function processToolResultEntries(p, deps = {}) {
  const {
    persistToolResultContent,
    unifiedAddMessage,
    contextCache,
    lifecycleManager,
    estimateMessagesTokens,
    contextCompressor,
    toolGuardrail,
    log = console,
  } = deps;
  const { toolResults, messages, budget, userId, message } = p;
  let consecutiveFailures = p.consecutiveFailures || 0;
  let lastToolResult = p.lastToolResult || null;
  let earlyReturn = null;

  for (const { toolCall, result: toolResult, success, needsConfirmation } of toolResults) {
    log.log('📊 工具结果:', success ? '成功' : (typeof toolResult === 'object' ? (toolResult.error || '未知') : '未知'));

    if (success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }

    let resultContent = buildToolResultContent({ toolCall, toolResult, success, toolGapHeal: true });

    if (success && resultContent && typeof resultContent === 'string') {
      resultContent = persistToolResultContent(toolCall, resultContent);
    }

    const guardrailWarnings = toolGuardrail.getWarnings();
    if (guardrailWarnings.length > 0) {
      const latest = guardrailWarnings[guardrailWarnings.length - 1];
      log.warn(latest.message);
    }

    if (toolResult.success && toolResult.content && !lastToolResult) {
      lastToolResult = toolResult.content;
    }

    if (toolResult.needsConfirmation || needsConfirmation) {
      lifecycleManager.managedSet('pendingConfirmations', userId, {
        toolName: toolResult.toolName,
        params: toolResult.params,
        timestamp: Date.now(),
      });
      const reply = `⚠️ 需要确认\n\n${toolResult.message}\n\n如果确认执行，请回复"确认"或"是"。`;
      unifiedAddMessage(userId, 'user', message);
      unifiedAddMessage(userId, 'assistant', reply);
      contextCache.invalidateHistory(userId);
      // 提前返回信号：确认分支不回填 tool 消息（调用方立即 return）
      earlyReturn = reply;
      break;
    }

    // 注入迭代预算警告
    resultContent = budget.injectBudgetWarning(resultContent);

    // 上下文压力警告：消息总量接近压缩阈值时追加
    const currentMsgTokens = estimateMessagesTokens(messages);
    const contextMaxTokens = contextCompressor.maxTokens || 128000;
    const pressureRatio = currentMsgTokens / contextMaxTokens;
    const pressureThreshold = 0.7;
    if (pressureRatio > pressureThreshold) {
      const pressureWarning = `\n\n[CONTEXT PRESSURE: 上下文使用率 ${Math.round(pressureRatio * 100)}%，接近压缩阈值。请精简回复，避免冗长输出。]`;
      resultContent = resultContent + pressureWarning;
    }

    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: resultContent,
    });
  }

  return { consecutiveFailures, lastToolResult, earlyReturn };
}

module.exports = {
  buildToolResultContent,
  buildToolGapHealContent,
  TOOL_FAILURE_HINT,
  processToolResultEntries,
};
