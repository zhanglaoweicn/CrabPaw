/**
 * Agent Router — 多智能体路由模块（从 ai.js 提取的单一事实源）
 *
 * 设计说明：
 * - 本模块是 _evaluateAgentRoute / _executeMultiAgentTask 等函数的唯一实现，
 *   ai.js 通过 require 引用，消除历史 inline 重复。
 * - subAgentCallback 不再以模块级状态持有，而是通过依赖注入传入
 *   _executeMultiAgentTask(config, userId, message, route, cb)，
 *   避免 ai.js 与本模块两份 callback 状态分歧。
 *
 * 包含:
 * - _evaluateAgentRoute() — 评估消息是否需要多智能体路由
 * - _executeMultiAgentTask() — 执行多智能体协作任务（DI subAgentCallback）
 * - buildMultiPhasePrompt() — 构建多阶段提示词
 * - _needsResearch() — 判断是否需要研究
 * - _needsReview() — 判断是否需要审查
 */

const { getTieredSubAgentRunner, AGENT_TIERS } = require('../agent/tiered-subagent-runner');

/**
 * 评估消息，决定是否使用多智能体路由
 * @param {string} message
 * @returns {{ useMultiAgent: boolean, archetype: string|null, reason: string, complexity: string }}
 */
function _evaluateAgentRoute(message) {
  const result = {
    useMultiAgent: false,
    archetype: null,
    reason: '',
    complexity: 'simple',
  };

  if (!message || typeof message !== 'string') return result;

  const msg = message.toLowerCase();

  // 复杂编排型：多步骤、需要协调多个子任务
  const orchestratorPatterns = [
    /帮我(完成|做|处理|实现).*(系统|项目|功能|模块)/,
    /设计.*架构/,
    /重构.*代码/,
    /从零开始/,
    /完整实现/,
    /多步骤/,
    /先.*再.*然后/,
    /第一步.*第二步/,
    /整理.*资料|整理.*信息/,
    /分析.*并.*(输出|生成|整理|给出|提出)/,
  ];

  // 研究型：搜索、分析、调研
  const researcherPatterns = [
    /搜索|查找|调研/,
    /分析.*(市场|竞品|趋势|现状|行业|发展)/,
    /找(一下|找).*(资料|文档|论文|方案|信息)/,
    /研究|调查|对比.*方案/,
    /最新.*技术|趋势/,
    /(现状|趋势|发展).*(分析|研究|报告|情况)/,
    /了解.*(一下|下).*(情况|现状|趋势|动态|信息)/,
  ];

  // 代码执行型：编程、编码、脚本、调试等
  const codeExecutorPatterns = [
    /写(个|一)[.\s]*(代码|程序|脚本|函数|方法|组件|指令|算法)/,
    /实现.*功能|功能.*实现/,
    /(代码|程序|脚本).*(调试|运行|执行|测试|部署|修复|优化|重构)/,
    /调试.*(代码|程序|脚本|问题|bug|错误)/,
    /重构.*代码|代码.*重构|优化.*代码|代码.*优化/,
    /写.*(测试|单元测试|用例)/,
    /创建.*(组件|页面|应用|服务|接口|API|路由)/,
    /部署|发布|上线/,
    /(git|github|gitlab).*(提交|推送|合并|pr|pull|push|commit|clone)/,
  ];

  // 文档/内容创作型：写文章、报告、演讲稿等
  const writerPatterns = [
    /写(一个|一份|一篇|个|份|篇).*(报告|文章|演讲稿|方案|计划|总结|分析|文档|论文)/,
    /生成.*(报告|文章|文档|方案|计划|演讲稿|内容)/,
    /编写.*(文档|指南|手册|说明|教程)/,
    /起草.*(方案|计划|合同|协议|信函|邮件)/,
    /制作.*(PPT|幻灯片|演示文稿)/,
    /整理.*(笔记|纪要|总结|记录)/,
  ];

  // 审查型：代码审查、质量检查
  const criticPatterns = [
    /审查|review|检查.*代码|代码质量/,
    /安全.*扫描|漏洞.*检测/,
    /优化.*性能|性能.*分析/,
    /测试.*覆盖/,
  ];

  // 评分：匹配越多模式，复杂度越高
  let score = 0;

  for (const p of orchestratorPatterns) {
    if (p.test(msg)) { score += 3; result.archetype = 'orchestrator'; break; }
  }
  for (const p of researcherPatterns) {
    if (p.test(msg)) { score += 2; result.archetype = result.archetype || 'researcher'; break; }
  }
  for (const p of codeExecutorPatterns) {
    if (p.test(msg)) { score += 2; result.archetype = result.archetype || 'code_executor'; break; }
  }
  for (const p of criticPatterns) {
    if (p.test(msg)) { score += 2; result.archetype = result.archetype || 'critic'; break; }
  }
  for (const p of writerPatterns) {
    if (p.test(msg)) { score += 1; result.archetype = result.archetype || 'writer'; break; }
  }

  // 消息长度也是复杂度指标
  if (msg.length > 200) score += 1;
  if (msg.length > 500) score += 1;

  // 包含多个子任务指示
  const subtaskCount = (msg.match(/并且|同时|还要|另外|以及/g) || []).length;
  score += subtaskCount;
  if (/先.*(再|然后)/.test(msg)) score += 1;

  // ── 路由决策 ──
  // 只有 orchestrator 型复杂工程任务才触发多智能体管线
  if (score >= 5 && result.archetype === 'orchestrator') {
    result.useMultiAgent = true;
    result.complexity = 'complex';
    result.reason = `复杂度评分=${score}, 多智能体编排`;
  } else {
    result.useMultiAgent = false;
    result.complexity = score >= 5 ? 'complex' : 'moderate';
    result.reason = `复杂度评分=${score}, 原生 SSE (${result.archetype || 'chat'})`;
  }

  return result;
}

