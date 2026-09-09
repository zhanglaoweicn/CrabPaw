/**
 * E2E Test: EvolutionCoordinator (P2-1)
 *
 * 对准当前 API（src/core/evolution/evolution-coordinator.js）：
 * 旧版 FeedbackLoop API（sendUserFeedback/detectDegradations/configure）已被
 * 新版 Proposal/Engine 协调模型取代，测试同步迁移。
 */
const { EvolutionCoordinator, TARGET_SYSTEMS } = require('../../src/core/evolution/evolution-coordinator');

module.exports = {
  name: 'EvolutionCoordinator Tests',
  cases: [
    {
      id: 'evo_001',
      name: 'registerEngine rejects engines without evolve()',
      category: 'evolution',
      tags: ['P1', 'cap:evolution', 'severity:major'],
      run: () => {
        const coordinator = new EvolutionCoordinator();
        let threw = false;
        try {
          coordinator.registerEngine('skill', { name: 'broken' });
        } catch (e) {
          threw = /evolve/.test(e.message);
        }
        return threw;
      },
    },
    {
      id: 'evo_002',
      name: 'registerEngine + getEngine round-trip',
      category: 'evolution',
      tags: ['P1', 'cap:evolution'],
      run: () => {
        const coordinator = new EvolutionCoordinator();
        const engine = { evolve: async () => ({ improvement: 0.1 }) };
        coordinator.registerEngine('skill', engine);
        return coordinator.getEngine('skill') === engine;
      },
    },
    {
      id: 'evo_003',
      name: 'submit returns proposal with inferred targetSystem',
      category: 'evolution',
      tags: ['P1', 'cap:evolution', 'severity:major'],
      run: async () => {
        const coordinator = new EvolutionCoordinator();
        const proposal = await coordinator.submit(
          { title: 'refine memory recall', memoryPattern: 'recall-fallback' },
          { grayscaleEnabled: false }
        );
        return (
          typeof proposal.id === 'string' &&
          proposal.id.length > 0 &&
          proposal.targetSystem === TARGET_SYSTEMS.MEMORY
        );
      },
    },
    {
      id: 'evo_004',
      name: 'submit emits proposal:submitted event',
      category: 'evolution',
      tags: ['P2', 'cap:evolution'],
      run: async () => {
        const coordinator = new EvolutionCoordinator();
        let emitted = false;
        coordinator.once('proposal:submitted', () => { emitted = true; });
        await coordinator.submit(
          { title: 'agent tweak', agentBehavior: 'retry-on-429' },
          { grayscaleEnabled: false }
        );
        return emitted;
      },
    },
    {
      id: 'evo_005',
      name: 'evolve with no engines returns empty summary',
      category: 'evolution',
      tags: ['P1', 'cap:evolution'],
      run: async () => {
        const coordinator = new EvolutionCoordinator();
        const summary = await coordinator.evolve();
        return summary.totalCount === 0 && summary.successCount === 0;
      },
    },
    {
      id: 'evo_006',
      name: 'evolve records success and failure into evolution log',
      category: 'evolution',
      tags: ['P1', 'cap:evolution', 'severity:major'],
      run: async () => {
        const coordinator = new EvolutionCoordinator();
        coordinator.registerEngine('skill', { evolve: async () => ({ improvement: 0.25 }) });
        coordinator.registerEngine('memory', { evolve: async () => { throw new Error('boom'); } });
        const summary = await coordinator.evolve();
        const successLog = coordinator.getEvolutionLog({ success: true });
        const failureLog = coordinator.getEvolutionLog({ success: false });
        return (
          summary.totalCount === 2 &&
          summary.successCount === 1 &&
          successLog.length >= 1 &&
          failureLog.length >= 1
        );
      },
    },
    {
      id: 'evo_007',
      name: 'getReport lists registered engines',
      category: 'evolution',
      tags: ['P2', 'cap:evolution'],
      run: () => {
        const coordinator = new EvolutionCoordinator();
        coordinator.registerEngine('agent', { evolve: async () => ({}) });
        const report = coordinator.getReport();
        return Array.isArray(report.engines) && report.engines.includes('agent');
      },
    },
    {
      id: 'evo_008',
      name: 'cancel returns false for unknown proposal',
      category: 'evolution',
      tags: ['P2', 'cap:evolution'],
      run: () => {
        const coordinator = new EvolutionCoordinator();
        const status = coordinator.getQueueStatus();
        return status.pending === 0 && status.running === 0 && coordinator.cancel('nonexistent') === false;
      },
    },
    {
      id: 'evo_009',
      name: 'evolve with registered engine is no longer 0/0 (P0-4)',
      category: 'evolution',
      tags: ['P1', 'cap:evolution', 'severity:major'],
      run: async () => {
        // P0-4: 单例协调器 registerEngine 后，每日 triggerEvolution 走 evolve()
        // 必须产生真实结果（此前空引擎表空转，恒 0/0）。
        const { getEvolutionCoordinator } = require('../../src/core/evolution/evolution-coordinator');
        const coordinator = getEvolutionCoordinator();
        coordinator.registerEngine('skill', {
          evolve: async () => ({ improvement: 0, success: true, details: { engine: 'test' } }),
        });
        const summary = await coordinator.evolve();
        return summary.totalCount === 1 && summary.successCount === 1;
      },
    },
    {
      id: 'evo_010',
      name: 'rollback DI: _executeSkillRollback restores test skill file (P0-5)',
      category: 'evolution',
      tags: ['P1', 'cap:evolution', 'severity:major'],
      run: async () => {
        // P0-5: 注入 SkillVersionStore 后，回滚三策略必须真实恢复技能文件。
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const { SkillVersionStore } = require('../../src/core/evolution/skill-version-store');
        const { RollbackManager } = require('../../src/core/evolution/rollback-manager');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-rollback-'));
        try {
          const skillDir = path.join(tmp, 'test-skill');
          fs.mkdirSync(skillDir, { recursive: true });
          const md = path.join(skillDir, 'SKILL.md');
          fs.writeFileSync(md, 'v1 content', 'utf-8');
          const store = new SkillVersionStore({
            versionsDir: path.join(tmp, 'versions'),
            skillsDirs: [tmp],
          });
          const v1 = await store.saveVersion('test-skill', 'v1 content', 'init', {});
          const v2 = await store.saveVersion('test-skill', 'v2 content', 'fix', {});
          fs.writeFileSync(md, 'v2 content', 'utf-8');

          const rm = new RollbackManager({ versionStore: store });
          rm.initialize();
          const ok = await rm._executeSkillRollback('test-skill', {
            newVersion: v2.hash,
            parentVersion: v1.hash,
          });
          const restored = fs.readFileSync(md, 'utf-8');
          return ok === true && restored === 'v1 content';
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'evo_011',
      name: 'collectFeedback routes to real FeedbackLoopEngine (P1-5)',
      category: 'evolution',
      tags: ['P1', 'cap:evolution'],
      run: async () => {
        // P1-5: collectFeedback 此前调 coordinator.sendSystemFeedback/sendUserFeedback
        // （不存在）恒返回 feedbackId:null。现在落到 FeedbackLoopEngine 持久化。
        const { collectFeedback } = require('../../src/core/evolution-system');
        const { getFeedbackLoopEngine } = require('../../src/core/skill/feedback-loop-engine');
        const marker = `evo_fb_${Date.now()}`;
        const result = await collectFeedback({ type: 'user', skillName: marker, message: 'test correction', success: false });
        // 并行 eval 下其他套件可能写入大量条目——用引擎全量 entries 断言（非 200 条切片）
        const engine = getFeedbackLoopEngine();
        const entries = engine.feedbackEntries;
        const ok = !!result.feedbackId && Array.isArray(entries) && entries.some(e => e.skillName === marker);
        // 自清理本条目标记（避免与 evo_013 历史残留清理在并行执行下互相竞争）
        engine.feedbackEntries = entries.filter((e) => e.skillName !== marker);
        engine._save();
        return ok;
      },
    },
    {
      id: 'evo_013',
      name: 'feedback.json 测试残留清理：移除 eval 遗留的历史测试条目 (T7 累积M)',
      category: 'evolution',
      tags: ['P3', 'cap:evolution'],
      run: async () => {
        // 只清理 5 分钟前的历史残留——并行执行下 evo_011 正在写入的活条目不受影响
        // （evo_011 自清理自己的标记）。保证仓库数据文件不被 eval 长期污染。
        const { getFeedbackLoopEngine } = require('../../src/core/skill/feedback-loop-engine');
        const engine = getFeedbackLoopEngine();
        const cutoff = Date.now() - 5 * 60 * 1000;
        const before = engine.feedbackEntries.length;
        engine.feedbackEntries = engine.feedbackEntries.filter(
          (e) => !(String(e.skillName || '').startsWith('evo_fb_') && (e.timestamp || 0) < cutoff));
        if (engine.feedbackEntries.length !== before) engine._save();
        const stale = engine.feedbackEntries.filter(
          (e) => String(e.skillName || '').startsWith('evo_fb_') && (e.timestamp || 0) < cutoff);
        return stale.length === 0;
      },
    },
    {
      id: 'evo_012',
      name: '技能进化桥接优先委托已初始化 SkillEvolver 单例（门禁） (T7 累积K)',
      category: 'evolution',
      tags: ['P2', 'cap:evolution'],
      run: async () => {
        // T7 累积K: _bridgeSkillEvolution 此前绕过单例直调 skill_manage handler，
        // 全部门禁失效。锁定：桥接源码含门禁分支 + 单例 isInitialized 语义可用。
        const fs = require('fs');
        const path = require('path');
        const { getSkillEvolver } = require('../../src/core/skill/skill-evolver');
        const evolver = getSkillEvolver();
        if (typeof evolver.isInitialized !== 'function') return false;
        evolver.initialize({ coordinator: null, validator: null, rollbackManager: null, versionStore: null });
        if (!evolver.isInitialized()) return false;
        const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'evolution', 'index.js'), 'utf-8');
        return bridgeSrc.includes('gatedEvolver.isInitialized()')
          && bridgeSrc.includes('getSkillEvolver')
          && bridgeSrc.includes('skillManageTool'); // fallback 仍在
      },
    },
  ],
};
