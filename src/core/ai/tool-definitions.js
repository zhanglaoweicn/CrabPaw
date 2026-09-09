/**
 * ai/tool-definitions.js
 *
 * 从 ai.js 提取的工具定义与执行辅助模块。
 * 职责：
 *   1. buildToolDefinitions — 按渠道/意图/熔断器/可用性过滤工具，生成 LLM 可见的工具列表
 *   2. collectEnvironmentIssues — 从熔断器收集环境健康问题
 *   3. executeToolCallsConcurrent — 按模型能力决定并行/串行执行工具调用
 */

const { getToolsetManager } = require('../toolset-manager');
const { registry: toolSystem } = require('../../tools');
const { filterToolsByChannel } = require('./intents');
const { selectToolsForContext: _selectToolsByIntent } = require('./tool-router');
const { getCircuitBreakerRegistry } = require('../tool-circuit-breaker');
const { sanitizeToolDefinitions } = require('../schema-sanitizer');
const { supportsParallelToolCalls } = require('../model-tool-guidance');
const { groupToolCallsForConcurrency: _groupToolCallsForConcurrency } = require('../ai-utils');
const { getToolContract } = require('../tool-contract');

/**
 * 构建工具的"何时不该用"提示（2026-09-03 P2 注入, 五层映射待办落地）。
 *
 * 背景: 233 条契约的 whenNotToUse 此前只有定义方没有消费方——模型看不见, 白写。
 * 策略(数据驱动): 只注入 riskLevel high/medium 且非空者(实测 22 条×平均 47 字 ≈ 1.1K
 * 字符, 相对 ~53K 描述预算可忽略); low 风险不注入, 控上下文成本。取前 2 条、140 字封顶。
 *
 * @param {{riskLevel?: string, whenNotToUse?: string[]|string}} contract 工具契约
 * @returns {string|null} 形如 "｜勿用: …" 的提示; 不满足注入条件返回 null
 */
function buildWhenNotToUseHint(contract) {
  if (!contract || (contract.riskLevel !== 'high' && contract.riskLevel !== 'medium')) return null;
  const w = contract.whenNotToUse;
  const items = Array.isArray(w) ? w.filter(Boolean).map(String) : (w ? [String(w)] : []);
  if (items.length === 0) return null;
  const joined = items.slice(0, 2).join('；');
  const hint = joined.length > 140 ? `${joined.slice(0, 140)}…` : joined;
  return `｜勿用: ${hint}`;
}

/**
 * 构建工具定义列表（三级可用性过滤 + 按需工具注入 + 专家工具面收窄）
 * @param {string} channel - 当前对话通道
 * @param {string} userMessage - 用户消息（用于意图路由）
 * @param {{expertToolsets?: string[]|null}} [options] - 2026-09-04 P3: 激活专家的
 *   allowedToolsets(expert-context.getActiveExpertToolsets)——非空时在既有过滤之上
 *   收窄到专家工具面(+general/web 基线), 带 20% 地板守卫防空收窄; null/缺省不收窄。
 * @returns {Array} LLM 可用的工具定义数组
 */
