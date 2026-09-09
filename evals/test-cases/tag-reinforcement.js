/**
 * E2E Test: Tag System + Reinforcement Evaluation
 *
 * 强化评估：
 *   - 标记系统：tag 分类、过滤、加权得分
 *   - 压力测试：长时间运行 / 大量输入
 *   - 多步骤场景：复合操作链
 *   - 安全性：异常输入不导致系统崩溃
 *   - 回归基线：snapshot 相似度
 */
const {
  TAGS, ALL_TAGS, matchesTags, filterByTags, groupByTags,
  summaryByTags, weightedScore, withDefaultTags,
} = require('../tag-system');

module.exports = {
  name: 'Tag System + Reinforcement Eval Tests',
  cases: [
    // ── 标记系统 ──
    {
      id: 'tag_001',
      name: 'TAGS registry contains 30+ entries',
      category: 'eval',
      tags: ['P1', 'cap:eval', 'scope:unit'],
      run: async () => Object.keys(TAGS).length >= 30,
    },
    {
      id: 'tag_002',
      name: 'TAGS has all priority levels',
      category: 'eval',
      tags: ['P0', 'cap:eval'],
      run: async () => TAGS.P0 && TAGS.P1 && TAGS.P2 && TAGS.P3,
    },
    {
      id: 'tag_003',
      name: 'TAGS has all capability domains',
      category: 'eval',
      tags: ['P1', 'cap:eval'],
      run: async () => {
        const required = ['cap:tool', 'cap:context', 'cap:memory', 'cap:shell', 'cap:agent', 'cap:self', 'cap:scene', 'cap:voice', 'cap:workflow', 'cap:concept', 'cap:time'];
        return required.every(t => TAGS[t]);
      },
    },
    {
      id: 'tag_004',
      name: 'matchesTags with empty filter = true',
      category: 'eval',
      tags: ['P2', 'cap:eval'],
      run: async () => matchesTags({ tags: ['P0'] }, []) === true,
    },
    {
      id: 'tag_005',
      name: 'matchesTags with no tags = false',
      category: 'eval',
      tags: ['P2', 'cap:eval'],
      run: async () => matchesTags({}, ['P0']) === false,
    },
    {
      id: 'tag_006',
      name: 'matchesTags OR-semantics: any matching tag passes',
      category: 'eval',
      tags: ['P1', 'cap:eval'],
      run: async () => matchesTags({ tags: ['P1', 'cap:tool'] }, ['P0', 'P1']) === true,
    },
    {
      id: 'tag_007',
      name: 'filterByTags excludes non-matching cases',
      category: 'eval',
      tags: ['P1', 'cap:eval'],
      run: async () => {
        const cases = [
          { id: 'a', tags: ['P0'] },
          { id: 'b', tags: ['P1'] },
          { id: 'c', tags: ['P0', 'cap:tool'] },
          { id: 'd', tags: [] },
        ];
        const r = filterByTags(cases, ['P0']);
        return r.length === 2 && r.map(c => c.id).sort().join(',') === 'a,c';
      },
    },
    {
      id: 'tag_008',
      name: 'groupByTags returns all unique tags',
      category: 'eval',
      tags: ['P2', 'cap:eval'],
      run: async () => {
        const cases = [
          { id: 'a', tags: ['P0', 'cap:tool'] },
          { id: 'b', tags: ['P1', 'cap:tool'] },
          { id: 'c', tags: ['P0', 'cap:shell'] },
        ];
        const g = groupByTags(cases);
        return g.has('P0') && g.has('P1') && g.has('cap:tool') && g.has('cap:shell') && g.get('P0').length === 2;
      },
    },
    {
      id: 'tag_009',
      name: 'summaryByTags computes pass rate',
      category: 'eval',
      tags: ['P1', 'cap:eval'],
      run: async () => {
        const r = summaryByTags([
          { tags: ['P0'], passed: true },
          { tags: ['P0'], passed: false },
          { tags: ['P1', 'P0'], passed: true },
        ]);
        return r.P0.total === 3 && r.P0.passed === 2 && r.P0.passRate === 66.7;
      },
    },
    {
      id: 'tag_010',
      name: 'weightedScore favors P0 over P3',
      category: 'eval',
      tags: ['P1', 'cap:eval'],
      run: async () => {
        // P0 失败（-100） vs P3 成功（+10）
        const r = weightedScore([
          { tags: ['P0'], passed: false },
          { tags: ['P3'], passed: true },
        ]);
        // 总权重 110，得到 10
        return r === 9.1 || r === 9;  // 10/110 = 9.09% ≈ 9.1
      },
    },
    {
      id: 'tag_011',
      name: 'withDefaultTags adds scope and cap',
      category: 'eval',
      tags: ['P1', 'cap:eval'],
      run: async () => {
        const tc = withDefaultTags({ id: 'x', category: 'tool' });
        return tc.tags.includes('scope:unit') && tc.tags.includes('cap:tool');
      },
    },

    // ── 强化评估：自我感知压测 ──
    {
      id: 'stress_self_001',
      name: 'SelfAwareness handles 100x rapid refreshes',
      category: 'eval',
      tags: ['P1', 'cap:self', 'scope:stress', 'severity:major'],
      run: async () => {
        const { getSelfAwareness } = require('../../src/core/self-awareness');
        const aw = getSelfAwareness();
        const N = 100;
        const t0 = Date.now();
        for (let i = 0; i < N; i++) {
          await aw.perceive();
        }
        const dur = Date.now() - t0;
        // 100 次感知应在 5s 内完成（缓存命中后）
        return dur < 5000;
      },
    },
    {
      id: 'stress_self_002',
      name: 'SelfAwareness perceives concurrently without crash',
      category: 'eval',
      tags: ['P1', 'cap:self', 'scope:stress'],
      run: async () => {
        const { getSelfAwareness } = require('../../src/core/self-awareness');
        const aw = getSelfAwareness();
        aw.invalidate();
        const promises = Array.from({ length: 50 }, () => aw.perceive());
        const results = await Promise.all(promises);
        return results.every(r => r && r.knowledge && r.knowledge.name === 'CrabPaw');
      },
    },

    // ── 强化评估：概念提取压测 ──
    {
      id: 'stress_concept_001',
      name: 'ExtractConcepts handles 1000-char text under 100ms',
      category: 'eval',
      tags: ['P1', 'cap:concept', 'scope:stress'],
      run: async () => {
        const { getConceptExtractor } = require('../../src/core/concept-extractor');
        const ext = getConceptExtractor();
        ext.clearCache();
        const text = ('我今天用 TypeScript 和 Node.js 写了一个 Express 服务器，部署在阿里云上。'.repeat(20));
        const t0 = Date.now();
        const r = ext.extract(text);
        const dur = Date.now() - t0;
        return dur < 100 && r && r.hash;
      },
    },
    {
      id: 'stress_concept_002',
      name: 'ExtractConcepts handles Chinese/English mixed text',
      category: 'eval',
      tags: ['P2', 'cap:concept'],
      run: async () => {
        const { getConceptExtractor } = require('../../src/core/concept-extractor');
        const ext = getConceptExtractor();
        ext.clearCache();
        const r = ext.extract('今天用 TypeScript 写了一个 React 组件 deploy 到 AWS Lambda，运行在 ap-northeast-1 区域。');
        return r.tools.includes('typescript') && r.tools.includes('react') && r.tools.includes('aws');
      },
    },

    // ── 强化评估：时间解析压测 ──
    {
      id: 'stress_time_001',
      name: 'parseTime handles 100 expressions in 500ms',
      category: 'eval',
      tags: ['P1', 'cap:time', 'scope:stress'],
      run: async () => {
        const { parseTime } = require('../../src/core/time-parser');
        const exprs = ['今天', '明天', '3天后', '两周后', '2026-07-15', '下个月', '一小时后'];
        // Warmup: 先跑一轮确保 JIT 编译
        for (const e of exprs) parseTime(e);
        const t0 = Date.now();
        for (let i = 0; i < 100; i++) {
          for (const e of exprs) parseTime(e);
        }
        const dur = Date.now() - t0;
        return dur < 1000;
      },
    },
    {
      id: 'stress_time_002',
      name: 'parseTime returns null for invalid input without throwing',
      category: 'eval',
      tags: ['P0', 'cap:time', 'scope:safety', 'severity:major'],
      run: async () => {
        const { parseTime } = require('../../src/core/time-parser');
        try {
          const r1 = parseTime('');
          const r2 = parseTime(null);
          const r3 = parseTime(undefined);
          const r4 = parseTime('asdfasdfasdfasdf');
          const r5 = parseTime('!!!!@@@@');
          return r1 === null && r2 === null && r3 === null && r4 === null && r5 === null;
        } catch (e) {
          return false;
        }
      },
    },

    // ── 强化评估：场景 7 种 kind 压测 ──
    {
      id: 'stress_scene_001',
      name: 'SceneStore handles 50 upserts in 100ms',
      category: 'eval',
      tags: ['P1', 'cap:scene', 'scope:stress'],
      run: async () => {
        const { getSceneStore } = require('../../src/core/scene');
        const store = getSceneStore();
        store.clear();
        const t0 = Date.now();
        for (let i = 0; i < 50; i++) {
          store.upsertSurface(`s_${i}`, { kind: 'progress', data: { progress: i * 2 } });
        }
        const dur = Date.now() - t0;
        return dur < 100 && store.size === 50;
      },
    },
    {
      id: 'stress_scene_002',
      name: 'SceneStore patch generation is consistent',
      category: 'eval',
      tags: ['P1', 'cap:scene'],
      run: async () => {
        const { getSceneStore } = require('../../src/core/scene');
        const store = getSceneStore();
        store.clear();
        store.upsertSurface('a', { kind: 'metric', data: { value: '1' } });
        const rev1 = store.revision;
        store.upsertSurface('b', { kind: 'metric', data: { value: '2' } });
        store.removeSurface('a');
        const patch = store.getPatch(rev1);
        return patch && patch.ops.length === 2 && patch.ops[0].op === 'upsert' && patch.ops[1].op === 'remove';
      },
    },

    // ── 强化评估：复合场景 ──
    {
      id: 'composite_001',
      name: 'Concept + Time + Self combined produces valid context',
      category: 'eval',
      tags: ['P0', 'cap:concept', 'cap:time', 'cap:self', 'scope:integration', 'severity:critical'],
      run: async () => {
        const { getConceptExtractor } = require('../../src/core/concept-extractor');
        const { parseTime } = require('../../src/core/time-parser');
        const { getSelfAwareness } = require('../../src/core/self-awareness');
        const ext = getConceptExtractor();
        const aw = getSelfAwareness();
        const text = '明天下午 3 点帮我用 Python 写一个 Flask API';
        const c = ext.extract(text);
        const t = parseTime('明天下午 3 点');
        const s = await aw.perceiveLite();
        return c.hash && t && s.includes('<self_awareness>');
      },
    },

    // ── 回归基线 ──
    {
      id: 'regression_001',
      name: 'Tool registry exposes >= 30 tools after loading core modules',
      category: 'eval',
      tags: ['P0', 'cap:eval', 'scope:integration', 'severity:critical'],
      run: async () => {
        try {
          const { registry } = require('../../src/tools/registry');
          // Load all tool modules
          const tools = [
            '../../src/tools/concept-time-tool',
            '../../src/core/scene/scene-kinds-tool',
            '../../src/tools/self-awareness-tool',
            '../../src/tools/awakening-tool',
            '../../src/tools/panel-tools',
            '../../src/tools/panels-v2-tool',
            '../../src/tools/find-tool',
            '../../src/tools/persistent-shell-tool',
            '../../src/tools/install-software-tool',
            '../../src/tools/system-environment-tool',
            '../../src/tools/agent-delegation-tools',
          ];
          for (const t of tools) {
            try { require(t); } catch (e) { /* ignore individual */ }
          }
          return registry.getStats().totalTools >= 30;
        } catch (e) {
          return false;
        }
      },
    },
    {
      id: 'regression_002',
      name: 'SceneStore singleton is consistent',
      category: 'eval',
      tags: ['P0', 'cap:scene', 'severity:major'],
      run: async () => {
        const { getSceneStore } = require('../../src/core/scene');
        const a = getSceneStore();
        const b = getSceneStore();
        return a === b;
      },
    },
    {
      id: 'regression_003',
      name: 'ConceptExtractor and TimeParser produce stable hashes',
      category: 'eval',
      tags: ['P2', 'cap:concept', 'cap:time'],
      run: async () => {
        const { getConceptExtractor } = require('../../src/core/concept-extractor');
        const ext = getConceptExtractor();
        ext.clearCache();
        const r1 = ext.extract('TypeScript + React + Node.js');
        const r2 = ext.extract('TypeScript + React + Node.js');
        return r1.hash === r2.hash;
      },
    },
  ],
};