/**
 * 执行多智能体协作任务
 *
 * @param {Object} config
 * @param {string} userId
 * @param {string} message
 * @param {Object} route - _evaluateAgentRoute 的返回值
 * @param {Function|null} [cb=null] - 子智能体状态回调（依赖注入），签名 (userId, status, payload)
 * @returns {Promise<string|null>}
 */
async function _executeMultiAgentTask(config, userId, message, route, cb = null) {
  const runner = getTieredSubAgentRunner({
    modelRouter: {
      resolveHint: (hint) => {
        const provider = config.models?.currentProvider || 'default';
        const p = config.models?.providers?.[provider];
        return p?.model || hint;
      },
    },
  });

  // 根据复杂度选择策略
  if (route.complexity === 'complex' && route.archetype === 'orchestrator') {
    // 复杂任务：先规划，再分步执行
    console.log('🤖 [多智能体] 复杂任务模式：规划 → 研究 → 执行 → 审查');

    // Step 1: 规划
    if (cb) cb(userId, "start", { agentId: "planner", archetype: "planner", tier: "reasoning", task: message.substring(0, 100) });
    const planResult = await runner.spawnSubAgent('planner', {
      task: message,
      parentTier: AGENT_TIERS.CHAT,
      depth: 0,
    });

    if (planResult.status !== 'completed' || !planResult.result) {
      console.warn('⚠️ [多智能体] 规划失败，降级到单智能体');
      if (cb) cb(userId, "end", { agentId: "planner", archetype: "planner", status: planResult.status });
      return null;
    }

    if (cb) cb(userId, "end", { agentId: "planner", archetype: "planner", status: "completed" });
    // Step 2: 研究（如果需要）
    let researchContext = '';
    if (_needsResearch(message)) {
      if (cb) cb(userId, "start", { agentId: "researcher", archetype: "researcher", tier: "worker", task: message.substring(0, 100) });
      const researchResult = await runner.spawnSubAgent('researcher', {
        task: `为以下任务收集相关信息：${message}\n\n规划结果：${JSON.stringify(planResult.result)}`,
        parentTier: AGENT_TIERS.REASONING,
        depth: 1,
      });
      if (researchResult.status === 'completed') {
        researchContext = typeof researchResult.result === 'string'
          ? researchResult.result
          : JSON.stringify(researchResult.result);
      }
      if (cb) cb(userId, "end", { agentId: "researcher", archetype: "researcher", status: researchResult.status });
    }

    // Step 3: 执行
    if (cb) cb(userId, "start", { agentId: "code_executor", archetype: "code_executor", tier: "worker", task: message.substring(0, 100) });
    const execResult = await runner.spawnSubAgent('code_executor', {
      task: `执行以下任务：${message}\n\n规划：${JSON.stringify(planResult.result)}${researchContext ? '\n\n研究资料：' + researchContext : ''}`,
      parentTier: AGENT_TIERS.REASONING,
      depth: 1,
    });

    if (execResult.status !== 'completed') {
      return `任务执行遇到问题：${execResult.error || '未知错误'}。规划建议：${JSON.stringify(planResult.result)}`;
    }

    if (cb) cb(userId, "end", { agentId: "code_executor", archetype: "code_executor", status: execResult.status });
    // Step 4: 审查（可选）
    if (_needsReview(message)) {
      if (cb) cb(userId, "start", { agentId: "critic", archetype: "critic", tier: "worker", task: "审查执行结果质量" });
      const reviewResult = await runner.spawnSubAgent('critic', {
        task: `审查以下执行结果的质量：\n任务：${message}\n执行结果：${JSON.stringify(execResult.result)}`,
        parentTier: AGENT_TIERS.REASONING,
        depth: 1,
      });
      if (reviewResult.status === 'completed') {
        const execOutput = typeof execResult.result === 'string' ? execResult.result : JSON.stringify(execResult.result);
        const reviewOutput = typeof reviewResult.result === 'string' ? reviewResult.result : JSON.stringify(reviewResult.result);
        return `${execOutput}\n\n---\n📋 **审查意见**：${reviewOutput}`;
      }
    }

    if (cb) cb(userId, "end", { agentId: "critic", archetype: "critic", status: "unknown" });
    return typeof execResult.result === 'string' ? execResult.result : JSON.stringify(execResult.result);
  }

  // 中等复杂度：直接路由到对应 worker
  if (cb) cb(userId, "start", { agentId: route.archetype, archetype: route.archetype, tier: "worker", task: message.substring(0, 100) });
  const agentResult = await runner.spawnSubAgent(route.archetype, {
    task: message,
    parentTier: AGENT_TIERS.CHAT,
    depth: 0,
  });

  if (agentResult.status === 'completed') {
    if (cb) cb(userId, "end", { agentId: route.archetype, archetype: route.archetype, status: agentResult.status });
    return typeof agentResult.result === 'string' ? agentResult.result : JSON.stringify(agentResult.result);
  }

  return null;
}