function buildToolDefinitions(channel, userMessage, options = {}) {
  // 优先使用工具集管理器过滤
  const tsm = getToolsetManager();
  let activeToolsets = tsm.getActiveToolsets();
  // 2026-08-25 排查: 「选中 3/3」疑团——若 MCP「注册即激活」抢先占用活跃集,
  // setPlatform 条件(空集)永远不触发 → 平台工具集缺失 → LLM 视野被 MCP 集窄化
  if (process.env.CRABPAW_TOOL_DIAG) {
    console.log(`[ai-diag] buildToolDefinitions channel=${channel} activeToolsets=[${activeToolsets.join(',')}] names=${tsm.getActiveToolNames().length}`);
  }

  // 无活跃工具集时，根据渠道自动激活平台工具集
  // 2026-08-25 实锤: MCP「注册即激活」抢先激活 mcp-* 动态集后, 平台集永远不被激活
  // (→ LLM 只见 3 个 MCP 工具, 晚间工具类问题共因)。判据: 活跃集仅含 mcp-* 时也执行。
  const onlyMcp = activeToolsets.length > 0 && activeToolsets.every(t => String(t).startsWith('mcp-'));
  if ((activeToolsets.length === 0 || onlyMcp) && channel) {
    const platformMap = { wecom: 'wecom', lark: 'lark', cli: 'cli', 'api-server': 'api-server' };
    const platform = platformMap[channel] || 'cli';
    tsm.setPlatform(platform);
    // 激活该平台的所有工具集
    const platformTsNames = tsm.getPlatformToolsetNames();
    // 2026-08-18 P0-2 修复：此前逐条静默 console.warn 吞掉激活失败——PLATFORM_TOOLSETS
    // 混用键名导致 system/voice/reminder/lark/wecom 全部激活失败且无聚合线索。
    // 现改为一次性聚合告警；平台列表已只引用 CORE_TOOLSETS 键，此处应恒为 0，
    // 若再出现即说明平台列表引入了无效键。
    const failedToolsets = [];
    for (const tsName of platformTsNames) {
      try { tsm.activateToolset(tsName); } catch (_) { failedToolsets.push(tsName); }
    }
    if (failedToolsets.length > 0) {
      console.warn(`[ai] 工具集激活失败 ${failedToolsets.length} 个: ${failedToolsets.join(', ')}（检查 PLATFORM_TOOLSETS 是否引用了 CORE_TOOLSETS 不存在的键）`);
    }
    activeToolsets = tsm.getActiveToolsets();
  }

  let tools;
  if (activeToolsets.length > 0) {
    // 有活跃工具集时，只返回活跃工具集内的工具
    const activeNames = new Set(tsm.getActiveToolNames());
    tools = toolSystem.getAll().filter(t => activeNames.has(t.name));
  } else {
    tools = toolSystem.getAll();
  }

  tools = filterToolsByChannel(tools, channel);

  // ── 按需工具注入（9.2）：按用户消息意图 + 上下文选择工具集 ──
  if (userMessage && _selectToolsByIntent) {
    try {
      const recentToolLog = (typeof tsm.getRecentToolNames === 'function' ? tsm.getRecentToolNames(5) : null) || [];
      const routed = _selectToolsByIntent({
        message: userMessage,
        channel,
        toolSystem,
        recentTools: recentToolLog,
      });
      if (routed && routed.tools && routed.tools.length > 0) {
        // 取并集：活跃 toolset ∩ 按意图路由
        // 这样保留渠道/平台限制，同时按意图收紧
        const routedNames = new Set(routed.tools.map(t => t.name));
        const originalCount = tools.length;
        tools = tools.filter(t => routedNames.has(t.name));
        if (tools.length === 0) {
          // 兜底：routing 给出 0 个（极端情况）则保留原集
          const fallbackNames = new Set(tsm.getActiveToolNames());
          tools = toolSystem.getAll().filter(t => fallbackNames.has(t.name));
          if (tools.length === 0) tools = toolSystem.getAll();
        }
        console.log(`🎯 [按需工具注入] intent=${routed.intent}(${routed.confidence.toFixed(2)}), 选中 ${tools.length}/${originalCount} 个工具 | routed=[${[...routedNames].join(',')}]`);
      }
    } catch (e) {
      // 路由失败时保留原 tools 集
      console.warn('[ai] tool-router select failed, keeping original tools:', e.message);
    }
  }

  // ── 三级可用性过滤：从 LLM 视野中自动隐藏不可用的工具 ──

  // Level 1: 熔断器过滤（API 连续失败=暂时不可用）
  try {
    const breakerRegistry = getCircuitBreakerRegistry();
    const openBreakers = new Set();
    for (const [toolName, breaker] of breakerRegistry.getAllBreakers()) {
      // 2026-08-18 实机修复: isOpen 是方法, 此前未加括号当 truthy 判断 →
      // 所有注册过的 breaker 全部误判为 open → 台风/文件等工具被错杀。
      if (breaker.isOpen()) openBreakers.add(toolName);
    }
    if (openBreakers.size > 0) {
      const before = tools.length;
      tools = tools.filter(t => !openBreakers.has(t.name));
      if (tools.length < before) {
        console.log(`⚡ [工具过滤] 移除 ${before - tools.length} 个熔断工具: ${[...openBreakers].join(', ')}`);
      }
    }
  } catch (e) { console.warn('[ai] Circuit breaker check failed:', e.message); }

  // Level 2: checkFn 可用性过滤（仅对无参数依赖的 checkFn 生效）
  // 参数校验型 checkFn 需要输入参数，不可用性 checkFn 无需参数
  // 通过检查 checkFn.length（函数形参个数）区分：0 个形参 = 可用性检查
  const checkFnBlocked = [];
  tools = tools.filter(t => {
    if (typeof t.checkFn === 'function' && t.checkFn.length === 0) {
      try {
        const result = t.checkFn();
        if (!result) {
          checkFnBlocked.push(t.name);
          return false;
        }
      } catch {
        checkFnBlocked.push(t.name);
        return false;
      }
    }
    return true;
  });
  if (checkFnBlocked.length > 0) {
    console.log(`🔇 [工具过滤] checkFn 隐藏 ${checkFnBlocked.length} 个工具: ${checkFnBlocked.join(', ')}`);
  }

  // Level 3: 僵尸工具过滤（无 handler=不能执行）
  const zombieNames = [];
  tools = tools.filter(t => {
    if (t.handler && typeof t.handler === 'function') return true;
    zombieNames.push(t.name);
    return false;
  });
  if (zombieNames.length > 0) {
    console.log(`🧟 [工具过滤] 移除 ${zombieNames.length} 个僵尸工具: ${zombieNames.join(', ')}`);
  }

  // Level 4(2026-09-04 P3): 专家工具面收窄——岗位=人设+工具面三元组的 enforcement。
  // 岗位 allowedToolsets 解析为工具名全集 + general/web 基线(老板永远保留搜索)；
  // 2026-09-06: 基线补 'data'——业务库查询(DatabaseQuery/ListTables)是所有岗位
  // 回答经营问题的公共能力，此前专家工具面收窄把 data 集裁掉，财务类专家
  // 看不见 DatabaseQuery → 只能翻文件（实机：财务顾问答应收问题全走 DocRead）。
  // 20% 地板守卫：收窄后过少视为误配置/极端意图，放弃收窄保语境连续性。
  const expertToolsets = options.expertToolsets;
  if (Array.isArray(expertToolsets) && expertToolsets.length > 0 && tools.length > 0) {
    try {
      const allowedNames = new Set();
      for (const tsName of [...expertToolsets, 'general', 'web', 'data']) {
        for (const n of tsm.resolveToolNames(tsName)) allowedNames.add(n);
      }
      if (allowedNames.size > 0) {
        const narrowed = tools.filter(t => allowedNames.has(t.name));
        const floor = Math.min(8, Math.ceil(tools.length * 0.2));
        if (narrowed.length >= floor && narrowed.length < tools.length) {
          console.log(`🎯 [工具过滤] 专家工具面收窄: ${tools.length} → ${narrowed.length}`);
          tools = narrowed;
        }
      }
    } catch (e) { console.warn('[ai] 专家工具面收窄失败(不收窄):', e.message); }
  }

  const raw = tools
    .filter(tool => tool.schema)
    .map(tool => {
      // P0-3(2026-08-25) 重复描述去重：function.description 与 parameters 内顶层
      // description 是完全相同文本时（描述/契约双写），保留一份——每轮 ~53K 字符
      // 上行中省掉重复段；嵌套 properties 内的 description 保留不动（有语义）。
      const schemaCopy = tool.schema?.parameters || tool.schema || {};
      const params = { ...schemaCopy };
      let description = tool.description || schemaCopy.description || '';
      if (params.description && params.description === description) {
        delete params.description;
      }
      // P1-5(2026-08-25) 超长描述截断（>300 字符保头部）：描述平均 492 字符/工具，
      // 长尾截断后工具定义明显瘦身（配合 provider 前缀缓存）；首句语义保留。
      if (description.length > 300) {
        description = description.slice(0, 300) + '…';
      }
      // whenNotToUse 注入(2026-09-03): 契约"何时不该用"进模型视野——贴着工具定义放置
      // (注意力邻近性优于系统提示集中清单); includes 守卫保证幂等。
      const negativeHint = buildWhenNotToUseHint(getToolContract(tool.name));
      if (negativeHint && !description.includes('勿用:')) {
        description += negativeHint;
      }
      return {
        type: 'function',
        function: {
          name: tool.name,
          description,
          parameters: params
        }
      };
    });

  // 2026-08-25 缓存优化: 工具定义按 name 稳定排序——跨请求顺序恒一、
  // 意图子集切换时公共工具相对顺序不变, 最大化 provider 前缀缓存命中
  // (DeepSeek 自动 context cache, 前缀逐字节匹配)。
  raw.sort((a, b) => String(a?.function?.name || '').localeCompare(String(b?.function?.name || '')));
  return sanitizeToolDefinitions(raw);
}

