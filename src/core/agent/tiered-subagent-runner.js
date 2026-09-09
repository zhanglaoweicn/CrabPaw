const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AgentComposer } = require('./agent-composer');
// eslint-disable-next-line no-unused-vars
const { CapabilityRegistry, CAPABILITY_TIER_MAP } = require('./capability-registry');
// eslint-disable-next-line no-unused-vars
const { DomainRegistry } = require('./domain-registry');
// eslint-disable-next-line no-unused-vars
const { ACPLiteProtocol, ACP_MESSAGE_TYPES } = require('./acp-lite-protocol');
const { SubagentSessionStore } = require('./subagent-session-store');
const { AgentEventLedger, EVENT_TYPES } = require('./agent-event-ledger');
// eslint-disable-next-line no-unused-vars
const { getAgentRegistry } = require('./agent-registry');

// Tool name normalization: centralized single source of truth
const { normalizeToRegistry } = require('../tool-name-map');

function normalizeToolName(name) {
  if (!name) return name;
  if (name === '*') return '*';
  return normalizeToRegistry(name);
}

function normalizeToolList(tools) {
  if (!tools) return tools;
  return tools.map(normalizeToolName);
}

const AGENT_TIERS = {
  CHAT: 'chat',
  REASONING: 'reasoning',
  WORKER: 'worker',
};

const TIER_SPAWN_RULES = {
  [AGENT_TIERS.CHAT]: {
    maySpawn: [AGENT_TIERS.REASONING, AGENT_TIERS.WORKER],
    mayNotSpawn: [AGENT_TIERS.CHAT],
    description: '快速UX层，负责对话编排和用户交互',
    maxDepth: 2,
  },
  [AGENT_TIERS.REASONING]: {
    maySpawn: [AGENT_TIERS.WORKER],
    mayNotSpawn: [AGENT_TIERS.REASONING, AGENT_TIERS.CHAT],
    description: '深度思考层，负责任务分解和复杂推理',
    maxDepth: 1,
  },
  [AGENT_TIERS.WORKER]: {
    maySpawn: [],
    mayNotSpawn: [AGENT_TIERS.CHAT, AGENT_TIERS.REASONING, AGENT_TIERS.WORKER],
    description: '执行层，负责具体工具调用和代码执行',
    maxDepth: 0,
  },
};

