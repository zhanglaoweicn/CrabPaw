/**
 * Audit Visibility（可见即记录）—— dsh 对标机制② 的不变量套件（2026-09-03 P1-③）。
 *
 * 不变量：凡是模型看得见的守卫阻断结果，审计里必然存在对应条目。
 * 背景：此前 TOOL_EXECUTE/TOOL_DENIED 在全仓零写入点——模型可见的阻断在审计里
 * 不存在，"AI 为什么没执行"在审批/合规视角无据可查。本套件红 = 有人拆了审计
 * 接线或新增了绕过 buildAuditedSyntheticResult 的裸合成路径。
 */

const fs = require('fs');
const path = require('path');

const {
  ToolGuardrailDecision,
  buildAuditedSyntheticResult,
} = require('../../src/core/tool-guardrails');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readRel(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

module.exports = {
  name: 'Audit Visibility (可见即记录)',
  cases: [
    {
      id: 'audit_vis_001',
      name: '守卫阻断合成结果构造即落审计(阻断语义字段 + 决策元数据)',
      category: 'audit-visibility',
      run: async () => {
        const decision = new ToolGuardrailDecision({
          action: 'block',
          code: 'repeated_exact_failure_block',
          message: '已阻止 Bash: 相同参数已失败 5 次。',
          toolName: 'Bash',
          count: 5,
        });
        const captured = [];
        const synthetic = buildAuditedSyntheticResult(decision, {
          phase: 'before_call',
          auditFn: (entry) => {
            captured.push(entry);
            return { id: 'test' };
          },
        });
        if (captured.length !== 1) throw new Error(`审计应写入 1 条, 实际 ${captured.length}`);
        const entry = captured[0];
        if (entry.action !== 'guardrail_block') throw new Error(`action 应为 guardrail_block, 实际 ${entry.action}`);
        if (entry.result !== 'blocked') throw new Error('result 应为 blocked');
        if (entry.resourceType !== 'tool' || entry.resource !== 'Bash') throw new Error('资源应为工具 Bash');
        if (!entry.metadata || !entry.metadata.guardrail || entry.metadata.guardrail.action !== 'block') {
          throw new Error('metadata.guardrail 决策元数据缺失');
        }
        if (entry.metadata.phase !== 'before_call' || entry.metadata.syntheticVisible !== true) {
          throw new Error('metadata.phase/syntheticVisible 缺失');
        }
        const parsed = JSON.parse(synthetic);
        if (!parsed.guardrail || parsed.guardrail.code !== 'repeated_exact_failure_block') {
          throw new Error('合成结果应携带 guardrail 元数据');
        }
        return '阻断即审计, 合成结果携带决策元数据';
      },
    },
    {
      id: 'audit_vis_002',
      name: '决策单调性: 冻结不可变 / combine 取最严 / 阻断不可降级',
      category: 'audit-visibility',
      run: async () => {
        const allow = new ToolGuardrailDecision({});
        const halt = new ToolGuardrailDecision({ action: 'halt', code: 'h', message: 'm' });
        const block = new ToolGuardrailDecision({ action: 'block', code: 'b', message: 'm' });
        if (ToolGuardrailDecision.combine(allow, halt) !== halt) throw new Error('combine 应取最严(halt)');
        if (ToolGuardrailDecision.combine(null, block, allow) !== block) throw new Error('combine 应取最严(block)');
        if (ToolGuardrailDecision.combine() !== null) throw new Error('combine 空入参应为 null');
        if (block.escalateTo('allow') !== block) throw new Error('block 不可降级为 allow');
        if (block.escalateTo('halt').action !== 'halt') throw new Error('block 可升级为 halt');
        const mutated = new ToolGuardrailDecision({ action: 'block' });
        try {
          mutated.action = 'allow';
        } catch (e) {
          // 冻结对象在严格模式下赋值抛错, 属预期
        }
        if (mutated.action !== 'block') throw new Error('决策对象应冻结不可变');
        if (!allow.allowsExecution || block.allowsExecution || halt.allowsExecution) throw new Error('allowsExecution 语义错误');
        if (!halt.shouldHalt || !block.shouldHalt || allow.shouldHalt) throw new Error('shouldHalt 语义错误');
        return '单调性: 只升不降, 阻断不可翻案';
      },
    },
    {
      id: 'audit_vis_003',
      name: '接线不变量: 阻断位点走审计合成(ai.js + agent/tool-gate, 零裸 buildSyntheticResult 调用)',
      category: 'audit-visibility',
      run: async () => {
        const aiSource = readRel('src/core/ai.js');
        const directCalls = (aiSource.match(/buildSyntheticResult\(/g) || []).length;
        if (directCalls > 0) {
          throw new Error(`ai.js 存在 ${directCalls} 处裸 buildSyntheticResult——模型可见结果未落审计, 应改用 buildAuditedSyntheticResult`);
        }
        // 2026-09-04 Loop 第二刀: executeToolCall 前段(含 2 处审计合成)迁入 agent/tool-gate,
        // 接线面 = ai.js 剩余阻断位点 + tool-gate 关卡位点, 两处合计仍须 ≥ 6。
        const gateSource = readRel('src/core/agent/tool-gate.js');
        const auditedCalls = (aiSource.match(/buildAuditedSyntheticResult\(/g) || []).length
          + (gateSource.match(/auditSynthetic\(/g) || []).length;
        if (auditedCalls < 6) throw new Error(`审计合成调用合计仅 ${auditedCalls} 处(<6), 接线疑似回退`);
        if (!gateSource.includes('auditSynthetic = buildAuditedSyntheticResult')) {
          throw new Error('tool-gate 未接审计合成(缺 auditSynthetic 注入默认)');
        }
        const guardSource = readRel('src/core/tool-guardrails.js');
        if (!/buildAuditedSyntheticResult/.test(guardSource)) {
          throw new Error('tool-guardrails 未实现/未导出 buildAuditedSyntheticResult');
        }
        return `接线完好: ai.js ${auditedCalls - 2} 处 + tool-gate 2 处, 全部走审计合成`;
      },
    },
  ],
};
