'use strict';

/**
 * tool-call-processor — chat / chatStream 共享的工具调用处理逻辑
 *
 * 提取自 ai.js 的 singleToolExecutor（chat L1833-1878）和内联 map（chatStream L3567-3624）。
 * 两者共享：显示 → 中间件 before → 执行 → 中间件 after → 预算记录 → 技能进化记录。
 * 差异点（流式事件 / toolCallCallback / 计数器）通过钩子注入，保持各自原有行为。
 *
 * 设计原则（对标 Harness "Tool as Contract"）：
 *   - 纯工厂 + 依赖注入：所有外部依赖通过 deps 传入，不引用 ai.js 全局状态
 *   - 行为等价：执行顺序、skip 短路、返回形状与原内联实现完全一致
 *   - 单一职责：只做"单工具执行包装"，结果聚合/确认/媒体事件留在各自函数中
 */

const { persistToolResult } = require('../tool-result-storage');
const { DEFAULT_BUDGET } = require('../budget-config');
const { getSkillEvolution } = require('../skill-metrics');

/**
 * 文档生成场景下阻止搜索工具的固定提示。
 * 原本在 chat 与 chatStream 中各硬编码一份，此处统一以避免漂移。
 */
const DOC_GENERATION_BLOCK_MESSAGE =
  '[系统规则] 搜索已经足够了！用户要求生成文档，请立即执行以下步骤：' +
  '1. 调用 Write 工具将内容写入 .md 文件；' +
  '2. 调用 MarkdownToWord/MarkdownToExcel 工具将 .md 转为 .docx/.xlsx；' +
  '3. 如果需要发送到企业微信，调用 SendWecomFile 工具。不要再搜索了！';

/**
 * 创建单工具执行器。
 *
 * 执行流程（与原 chat/chatStream 内联实现严格一致）：
 *   1. [可选] budget.incrementToolCalls()  — chat 的迭代预算计数
 *   2. console.log(display.formatToolStart(...))
 *   3. [可选] onToolStart(toolCall, toolName) — chat: toolCallCallback('start');
 *                                      chatStream: streamTotalToolCalls++ + onChunk('tool_call') + activityStream
 *   4. mwBefore = middleware.processBefore(...)
 *      - 若 mwBefore.skip：直接返回 { success: false, error }（不触发 onToolEnd，与原实现一致）
 *   5. result = _blockedByDocGeneration ? 阻止消息 : executeToolCall(toolCall)
 *   6. [可选] onToolEnd(toolCall, toolName, result, success) — chatStream: onChunk('tool_result') + activityStream
 *   7. budgetEnforcer.recordUsage('tool', toolName, ..., { category })
 *   8. mwAfter = middleware.processAfter(...)
 *   9. console.log(display.formatToolResult(...))
 *  10. skillEvolution.record(...)  — 技能进化记录
 *  11. [可选] onComplete(toolCall, toolName, result, success) — chat: toolCallCallback('end')
 *  12. return { toolCall, result: mwAfter.result || result, success: result.success === true }
 *
 *  注：原 chat 中 toolCallCallback('end') 在 formatToolResult 之前触发，此处统一到 evolution 之后。
 *  两者均为纯副作用（前端通知 + 日志），顺序调整不影响功能，且 chatStream 本就是此顺序。
 *
 * @param {object} deps
 * @param {string} deps.userId              会话用户 ID（中间件 sessionId 用）
 * @param {string} deps.message             当前用户消息（技能进化上下文用）
 * @param {Function} deps.executeToolCall   async (toolCall) => result
 * @param {object} deps.middleware          { processBefore, processAfter }（globalToolResultMiddleware）
 * @param {object} deps.display             { formatToolStart, formatToolResult }（globalToolDisplay）
 * @param {object} [deps.budget]            { incrementToolCalls }（BudgetEnforcer 实例，仅 chat 传入）
 * @param {Function} [deps.classifyCategory] (toolName) => category 字符串
 * @param {Function} [deps.onToolStart]     (toolCall, toolName) => void
 * @param {Function} [deps.onToolEnd]       (toolCall, toolName, result, success) => void
 * @param {Function} [deps.onComplete]      (toolCall, toolName, result, success) => void
 * @returns {Function} async (toolCall) => { toolCall, result, success }
 */