const BUILTIN_ARCHETYPES = {
  orchestrator: {
    id: 'orchestrator',
    name: '编排器',
    tier: AGENT_TIERS.CHAT,
    description: '顶层编排智能体，协调子智能体完成复杂任务',
    tools: ['spawn_subagent', 'delegate_to_researcher', 'delegate_to_executor', 'delegate_to_critic', 'todowrite', 'current_time', 'cron_add', 'cron_list', 'cron_remove'],
    disallowedTools: [],
    modelHint: 'chat',
    omitFromPrompt: [],
    maxToolIterations: 15,
  },
  planner: {
    id: 'planner',
    name: '规划器',
    tier: AGENT_TIERS.REASONING,
    description: '多步任务分解专家，将复杂请求拆解为有序子任务',
    tools: ['read', 'glob', 'grep', 'todowrite', 'plan_exit'],
    disallowedTools: ['exec', 'shell', 'write', 'edit'],
    modelHint: 'reasoning',
    omitFromPrompt: ['memory_md', 'profile'],
    maxToolIterations: 8,
  },
  researcher: {
    id: 'researcher',
    name: '研究员',
    tier: AGENT_TIERS.WORKER,
    description: '网络/文档检索专家，负责信息搜索和引用追踪',
    tools: ['web_search', 'read', 'glob', 'grep', 'recall', 'fetch_url'],
    disallowedTools: ['exec', 'shell', 'write', 'edit', 'spawn_subagent'],
    modelHint: 'fast',
    omitFromPrompt: ['memory_md', 'profile'],
    maxToolIterations: 10,
  },
  code_executor: {
    id: 'code_executor',
    name: '代码执行器',
    tier: AGENT_TIERS.WORKER,
    description: '代码编写、运行和调试专家',
    tools: ['read', 'write', 'edit', 'exec', 'shell', 'glob', 'grep', 'apply_patch'],
    disallowedTools: ['spawn_subagent', 'web_search'],
    modelHint: 'coding',
    omitFromPrompt: ['memory_md'],
    maxToolIterations: 12,
  },
  critic: {
    id: 'critic',
    name: '评审员',
    tier: AGENT_TIERS.WORKER,
    description: '代码审查和质量检查专家',
    tools: ['read', 'glob', 'grep', 'exec'],
    disallowedTools: ['write', 'edit', 'spawn_subagent'],
    modelHint: 'fast',
    omitFromPrompt: ['memory_md', 'profile'],
    maxToolIterations: 6,
  },
  summarizer: {
    id: 'summarizer',
    name: '摘要器',
    tier: AGENT_TIERS.WORKER,
    description: '压缩超大工具输出结果',
    tools: ['read'],
    disallowedTools: ['exec', 'write', 'edit', 'spawn_subagent'],
    modelHint: 'summarization',
    omitFromPrompt: ['memory_md', 'profile', 'identity'],
    maxToolIterations: 3,
  },
  archivist: {
    id: 'archivist',
    name: '归档员',
    tier: AGENT_TIERS.WORKER,
    description: '记忆蒸馏专家，决定持久化什么、遗忘什么',
    tools: ['recall', 'store', 'forget', 'read', 'glob'],
    disallowedTools: ['exec', 'spawn_subagent'],
    modelHint: 'fast',
    omitFromPrompt: ['profile'],
    maxToolIterations: 5,
  },
  tools_agent: {
    id: 'tools_agent',
    name: '工具专家',
    tier: AGENT_TIERS.WORKER,
    description: '使用内置工具完成临时任务',
    tools: ['read', 'write', 'edit', 'exec', 'shell', 'glob', 'grep', 'web_search', 'recall', 'http_request'],
    disallowedTools: ['spawn_subagent'],
    modelHint: 'agentic',
    omitFromPrompt: ['memory_md'],
    maxToolIterations: 10,
  },
};

class TierViolation extends Error {
  constructor(parentTier, childTier, reason) {
    super(`Tier violation: ${parentTier} cannot spawn ${childTier} — ${reason}`);
    this.name = 'TierViolation';
    this.parentTier = parentTier;
    this.childTier = childTier;
    this.reason = reason;
  }
}

class TierHierarchyValidator {
  validate(registry) {
    const violations = [];

    for (const [id, def] of Object.entries(registry)) {
      const tier = def.tier || AGENT_TIERS.WORKER;
      const rules = TIER_SPAWN_RULES[tier];

      if (!rules) {
        violations.push({ agentId: id, reason: `Unknown tier: ${tier}` });
        continue;
      }

      if (def.tools) {
        const spawnTools = def.tools.filter(t =>
          t.startsWith('spawn_') || t.startsWith('delegate_to_')
        );

        if (spawnTools.length > 0 && tier === AGENT_TIERS.WORKER) {
          const isSkillWildcard = def.skillFilter === '*';
          if (!isSkillWildcard && spawnTools.length > 0) {
            violations.push({
              agentId: id,
              reason: `Worker-tier agent has spawn tools: ${spawnTools.join(', ')}`,
            });
          }
        }
      }

      if (def.subagents && Array.isArray(def.subagents)) {
        for (const subId of def.subagents) {
          const subDef = registry[subId];
          if (!subDef) continue;
          const subTier = subDef.tier || AGENT_TIERS.WORKER;

          if (rules.mayNotSpawn.includes(subTier)) {
            violations.push({
              agentId: id,
              reason: `${tier} tier cannot spawn ${subTier} tier agent: ${subId}`,
              childId: subId,
            });
          }
        }
      }
    }

    return violations;
  }

  canSpawn(parentTier, childTier) {
    const rules = TIER_SPAWN_RULES[parentTier];
    if (!rules) return false;
    return rules.maySpawn.includes(childTier);
  }

  getSpawnableTiers(parentTier) {
    const rules = TIER_SPAWN_RULES[parentTier];
    return rules ? rules.maySpawn : [];
  }
}

