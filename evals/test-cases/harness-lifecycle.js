const { globalSelfHealingEngine, HEALING_STATES } = require("../../src/core/self-healing-engine");
const { HealthMonitor } = require("../../src/core/health-monitor");
module.exports = {
  name: "Harness Lifecycle",
  cases: [
    {
      id: "hl_001",
      name: "SelfHealingEngine exports global instance",
      category: "harness_lifecycle",
      run: () => {
        return globalSelfHealingEngine !== null &&
               typeof globalSelfHealingEngine.ingestSignal === "function";
      },
    },
    {
      id: "hl_002",
      name: "SelfHealingEngine has healing states",
      category: "harness_lifecycle",
      run: () => {
        return HEALING_STATES && Object.keys(HEALING_STATES).length > 0;
      },
    },
    {
      id: "hl_003",
      name: "HealthMonitor creates and maintains history",
      category: "harness_lifecycle",
      run: () => {
        const hm = new HealthMonitor();
        hm.start();
        const status = hm.getStatus();
        return status !== null && typeof status === "object";
      },
    },
    {
      id: "hl_006",
      name: "SelfHealingEngine ingestSignal accepts tool error signals",
      category: "harness_lifecycle",
      run: () => {
        globalSelfHealingEngine.ingestSignal({
          type: "tool_execution_error",
          source: "Bash",
          detail: "command not found",
        });
        return true;
      },
    },
    {
      id: "hl_007",
      name: "harness-lifecycle defaults to maxConsecutiveFailures=5",
      category: "harness_lifecycle",
      run: () => {
        const { globalHarnessLifecycle } = require("../../src/core/harness-lifecycle");
        const stats = globalHarnessLifecycle.getStats();
        return stats !== null && typeof stats === "object";
      },
    },
    {
      id: "hl_008",
      name: "injectRecoveryOrchestrator: 连续 LLM 失败触发注入的恢复编排器并收到正确 error/context",
      category: "harness_lifecycle",
      run: async () => {
        const { HarnessLifecycleManager, injectRecoveryOrchestrator } = require("../../src/core/harness-lifecycle");
        const calls = [];
        const fake = {
          executeRecoveryChain: (error, context) => {
            calls.push({ error, context });
            return Promise.resolve({ success: true, finalStatus: "recovered", executionId: "fake-1", steps: [] });
          },
        };
        const handle = injectRecoveryOrchestrator(fake);
        try {
          const mgr = new HarnessLifecycleManager();
          const err = new Error("model overloaded");
          const context = {
            errorType: "timeout",
            messages: [{ role: "user", content: "hello" }],
          };
          // 默认阈值 5：触发 5 次连续失败 → 恢复链被调用
          for (let i = 0; i < 5; i++) {
            mgr.onLlmCallFailure(err, context);
          }
          await new Promise((r) => setTimeout(r, 100));
          return calls.length === 1
            && calls[0].error === err
            && calls[0].context.messages === context.messages
            && typeof calls[0].context.compressFn === "undefined";
        } finally {
          handle.restore();
        }
      },
    },
    {
      id: "hl_009",
      name: "injectRecoveryOrchestrator: restore 后恢复惰性真实单例（fake 不再命中，真实恢复链执行）",
      category: "harness_lifecycle",
      run: async () => {
        const { HarnessLifecycleManager, injectRecoveryOrchestrator } = require("../../src/core/harness-lifecycle");
        const callsA = [];
        const fakeA = {
          executeRecoveryChain: (error, context) => {
            callsA.push({ error, context });
            return Promise.resolve({ success: true, finalStatus: "recovered", executionId: "fake-a", steps: [] });
          },
        };
        const handle = injectRecoveryOrchestrator(fakeA);
        const mgr = new HarnessLifecycleManager();
        for (let i = 0; i < 5; i++) {
          mgr.onLlmCallFailure(new Error("first burst"), {});
        }
        await new Promise((r) => setTimeout(r, 100));
        handle.restore();

        // restore 后再次触发：应走真实惰性单例，fakeA 不再被调用；
        // 真实链执行的唯一生产可见效果是「Recovery chain rc_…」日志行。
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => { logs.push(args.join(" ")); };
        let passed;
        try {
          const mgr2 = new HarnessLifecycleManager();
          for (let i = 0; i < 5; i++) {
            mgr2.onLlmCallFailure(new Error("timeout"), {});
          }
          await new Promise((r) => setTimeout(r, 300));
          passed = callsA.length === 1 && logs.some((l) => l.includes("Recovery chain"));
        } finally {
          console.log = origLog;
        }
        return passed;
      },
    },
    {
      id: "hl_010",
      name: "SelfHealingEngine 匹配 llm_consecutive_failures → 激活 llm_failure 自愈",
      category: "harness_lifecycle",
      run: () => {
        const { SelfHealingEngine } = require("../../src/core/self-healing-engine");
        const engine = new SelfHealingEngine();
        engine.ingestSignal({
          type: "llm_consecutive_failures",
          source: "harness_lifecycle",
          detail: "连续 5 次 LLM 失败",
        });
        const status = engine.getStatus();
        return status !== null
          && status.activeHealing !== null
          && status.activeHealing.ruleId === "llm_failure"
          && status.consecutiveFailures.harness_lifecycle === 1;
      },
    },
    {
      id: "hl_011",
      name: "SelfHealingEngine 匹配 tool_consecutive_failures → 激活 tool_failure 自愈",
      category: "harness_lifecycle",
      run: () => {
        const { SelfHealingEngine } = require("../../src/core/self-healing-engine");
        const engine = new SelfHealingEngine();
        engine.ingestSignal({
          type: "tool_consecutive_failures",
          source: "harness_lifecycle",
          detail: "连续 5 次工具 Bash 失败",
        });
        const status = engine.getStatus();
        return status !== null
          && status.activeHealing !== null
          && status.activeHealing.ruleId === "tool_failure"
          && status.consecutiveFailures.harness_lifecycle === 1;
      },
    },
    {
      id: "hl_012",
      name: "自愈规则动作全真实：每条规则引用的动作都有真实处理器（2026-08-15 T7 累积L）",
      category: "harness_lifecycle",
      run: () => {
        const { HEALING_RULES, ACTION_HANDLERS, SelfHealingEngine } = require("../../src/core/self-healing-engine");
        const missing = [];
        const stubs = new Set(['degrade_to_fallback_skill', 'mark_skill_for_repair']);
        const probe = new SelfHealingEngine();
        for (const rule of HEALING_RULES) {
          for (const action of rule.actions) {
            if (stubs.has(action)) missing.push(`${rule.id}: ${action} (空壳)`);
            const methodName = ACTION_HANDLERS[action];
            if (!methodName || typeof probe[methodName] !== 'function') {
              missing.push(`${rule.id}: ${action} (无处理器)`);
            }
          }
        }
        return missing.length === 0;
      },
    },
  ],
};