/**
 * 收集当前环境健康问题（从 CircuitBreaker 获取熔断中的工具）
 * @returns {Array} 环境问题列表
 */
function collectEnvironmentIssues() {
  const issues = [];
  try {
    const breakerRegistry = getCircuitBreakerRegistry();
    for (const [toolName, breaker] of breakerRegistry.getAllBreakers()) {
      if (breaker.isOpen()) {
        const retryAfter = breaker._openedAt && breaker._options?.resetDuration
          ? new Date(breaker._openedAt + breaker._options.resetDuration).toLocaleTimeString('zh-CN')
          : '稍后';
        issues.push({ tool: toolName, reason: '连续失败，熔断器已开启', retryAfter });
      }
    }
  } catch (e) { /* 静默降级: 熔断器检查非关键路径 */ console.debug('[ai] 熔断器状态检查失败:', e.message); }
  return issues;
}

/**
 * 并发执行工具调用（按模型能力决定并行/串行）
 * @param {Array} toolCalls - 工具调用列表
 * @param {Function} executor - 单个工具执行器 (toolCall) => result
 * @param {string} modelName - 模型名称
 * @param {string} providerName - 提供商名称
 * @returns {Array} 执行结果列表
 */
async function executeToolCallsConcurrent(toolCalls, executor, modelName, providerName) {
  if (!toolCalls || toolCalls.length === 0) return [];

  // 弱模型强制串行执行，防止工具调用混乱
  const canParallel = supportsParallelToolCalls(modelName, providerName);
  if (!canParallel && toolCalls.length > 1) {
    console.log(`⚠️ 模型 ${modelName} 不支持并行工具调用，强制串行执行`);
    const results = [];
    for (const tc of toolCalls) {
      try {
        const result = await executor(tc);
        results.push(result);
      } catch (e) {
        results.push({ toolCall: tc, result: { success: false, error: e.message }, success: false });
      }
    }
    return results;
  }

  if (toolCalls.length === 1) {
    const result = await executor(toolCalls[0]);
    return [result];
  }

  const { parallel, sequential } = _groupToolCallsForConcurrency(toolCalls);
  const results = [];

  if (parallel.length > 0) {
    const settled = await Promise.allSettled(parallel.map(tc => executor(tc)));
    for (const s of settled) {
      if (s.status === 'fulfilled') results.push(s.value);
      else results.push({ toolCall: null, result: { success: false, error: s.reason?.message || 'Unknown error' }, success: false });
    }
  }

  for (const tc of sequential) {
    try {
      const result = await executor(tc);
      results.push(result);
    } catch (e) {
      results.push({ toolCall: tc, result: { success: false, error: e.message }, success: false });
    }
  }

  return results;
}

module.exports = {
  buildToolDefinitions,
  buildWhenNotToUseHint,
  collectEnvironmentIssues,
  executeToolCallsConcurrent,
};