class TieredSubAgentRunner extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._registry = { ...BUILTIN_ARCHETYPES, ...(opts.customAgents || {}) };
    this._validator = new TierHierarchyValidator();
    this._activeSpawns = new Map();
    this._maxSpawnDepth = opts.maxSpawnDepth || 3;
    this._toolExecutor = opts.toolExecutor || null;
    this._modelRouter = opts.modelRouter || null;
    this._sandboxManager = opts.sandboxManager || null;
    this._composer = opts.composer || null;
    this._acp = opts.acp || new ACPLiteProtocol();
    this._sessionStore = opts.sessionStore || new SubagentSessionStore();
    this._eventLedger = opts.eventLedger || new AgentEventLedger();

    const violations = this._validator.validate(this._registry);
    if (violations.length > 0) {
      this.emit('validation_warnings', { violations });
    }
  }

  get composer() {
    if (!this._composer) {
      this._composer = new AgentComposer();
    }
    return this._composer;
  }

  registerAgent(definition) {
    if (!definition.id) throw new Error('Agent definition must have an id');
    this._registry[definition.id] = definition;

    const violations = this._validator.validate({ [definition.id]: definition });
    if (violations.length > 0) {
      this.emit('agent_validation_warning', { agentId: definition.id, violations });
    }
  }

  async spawnSubAgent(agentId, opts = {}) {
    let definition = this._registry[agentId];

    if (!definition) {
      const composedAgent = this.composer.getComposedAgent(agentId);
      if (composedAgent) {
        definition = {
          id: composedAgent.id,
          name: composedAgent.name,
          tier: composedAgent.tier,
          description: composedAgent.description,
          tools: composedAgent.allowedTools,
          disallowedTools: composedAgent.disallowedTools,
          modelHint: composedAgent.model,
          maxToolIterations: composedAgent.maxIterations,
          systemPromptOverride: composedAgent.systemPrompt,
          source: 'composed',
          capabilityId: composedAgent.capabilityId,
          domainId: composedAgent.domainId,
        };
      }
    }

    if (!definition) throw new Error(`Unknown agent: ${agentId}`);

    const parentTier = opts.parentTier || AGENT_TIERS.CHAT;
    const childTier = definition.tier || AGENT_TIERS.WORKER;
    const currentDepth = opts.depth || 0;

    if (!this._validator.canSpawn(parentTier, childTier)) {
      throw new TierViolation(parentTier, childTier,
        `${parentTier} tier cannot spawn ${childTier} tier agents`);
    }

    if (currentDepth >= this._maxSpawnDepth) {
      throw new Error(`Maximum spawn depth (${this._maxSpawnDepth}) exceeded`);
    }

    const spawnId = `spawn_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    const spawnContext = {
      spawnId,
      agentId,
      definition,
      parentTier,
      childTier,
      depth: currentDepth + 1,
      startTime: Date.now(),
      background: opts.background || false,
      task: opts.task || '',
    };

    this._activeSpawns.set(spawnId, spawnContext);
    this.emit('spawn_started', { spawnId, agentId, tier: childTier, depth: currentDepth + 1 });

    this._eventLedger.record(EVENT_TYPES.AGENT_SPAWNED, {
      agentId,
      spawnId,
      tier: childTier,
      depth: currentDepth + 1,
      parentTier,
      task: opts.task || '',
      source: definition.source || 'builtin',
    });

    this._acp.registerAgent(spawnId, {
      agentId,
      tier: childTier,
      composedAgentId: definition.source === 'composed' ? definition.id : null,
    });

    try {
      const result = await this._runSubAgent(spawnContext, opts);
      spawnContext.endTime = Date.now();
      spawnContext.result = result;
      this.emit('spawn_completed', { spawnId, agentId, duration: Date.now() - spawnContext.startTime });
      this._eventLedger.record(EVENT_TYPES.AGENT_COMPLETED, { agentId, spawnId, duration: Date.now() - spawnContext.startTime });
      this._acp.unregisterAgent(spawnId);
      return result;
    } catch (e) {
      spawnContext.endTime = Date.now();
      spawnContext.error = e.message;
      this.emit('spawn_error', { spawnId, agentId, error: e.message });
      this._eventLedger.record(EVENT_TYPES.AGENT_FAILED, { agentId, spawnId, error: e.message });
      this._acp.unregisterAgent(spawnId);
      throw e;
    } finally {
      this._activeSpawns.delete(spawnId);
    }
  }

  async _runSubAgent(context, opts = {}) {
    const { definition, depth } = context;
    const allowedTools = this._resolveTools(definition, opts);
    const model = this._resolveModel(definition, opts);

    const subAgentConfig = {
      agentId: context.agentId,
      task: opts.task || '',
      model,
      tools: allowedTools,
      maxIterations: definition.maxToolIterations || 10,
      tier: definition.tier || AGENT_TIERS.WORKER,
      depth,
      omitFromPrompt: definition.omitFromPrompt || [],
      systemPromptOverride: definition.systemPromptOverride || null,
    };

    this.emit('subagent_configured', { spawnId: context.spawnId, config: subAgentConfig });

    try {
      const { createSubAgent, SUBAGENT_TYPES } = require('../subagent-enhanced');

      // 将 agentId 映射到 SubAgent 类型
      const archetypeToType = {
        orchestrator: SUBAGENT_TYPES.COORDINATOR,
        planner: SUBAGENT_TYPES.ANALYZE,
        researcher: SUBAGENT_TYPES.RESEARCH,
        code_executor: SUBAGENT_TYPES.IMPLEMENT,
        critic: SUBAGENT_TYPES.VERIFY,
        summarizer: SUBAGENT_TYPES.ANALYZE,
        archivist: SUBAGENT_TYPES.ANALYZE,
      };
      const subAgentType = archetypeToType[context.agentId] || SUBAGENT_TYPES.WORKER;

      const subAgent = createSubAgent({
        type: subAgentType,
        description: opts.task || '',
        prompt: definition.systemPromptOverride || definition.description || '',
        parentAgentId: opts.parentAgentId || 'root',
        toolProfile: definition.modelHint || 'coding',
        timeout: (definition.maxToolIterations || 10) * 30000,
      });

      const result = await subAgent.execute();
      return {
        agentId: context.agentId,
        tier: definition.tier,
        model,
        tools: allowedTools,
        config: subAgentConfig,
        status: 'completed',
        result,
      };
    } catch (e) {
      return {
        agentId: context.agentId,
        tier: definition.tier,
        model,
        tools: allowedTools,
        config: subAgentConfig,
        status: 'failed',
        error: e.message,
      };
    }
  }

  _resolveTools(definition, opts) {
    const parentTools = opts.parentTools || [];
    let allowed = normalizeToolList(definition.tools) || [];

    if (definition.toolScope === 'fork') {
      allowed = parentTools;
    }

    const disallowed = new Set(normalizeToolList(definition.disallowedTools) || []);
    allowed = allowed.filter(t => !disallowed.has(t));

    return allowed;
  }

  _resolveModel(definition, opts) {
    if (opts.modelOverride) return opts.modelOverride;
    if (definition.model) return definition.model;

    const hint = definition.modelHint || 'fast';
    if (this._modelRouter) {
      return this._modelRouter.resolveHint(hint);
    }

    return hint;
  }

  getActiveSpawns() {
    return Array.from(this._activeSpawns.values()).map(s => ({
      spawnId: s.spawnId,
      agentId: s.agentId,
      tier: s.childTier,
      depth: s.depth,
      duration: Date.now() - s.startTime,
      background: s.background,
    }));
  }

  getRegistry() {
    return { ...this._registry };
  }

  getSpawnGraph() {
    const graph = {};
    for (const [id, def] of Object.entries(this._registry)) {
      const tier = def.tier || AGENT_TIERS.WORKER;
      const rules = TIER_SPAWN_RULES[tier];
      graph[id] = {
        tier,
        canSpawn: rules ? rules.maySpawn : [],
        cannotSpawn: rules ? rules.mayNotSpawn : [],
      };
    }
    return graph;
  }
}

let _instance = null;

function getTieredSubAgentRunner(opts = {}) {
  if (!_instance) {
    _instance = new TieredSubAgentRunner(opts);
  }
  return _instance;
}

module.exports = {
  TieredSubAgentRunner,
  TierHierarchyValidator,
  TierViolation,
  AGENT_TIERS,
  TIER_SPAWN_RULES,
  BUILTIN_ARCHETYPES,
  getTieredSubAgentRunner,
};