/**
 * 构建多阶段提示词
 * @param {string} message
 * @param {Object} route
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
function buildMultiPhasePrompt(_message, route) {
  const phaseInstructions = `[系统执行计划]
你正在处理一个需要多步骤协作的复杂任务。请按以下阶段依次推进。
每个阶段完成后，用 <phase:阶段名> 标记阶段结束，然后开始下一阶段。
务必按顺序推进：plan → research → execute → review → deliver。

<phase:plan>
分析用户需求，将任务拆分为清晰的子步骤。输出规划思路。

<phase:research>
根据规划搜索/获取必要信息。使用 WebSearch 等工具。

<phase:execute>
基于规划和研究结果执行：创建文件、编写代码、生成文档等。
优先使用 Write 工具输出到文件。

<phase:review>
审查执行结果的质量和完整性。如果发现问题，返回 execute 阶段修正。

<phase:deliver>
最终向用户清晰呈现完成的结果。
`;
  return phaseInstructions;
}

/**
 * 判断是否需要进行研究
 * @param {string} message
 * @returns {boolean}
 */
function _needsResearch(message) {
  const patterns = [/搜索|查找|调研|分析|研究|最新|趋势|对比|方案/];
  return patterns.some(p => p.test(message.toLowerCase()));
}

/**
 * 判断是否需要进行审查
 * @param {string} message
 * @returns {boolean}
 */
function _needsReview(message) {
  const patterns = [/审查|review|检查|优化|安全|质量|测试/];
  return patterns.some(p => p.test(message.toLowerCase()));
}

module.exports = {
  _evaluateAgentRoute,
  _executeMultiAgentTask,
  buildMultiPhasePrompt,
  _needsResearch,
  _needsReview,
};
