/**
 * Wiring Invariants（2026-08-15 T7 分部五）—— 反证测试套件。
 *
 * 目的：把「定义但忘接线」类的回归堵在 CI。以下断言全部基于长期有效的不变量：
 *  - 工具契约覆盖率、契约主名命名规范
 *  - 权限钩子 / 技能初始化 / 预算执法 / 恢复链的真实接线
 * 未来若有人在模块里定义了组件却忘了接线，本套件会红。
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function readRel(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

// 工具自注册副作用（与 evals/index.js 同因：registry 需由 src/tools 装配）
require('../../src/tools');

// 快照基准：断言只针对装配完成时的工具/契约全集——并行 eval 中其他套件会在
// 运行时注册技能工具/契约，污染增量检查（本套件锁的是核心契约表命名与覆盖率）。
const SNAPSHOT_REGISTRY_NAMES = [...require('../../src/tools/registry').registry.getNames()];
const SNAPSHOT_CONTRACT_KEYS = Object.keys(require('../../src/core/tool-contract').TOOL_CONTRACTS);

module.exports = {
  name: 'Wiring Invariants',
  cases: [
    {
      id: 'wiring_001',
      name: 'registry has tools and contract coverage >= 97% with no unexpected uncovered',
      category: 'wiring',
      run: () => {
        const { registry } = require('../../src/tools/registry');
        const { generateCoverageReport } = require('../../src/core/tool-contract');
        // 用装配完成时的快照（并行 eval 中其他套件运行时会注册技能工具，污染增量检查）
        const names = SNAPSHOT_REGISTRY_NAMES;
        if (registry.getNames().length === 0 || names.length === 0) return false;
        const report = generateCoverageReport(names);
        const coverage = Number(report.coverage.replace('%', ''));
        // 白名单：无契约工具仅允许已知的监控/内部工具（当前为空——契约 100% 覆盖）
        const UNCOVERED_WHITELIST = new Set([]);
        const unexpected = report.uncovered.filter((n) => !UNCOVERED_WHITELIST.has(n));
        return coverage >= 97 && unexpected.length === 0;
      },
    },
    {
      id: 'wiring_002',
      name: 'TOOL_CONTRACTS primary keys are PascalCase (snake_case only as legacy aliases)',
      category: 'wiring',
      run: () => {
        const { LEGACY_SNAKE_ALIASES, LEGACY_KEBAB_ALIASES } = require('../../src/core/tool-contract');
        const allowedAliases = new Set([
          ...Object.keys(LEGACY_SNAKE_ALIASES || {}),
          ...Object.keys(LEGACY_KEBAB_ALIASES || {}),
        ]);
        // 2026-08-30 Task 11 收口: kebab 主键已 PascalCase 化（HtmlPresentation/
        // PresentationBuilder），原 kebab 名进 LEGACY_KEBAB_ALIASES——撤掉此前
        // 「技能工具名允许 kebab」的宽泛正则豁免，非 Pascal 主键必须登记别名。
        // 用快照键集（并行 eval 中其他套件运行时注册的契约不参与主键规范断言）。
        const violations = SNAPSHOT_CONTRACT_KEYS.filter((k) =>
          !/^[A-Z]/.test(k) && !allowedAliases.has(k));
        return violations.length === 0;
      },
    },
    {
      id: 'wiring_003',
      name: 'path permission pre-hooks are wired into the tool registry',
      category: 'wiring',
      run: () => {
        // 静态接线断言：ai.js 把 globalHooks（含 createPathPermissionHooks 的
        // pathRules 钩子）注册进工具系统；harness-hooks 通过 triggerPreToolUse 执行。
        const aiSrc = readRel('src/core/ai.js');
        const hooksSrc = readRel('src/core/harness-hooks.js');
        const staticWiring =
          aiSrc.includes('registerIntoRegistry') &&
          aiSrc.includes('globalHooks') &&
          hooksSrc.includes('createPathPermissionHooks') &&
          hooksSrc.includes('canWriteWithMode') &&
          hooksSrc.includes('triggerPreToolUse');
        // 运行时断言：registry 至少挂有策略管理器 + 契约校验两个 pre-hook。
        const { registry } = require('../../src/tools/registry');
        const runtimeWiring = Array.isArray(registry._preExecuteHooks) && registry._preExecuteHooks.length >= 2;
        return staticWiring && runtimeWiring;
      },
    },
    {
      id: 'wiring_004',
      name: 'skillSystem.initialize is called in the init startup sequence',
      category: 'wiring',
      run: () => {
        // 2026-08-15 P0-2 修复：此前全仓零调用，技能系统从未初始化。
        // 静态断言 server.js 启动序列含 skillSystem.initialize() 调用。
        const serverSrc = readRel('src/cli/server.js');
        return serverSrc.includes('skillSystem.initialize()');
      },
    },
    {
      id: 'wiring_005',
      name: 'budgetEnforcer.checkRequest is enforced on both chat and chatStream paths',
      category: 'wiring',
      run: () => {
        // 2026-08-15 P1-2：此前 checkRequest 仅非流式 chat() 执法，流式路径预算绕过。
        const src = readRel('src/core/ai.js');
        const matches = [...src.matchAll(/budgetEnforcer\.checkRequest\(/g)].map((m) => m.index);
        // 非流式 chat()（≈L1268/1287）与流式 chatStream()（≈L3078）至少两处调用点
        if (matches.length < 2) return false;
        // 两个调用点必须分属相距甚远的不同函数（行号区间差异 > 500 行）
        const lines = matches.map((idx) => src.slice(0, idx).split('\n').length);
        const minLine = Math.min(...lines);
        const maxLine = Math.max(...lines);
        return maxLine - minLine > 500;
      },
    },
    {
      id: 'wiring_006',
      name: 'harness-lifecycle RecoveryChain uses the real RecoveryChainOrchestrator',
      category: 'wiring',
      run: () => {
        // 此前 require 不存在的 RecoveryChainExecutor → 永远落到 stub，恢复链从未执行。
        const lifecycleSrc = readRel('src/core/harness-lifecycle.js');
        const staticWiring =
          lifecycleSrc.includes("require('./recovery-chain')") &&
          lifecycleSrc.includes('new RecoveryChainOrchestrator()');
        // 运行时：recovery-chain 真实导出 RecoveryChainOrchestrator
        const rc = require('../../src/core/recovery-chain');
        return staticWiring && typeof rc.RecoveryChainOrchestrator === 'function';
      },
    },
    {
      id: 'wiring_007',
      name: 'eval process storage root is isolated away from the real data dir',
      category: 'wiring',
      run: () => {
        // 2026-08-31 Eval 隔离轮 Task 2：eval 进程的存储根必须落在隔离临时目录，
        // 不再指向真实 data/.crabpaw（根治 mem_008/collab 环境态与数据污染）。
        const os = require('os');
        const { getInstalledDir } = require('../isolated-data-dir');
        const config = require('../../src/core/config');
        const installed = getInstalledDir();
        // 宿主进程（regression-guard 插件）内 config 已先加载——隔离不可能生效，
        // 该场景由安装函数告警，此处不判红（红只会让插件宿主误报回归）。
        if (!installed) return true;
        const realDataDir = path.join(REPO_ROOT, 'data', '.crabpaw');
        return (
          config.DATA_DIR === installed &&
          installed.startsWith(os.tmpdir() + path.sep) &&
          !config.DATA_DIR.startsWith(realDataDir)
        );
      },
    },
    {
      id: 'wiring_008',
      name: 'whenNotToUse 注入接线: high/medium 契约的负向提示进入工具定义构建',
      category: 'wiring',
      run: () => {
        // 2026-09-03 P2: 233 条契约的 whenNotToUse 此前零消费方(模型不可见, 白写)。
        // 三重断言: 纯函数语义 / 构建主链路真实接线 / 真实契约抽查有产出。
        const { buildWhenNotToUseHint } = require('../../src/core/ai/tool-definitions');
        const h1 = buildWhenNotToUseHint({ riskLevel: 'high', whenNotToUse: ['场景A', '场景B'] });
        if (h1 !== '｜勿用: 场景A；场景B') throw new Error(`high 提示形状错误: ${h1}`);
        if (buildWhenNotToUseHint({ riskLevel: 'low', whenNotToUse: ['x'] }) !== null) throw new Error('low 风险不应注入');
        if (buildWhenNotToUseHint({ riskLevel: 'high', whenNotToUse: [] }) !== null) throw new Error('空 whenNotToUse 不应注入');
        if (buildWhenNotToUseHint({ riskLevel: 'medium', whenNotToUse: '字符串形态' }) !== '｜勿用: 字符串形态') throw new Error('字符串形态未归一');
        const long = buildWhenNotToUseHint({ riskLevel: 'high', whenNotToUse: ['x'.repeat(200)] });
        if (long.length > 5 + 141) throw new Error(`提示未 140 字封顶: ${long.length}`);
        const src = readRel('src/core/ai/tool-definitions.js');
        if (!src.includes("require('../tool-contract')")) throw new Error('tool-definitions 未引入契约源');
        if (!src.includes('buildWhenNotToUseHint(getToolContract(tool.name))')) {
          throw new Error('buildToolDefinitions 未接线 whenNotToUse 注入');
        }
        const contracts = require('../../src/core/tool-contract');
        let withHints = 0;
        for (const c of Object.values(contracts.TOOL_CONTRACTS)) {
          if (buildWhenNotToUseHint(c)) withHints++;
        }
        if (withHints < 15) throw new Error(`可注入契约仅 ${withHints} 条(<15), 契约负面清单疑似被清空`);
        return `注入接线完好: 可注入契约 ${withHints} 条`;
      },
    },
  ],
};
