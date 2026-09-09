/**
 * tag-system.js — 测试用例标记系统
 *
 * 借鉴参考实现的测试标记机制：
 *   - 每个测试用例可挂载多个 tag（category、severity、capability、feature）
 *   - tag 支持层级 (e.g., "scope:shell"  "priority:high")
 *   - 提供 filterByTags / groupByTags / summaryByTags
 *   - 与 EvalRunner 配合：可在 evals/index.js 启动时按 tag 过滤
 *
 * 用法:
 *   const { tags, matchesTags, filterByTags, groupByTags } = require('./tag-system');
 *   const cases = [{ id: 'a', tags: ['P0', 'scope:shell'], ... }];
 *   const p0Only = filterByTags(cases, ['P0']);
 */

const TAGS = {
  // 优先级
  P0: { type: 'priority', weight: 100, desc: '核心功能，阻塞性' },
  P1: { type: 'priority', weight: 50, desc: '重要功能，必须通过' },
  P2: { type: 'priority', weight: 20, desc: '增强功能，建议通过' },
  P3: { type: 'priority', weight: 10, desc: '边缘功能，允许失败' },

  // 能力域
  'cap:tool': { type: 'capability', desc: '工具调用相关' },
  'cap:context': { type: 'capability', desc: '上下文管理相关' },
  'cap:memory': { type: 'capability', desc: '记忆系统相关' },
  'cap:shell': { type: 'capability', desc: '持久化 Shell 相关' },
  'cap:agent': { type: 'capability', desc: 'Agent 委派相关' },
  'cap:self': { type: 'capability', desc: '自我感知相关' },
  'cap:scene': { type: 'capability', desc: '场景 UI 相关' },
  'cap:voice': { type: 'capability', desc: '语音相关' },
  'cap:workflow': { type: 'capability', desc: '工作流相关' },
  'cap:concept': { type: 'capability', desc: '概念提取相关' },
  'cap:time': { type: 'capability', desc: '时间解析相关' },

  // 严重度
  'severity:critical': { type: 'severity', desc: '失败导致系统不可用' },
  'severity:major': { type: 'severity', desc: '失败影响主要功能' },
  'severity:minor': { type: 'severity', desc: '失败仅影响边缘场景' },

  // 范围
  'scope:unit': { type: 'scope', desc: '单元测试' },
  'scope:integration': { type: 'scope', desc: '集成测试' },
  'scope:e2e': { type: 'scope', desc: '端到端测试' },
  'scope:stress': { type: 'scope', desc: '压力/性能测试' },
  'scope:safety': { type: 'scope', desc: '安全/越权测试' },

  // 特性
  'feat:aci': { type: 'feature', desc: 'ACI 预判注入' },
  'feat:loop': { type: 'feature', desc: '循环检测' },
  'feat:budget': { type: 'feature', desc: '预算执行' },
  'feat:router': { type: 'feature', desc: '工具路由' },
  'feat:hooks': { type: 'feature', desc: '钩子系统' },
  'feat:eval': { type: 'feature', desc: '评估系统' },
  'feat:scene': { type: 'feature', desc: '场景系统' },
  'feat:self': { type: 'feature', desc: '自我感知' },
  'feat:panel': { type: 'feature', desc: '信息面板' },
  'feat:plugin': { type: 'feature', desc: '插件系统' },
  'feat:memory': { type: 'feature', desc: '记忆系统' },
  'feat:voice': { type: 'feature', desc: '语音系统' },
  'feat:vision': { type: 'feature', desc: '视觉/图像' },
  'feat:browser': { type: 'feature', desc: '浏览器自动化' },
  'feat:shell': { type: 'feature', desc: '持久化 Shell' },
  'feat:agent': { type: 'feature', desc: 'Agent 委派' },
  'feat:evolution': { type: 'feature', desc: '自我进化' },
  'feat:awakening': { type: 'feature', desc: '启动唤醒' },
  'feat:concept': { type: 'feature', desc: '概念提取' },
  'feat:time': { type: 'feature', desc: '时间解析' },
  'feat:install': { type: 'feature', desc: '软件安装' },
};

const ALL_TAGS = Object.keys(TAGS);

/**
 * 判断一个用例是否匹配给定 tag 过滤集合
 * @param {object} tc  - 测试用例
 * @param {string[]} filterTags - 过滤 tag 数组（空数组=全部）
 * @returns {boolean}
 */
function matchesTags(tc, filterTags) {
  if (!filterTags || filterTags.length === 0) return true;
  if (!tc.tags || tc.tags.length === 0) return false;
  // 匹配规则：任一过滤 tag 出现在用例 tags 中即匹配（OR 语义）
  return filterTags.some(f => tc.tags.includes(f));
}

/**
 * 过滤用例列表
 */
function filterByTags(cases, filterTags) {
  return cases.filter(tc => matchesTags(tc, filterTags));
}

/**
 * 按 tag 分组
 * @returns {Map<string, object[]>}
 */
function groupByTags(cases) {
  const groups = new Map();
  for (const tc of cases) {
    const tg = (tc.tags && tc.tags.length > 0) ? tc.tags : ['__untagged__'];
    for (const t of tg) {
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(tc);
    }
  }
  return groups;
}

/**
 * 按 tag 汇总测试结果
 * @param {Array<{tags?:string[], passed:boolean}>} results
 * @returns {Object<string, {passed:number,total:number,passRate:number}>}
 */
function summaryByTags(results) {
  const summary = {};
  for (const r of results) {
    const tg = (r.tags && r.tags.length > 0) ? r.tags : ['__untagged__'];
    for (const t of tg) {
      if (!summary[t]) summary[t] = { passed: 0, total: 0 };
      summary[t].total++;
      if (r.passed) summary[t].passed++;
    }
  }
  for (const [k, v] of Object.entries(summary)) {
    v.passRate = v.total > 0 ? Number((v.passed / v.total * 100).toFixed(1)) : 0;
  }
  return summary;
}

/**
 * 计算 tag 加权得分（基于 TAGS 中的 weight）
 * @param {Array<{tags?:string[], passed:boolean}>} results
 */
function weightedScore(results) {
  let total = 0;
  let earned = 0;
  for (const r of results) {
    const tg = (r.tags && r.tags.length > 0) ? r.tags : [];
    // 取最高权重
    let w = 1;
    for (const t of tg) {
      if (TAGS[t] && TAGS[t].weight) {
        w = Math.max(w, TAGS[t].weight);
      }
    }
    total += w;
    if (r.passed) earned += w;
  }
  return total > 0 ? Number((earned / total * 100).toFixed(1)) : 0;
}

/**
 * 给测试用例补充默认 tag
 */
function withDefaultTags(tc) {
  if (!tc.tags) tc.tags = [];
  // 默认 scope:unit
  if (!tc.tags.some(t => t.startsWith('scope:'))) {
    tc.tags.push('scope:unit');
  }
  // 默认 category → cap
  if (tc.category && !tc.tags.some(t => t.startsWith('cap:'))) {
    tc.tags.push(`cap:${tc.category}`);
  }
  return tc;
}

module.exports = {
  TAGS,
  ALL_TAGS,
  matchesTags,
  filterByTags,
  groupByTags,
  summaryByTags,
  weightedScore,
  withDefaultTags,
};