function createToolExecutor(deps) {
  const {
    userId,
    message,
    executeToolCall,
    middleware,
    display,
    budget,
    classifyCategory,
    onToolStart,
    onToolEnd,
    onComplete,
  } = deps;

  return async (toolCall) => {
    const toolName = toolCall.function?.name || 'unknown';

    // 1. 迭代预算计数——chat 与 chatStream 均传 budget(2026-08-15 P2-4 起流式也走 IterationBudget)
    if (budget && typeof budget.incrementToolCalls === 'function') {
      budget.incrementToolCalls();
    }

    // 2. 工具开始日志
    console.log(display.formatToolStart(toolName, toolCall.function?.arguments));

    // 3. 开始事件钩子（chat: toolCallCallback start；chatStream: onChunk+activityStream）
    if (onToolStart) {
      try { onToolStart(toolCall, toolName); }
      catch (e) { console.warn('[ai] onToolStart hook error:', e.message); }
    }

    // 4. 中间件 before（含 skip 短路）
    const mwBefore = await middleware.processBefore(
      toolName,
      toolCall.function?.arguments || {},
      { sessionId: userId }
    );
    if (mwBefore.skip) {
      console.log(`⏭️ 工具 ${toolName} 被中间件跳过: ${mwBefore.reason}`);
      // 与原实现一致：skip 时不触发 onToolEnd，直接返回失败结果
      return {
        toolCall,
        result: { success: false, error: mwBefore.reason || '被中间件跳过' },
        success: false,
      };
    }

    // 5. 执行工具（或返回文档生成阻止消息）
    const result = toolCall._blockedByDocGeneration
      ? { success: false, content: DOC_GENERATION_BLOCK_MESSAGE }
      : await executeToolCall(toolCall);

    // 6. 结束事件钩子（chatStream: onChunk('tool_result') + activityStream）
    if (onToolEnd) {
      try { onToolEnd(toolCall, toolName, result, result.success !== false); }
      catch (e) { console.warn('[ai] onToolEnd hook error:', e.message); }
    }

    // 7. 记录工具调用到 BudgetEnforcer 类别预算
    try {
      const { getBudgetEnforcer } = require('../budget-enforcer');
      getBudgetEnforcer().recordUsage('tool', toolName, null, null, null, {
        category: classifyCategory ? classifyCategory(toolName) : undefined,
      });
    } catch (e) {
      console.warn('[ai] Budget tracking recordUsage (tool loop):', e.message);
    }

    // 8. 中间件 after
    const mwAfter = await middleware.processAfter(toolName, result, { sessionId: userId });

    // 9. 工具结果日志
    console.log(
      display.formatToolResult(toolName, mwAfter.result || result, result.success ? 'success' : 'error')
    );

    // 10. 技能进化记录
    try {
      const evo = getSkillEvolution();
      const evoResult = mwAfter.result || result;
      const evoSuccess = result.success !== false;
      evo.record(
        toolName,
        JSON.parse(toolCall.function?.arguments || '{}'),
        { message },
        {
          success: evoSuccess,
          duration: 0,
          output: typeof evoResult === 'string'
            ? evoResult.substring(0, 200)
            : JSON.stringify(evoResult).substring(0, 200),
          error: evoSuccess ? undefined : (evoResult.error || 'unknown'),
        }
      );
    } catch (evoErr) {
      console.warn('⚠️ 技能进化记录异常:', evoErr.message);
    }

    // 11. 完成事件钩子（chat: toolCallCallback('end')）
    if (onComplete) {
      try { onComplete(toolCall, toolName, mwAfter.result || result, result.success === true); }
      catch (e) { console.warn('[ai] onComplete hook error:', e.message); }
    }

    // 12. 返回标准化结果
    // P3(2026-09-04 characterization 发现): needsConfirmation 确认返回无 success 字段,
    // 标准化 success:false 曾使其在 chat 提前返回分支永远失活(死路回归)——
    // 检测到确认返回时透传原始对象(不走 mwAfter), 由 chat 循环解构消费。
    if (result && result.needsConfirmation === true) {
      return { toolCall, result, success: false, needsConfirmation: true };
    }
    return {
      toolCall,
      result: mwAfter.result || result,
      success: result.success === true,
    };
  };
}

/**
 * 持久化工具结果内容（仅在成功且内容为字符串时）。
 * chat（L1927-1939）与 chatStream（L3758-3769）共享此逻辑。
 *
 * @param {object} toolCall        工具调用对象（需有 .id 和 .function.name）
 * @param {string} resultContent   原始结果内容
 * @param {object} [opts]          { budget } 覆盖默认预算配置
 * @returns {string} 可能被替换为预览的内容
 */
function persistToolResultContent(toolCall, resultContent, opts) {
  if (!resultContent || typeof resultContent !== 'string') return resultContent;
  const toolName = toolCall.function?.name || 'unknown';
  const persisted = persistToolResult({
    toolUseId: toolCall.id,
    content: resultContent,
    toolName,
    budget: (opts && opts.budget) || DEFAULT_BUDGET,
  });
  if (persisted.persisted) {
    console.log(`💾 工具结果已持久化: ${toolName} (${(resultContent.length / 1024).toFixed(1)}KB → 预览)`);
    return persisted.content;
  }
  return resultContent;
}

module.exports = {
  createToolExecutor,
  persistToolResultContent,
  DOC_GENERATION_BLOCK_MESSAGE,
};
