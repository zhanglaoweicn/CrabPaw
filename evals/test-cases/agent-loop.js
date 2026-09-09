/**
 * Agent Loop（循环契约与行为安全网）——Loop 独立成层·第一刀的验收套件（2026-09-04）。
 *
 * 断言三层：
 *  1. 契约完整性——AGENT_LOOP_CONTRACT 字段冻结、数值合理（8 轮/15 上限/120s）
 *  2. 源码一致性——ai.js 两处 IterationBudget 构造引用 loop-contract（防裸字面量回潮）
 *  3. 残留清零——MAX_TOTAL_TOOL_CALLS 中间常量已删（死引用地雷不复活）
 *
 * 行为级安全网另见既有套件：loop-detection（循环防护 3/5/20）、loop（budget 行为）。
 */

const fs = require('fs');
const path = require('path');
const { AGENT_LOOP_CONTRACT, chatLoopParams, chatStreamLoopParams } = require('../../src/core/agent/loop-contract');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readAiSource() {
  return fs.readFileSync(path.join(REPO_ROOT, 'src/core/ai.js'), 'utf-8');
}

module.exports = {
  name: 'Agent Loop (循环契约)',
  cases: [
    {
      id: 'aloop_001',
      name: '契约完整性: 字段冻结/数值合理/便捷取值三形态',
      category: 'agent-loop',
      run: async () => {
        if (!Object.isFrozen(AGENT_LOOP_CONTRACT)) throw new Error('契约未冻结');
        if (AGENT_LOOP_CONTRACT.maxRounds !== 8) throw new Error(`maxRounds=${AGENT_LOOP_CONTRACT.maxRounds} ≠ 8`);
        if (AGENT_LOOP_CONTRACT.roundTimeoutMs !== 120000) throw new Error('roundTimeoutMs ≠ 120000');
        const tc = AGENT_LOOP_CONTRACT.maxTotalToolCalls;
        if (tc.chat !== 15 || tc.chatStreamSingleAgent !== 15 || tc.chatStreamMultiAgent !== 15) {
          throw new Error(`工具上限分档漂移: ${JSON.stringify(tc)}`);
        }
        const c = chatLoopParams();
        if (c.maxIterations !== 8 || c.maxTotalToolCalls !== 15 || c.timeoutMs !== 120000) throw new Error('chat 参数包错误');
        const s1 = chatStreamLoopParams(false);
        const s2 = chatStreamLoopParams(true);
        if (s1.maxTotalToolCalls !== 15 || s2.maxTotalToolCalls !== 15) throw new Error('chatStream 分档错误');
        return '契约冻结且三形态取值正确';
      },
    },
    {
      id: 'aloop_002',
      name: '源码一致性: ai.js 两处 IterationBudget 构造引用契约(防裸字面量回潮)',
      category: 'agent-loop',
      run: async () => {
        const src = readAiSource();
        if (!src.includes("require('./agent/loop-contract')")) {
          throw new Error('ai.js 未引用 loop-contract');
        }
        if (/(maxIterations:\s*8)/.test(src)) throw new Error('ai.js 仍存在裸 maxIterations: 8 字面量');
        if (/(timeoutMs:\s*120000)/.test(src)) throw new Error('ai.js 仍存在裸 timeoutMs: 120000 字面量');
        const loopCallSites = (src.match(/chatLoopParams\(\)/g) || []).length + (src.match(/chatStreamLoopParams\(/g) || []).length;
        if (loopCallSites < 2) throw new Error(`契约取值调用仅 ${loopCallSites} 处(<2)`);
        return `ai.js 两处循环构造均引用契约`;
      },
    },
    {
      id: 'aloop_003',
      name: '残留清零: MAX_TOTAL_TOOL_CALLS 中间常量不复活',
      category: 'agent-loop',
      run: async () => {
        const src = readAiSource();
        if (/MAX_TOTAL_TOOL_CALLS/.test(src)) {
          throw new Error('MAX_TOTAL_TOOL_CALLS 中间常量复活(死引用地雷)');
        }
        return '中间常量清零';
      },
    },
    {
      id: 'aloop_004',
      name: '结果文案单一来源: ai.js 不再手写失败提示(两路径漂移修复后防复发)',
      category: 'agent-loop',
      run: async () => {
        const src = readAiSource();
        // 特征串: 此前 chat 版与 chatStream 版各有一份手写文案且已漂移(流式版尾部多 ])
        const drifted = (src.match(/此工具调用已失败/g) || []).length;
        if (drifted > 0) throw new Error(`ai.js 仍手写失败提示 ${drifted} 处——应引用 agent/loop-skeleton 的 TOOL_FAILURE_HINT`);
        const skel = fs.readFileSync(path.join(REPO_ROOT, 'src/core/agent/loop-skeleton.js'), 'utf-8');
        if (!skel.includes('TOOL_FAILURE_HINT')) throw new Error('loop-skeleton 未实现统一文案');
        if (skel.includes("尝试其他方法。]")) throw new Error('loop-skeleton 文案带漂移尾部 ]');
        return '失败文案单一来源: agent/loop-skeleton';
      },
    },
  ],
};
