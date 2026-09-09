/**
 * decision-tools.js — 决策溯源工具（semantica ProvenanceManager 范式的 LLM 自查入口）
 * DecisionTrace：按主题/runId 查决策与证据链；DecisionVerify：哈希链完整性校验。
 */
const { registry } = require('./registry');

const TRACE_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    runId: { type: 'string' },
  },
  required: ['query'],
  additionalProperties: false,
};
const TRACE_WHEN_NOT_TO_USE = [
  "Don't use for current-turn decisions — trace reads the persisted decision history of previous runs",
  "Don't use unless the question is about what the assistant previously did/decided (provenance check)",
  "Don't use for knowledge-base content questions — use KbSearch",
];
const TRACE_RISK = 'low';

const VERIFY_SCHEMA = {
  type: 'object',
  properties: { runId: { type: 'string' } },
  required: [],
  additionalProperties: false,
};
const VERIFY_WHEN_NOT_TO_USE = [
  "Don't use in every conversation — integrity verification is a full-chain scan; use only when audit/tamper suspicion exists",
];
const VERIFY_RISK = 'low';

registry.register({
  name: 'DecisionTrace',
  toolset: 'memory',
  category: 'memory',
  description: '查询既往决策的溯源链：按主题关键词或 runId 返回决策记录（意图/结论/工具序列）、证据边与引用来源。回答「之前是怎么决定的/基于什么」类问题时使用',
  whenNotToUse: TRACE_WHEN_NOT_TO_USE,
  riskLevel: TRACE_RISK,
  timeout: 15000,
  isReadOnly: true,
  schema: TRACE_SCHEMA,
  async handler(params) {
    const { getUnifiedStore } = require('../core/memory/unified-store');
    const { getLineage } = require('../core/memory/provenance-chain');
    const store = getUnifiedStore();
    const query = (params && params.query) || '';
    const runId = params && params.runId;
    try {
      if (runId) {
        const lineage = getLineage(store, runId);
        if (!lineage) return { success: true, matches: [], note: '未找到 runId=' + runId + ' 的决策记录' };
        return { success: true, matches: [lineage] };
      }
      const like = '%' + query + '%';
      const rows = store.all(
        `SELECT run_id FROM decisions
         WHERE user_intent LIKE ? OR conclusion LIKE ? OR plan LIKE ?
         ORDER BY sequence_id DESC LIMIT 5`,
        [like, like, like]
      );
      const matches = rows.map((r) => getLineage(store, r.run_id)).filter(Boolean);
      return { success: true, matches };
    } catch (e) {
      console.error('[DecisionTrace] 决策溯源查询失败:', e.message);
      return { success: false, error: '决策溯源查询失败（' + e.message + '）' };
    }
  },
});

registry.register({
  name: 'DecisionVerify',
  toolset: 'memory',
  category: 'memory',
  description: '校验决策哈希链的完整性（SHA-256 链式校验）：返回 chainIntegrity/brokenAt/total，检测记录是否被篡改',
  whenNotToUse: VERIFY_WHEN_NOT_TO_USE,
  riskLevel: VERIFY_RISK,
  timeout: 15000,
  isReadOnly: true,
  schema: VERIFY_SCHEMA,
  async handler(params) {
    const { getUnifiedStore } = require('../core/memory/unified-store');
    const { verifyChain } = require('../core/memory/provenance-chain');
    const store = getUnifiedStore();
    try {
      // 全链校验（runId 为契约保留字段，校验语义即整链不可篡改）
      const result = verifyChain(store);
      return { success: true, chainIntegrity: result.chainIntegrity, brokenAt: result.brokenAt, total: result.total };
    } catch (e) {
      console.error('[DecisionVerify] 链校验失败:', e.message);
      return { success: false, error: '链校验失败（' + e.message + '）' };
    }
  },
});

module.exports = {
  DecisionTrace: () => registry.get('DecisionTrace'),
  DecisionVerify: () => registry.get('DecisionVerify'),
};
