/**
 * tool-gate.js — 工具调用前置关卡（Loop 独立成层·第二刀, 2026-09-04）
 *
 * 从 ai.js executeToolCall 前半段抽出：一次工具调用在"真正执行"之前必须依次
 * 通过的六道关卡，全部通过才放行给执行段：
 *   ① 参数解析与修复(repairToolCallArguments)  ② 护栏已阻断判定(可见即记录)
 *   ③ beforeCall 守卫                          ④ 熔断器
 *   ⑤ 工具存在性                               ⑥ 文件写入保护 + preToolHook
 *
 * 设计：工厂注入 deps——ai.js 持有的单例/环境经显式依赖传入，本模块零模块级
 * 可变状态（agent 层"核心不知道产品"语义）；auditSynthetic 可注入（单测防落盘）。
 * 返回判别联合：{ pass: true, name, params, tool } | { pass: false, result }。
 */

const { ToolGuardrailDecision, buildAuditedSyntheticResult } = require('../tool-guardrails');
const { repairToolCallArguments } = require('../tool-call-id');

const WRITE_PROTECTED_TOOLS = ['Write', 'Edit', 'DeleteFile', 'CreateDirectory'];

function createToolGate(deps = {}) {
  const {
    toolGuardrail,
    globalFailureGuard,
    getCircuitBreakerRegistry,
    toolSystem,
    isWriteDenied,
    shellHooksBridge,
    WORKSPACE_DIR,
    getUserId = () => '',
    auditSynthetic = buildAuditedSyntheticResult,
    log = console,
  } = deps;

  /**
   * @param {{function?: {name?: string, arguments?: string|object}, name?: string, params?: object}} toolCall
   * @returns {Promise<{pass: true, name: string, params: object, tool: object}
   *                   | {pass: false, result: {error: string, circuitBreaker?: boolean}}>}
   */
  async function gateToolCall(toolCall) {
    const name = toolCall.function?.name || toolCall.name;
    let params = {};

    // ① 参数解析与修复
    try {
      if (toolCall.function?.arguments) {
        if (typeof toolCall.function.arguments === 'string') {
          const repaired = repairToolCallArguments(toolCall.function.arguments, name);
          params = JSON.parse(repaired);
        } else {
          params = toolCall.function.arguments;
        }
      } else if (toolCall.params) {
        params = toolCall.params;
      }
    } catch (e) {
      return { pass: false, result: { error: `参数解析失败: ${e.message}` } };
    }

    // ② 护栏已阻断判定（可见即记录：阻断结果模型必然可见 → 构造即落审计）
    if (toolGuardrail.isBlocked()) {
      log.warn('🛑 工具调用被护栏阻止:', toolGuardrail.getBlockedReason());
      const haltDecision = toolGuardrail.getHaltDecision();
      const blockedDecision = haltDecision || new ToolGuardrailDecision({
        action: 'block',
        code: 'previously_blocked',
        message: toolGuardrail.getBlockedReason() || '工具调用被护栏阻止',
        toolName: name,
      });
      const errorMsg = auditSynthetic(blockedDecision, { phase: 'already_blocked' });

      const failureMsg = globalFailureGuard.record(name, 'blocked', false, errorMsg);
      if (failureMsg) return { pass: false, result: { error: failureMsg, circuitBreaker: true } };
      return { pass: false, result: { error: errorMsg } };
    }

    // ③ beforeCall 守卫
    const beforeDecision = toolGuardrail.beforeCall(name, params);
    if (beforeDecision.shouldHalt) {
      log.warn('🛑 工具调用被护栏前置检查阻止:', beforeDecision.message);
      const failureMsg = globalFailureGuard.record(name, 'pre-check-blocked', false, beforeDecision.message);
      if (failureMsg) return { pass: false, result: { error: failureMsg, circuitBreaker: true } };
      return { pass: false, result: { error: auditSynthetic(beforeDecision, { phase: 'before_call' }) } };
    }

    // ④ 熔断器（外部依赖类工具偶发不稳时更宽容，避免瞬断锁死）
    const breakerRegistry = getCircuitBreakerRegistry();
    const breaker = breakerRegistry.getBreaker(name, /weather/i.test(name)
      ? { failureThreshold: 6, failureRateThreshold: 0.6, resetDuration: 30000 }
      : {});
    if (breaker.isOpen()) {
      log.warn(`⚡ 熔断器 [${name}] 已开启，拒绝调用`);
      return { pass: false, result: { error: `工具 ${name} 熔断器已开启，暂时不可用（连续失败过多），请稍后重试` } };
    }

    // ⑤ 工具存在性
    const tool = toolSystem.get(name);
    if (!tool) {
      return { pass: false, result: { error: `未知工具: ${name}` } };
    }

    // ⑥a 文件写入保护
    if (WRITE_PROTECTED_TOOLS.includes(name) && params.file_path) {
      const writeCheck = isWriteDenied(params.file_path);
      if (writeCheck.denied) {
        log.warn(`🛑 文件安全写入保护: ${params.file_path} (${writeCheck.reason})`);
        return { pass: false, result: { error: `文件写入被安全策略阻止: ${params.file_path} (${writeCheck.reason})` } };
      }
    }

    // ⑥b preToolHook（Shell Hook 按会话归属）
    const preToolHook = await shellHooksBridge.invokeHook('pre_tool_call', {
      toolName: name,
      toolInput: params,
      sessionId: getUserId() || '',
      cwd: WORKSPACE_DIR,
    });
    if (preToolHook.blocked) {
      return { pass: false, result: { error: `工具调用被 Shell Hook 拦截: ${preToolHook.reason}` } };
    }

    return { pass: true, name, params, tool, breaker };
  }

  return { gateToolCall };
}

module.exports = { createToolGate, WRITE_PROTECTED_TOOLS };
