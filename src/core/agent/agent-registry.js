const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { WORKSPACE_DIR, DATA_DIR } = require('../config');
const { AgentComposer } = require('./agent-composer');
const { EnterpriseProfileLoader } = require('./enterprise-profile-loader');

const { normalizeToRegistry: _normalizeToolName } = require('../tool-name-map');

function _normalizeToolList(tools) {
  if (!tools) return tools;
  return tools.map(_normalizeToolName);
}

const BUILTIN_AGENTS = {
  chat: {
    id: 'chat',
    name: 'Chat Agent',
    description: 'General conversational agent for everyday interactions',
    tier: 'chat',
    model: 'fast',
    maxIterations: 5,
    allowedTools: null,
    disallowedTools: _normalizeToolList(['rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: '',
    spawnable: false,
  },
  reasoning: {
    id: 'reasoning',
    name: 'Reasoning Agent',
    description: 'Deep reasoning agent for complex analysis and planning',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 15,
    allowedTools: null,
    disallowedTools: _normalizeToolList(['rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: 'Think step by step. Show your reasoning process.',
    spawnable: true,
  },
  worker: {
    id: 'worker',
    name: 'Worker Agent',
    description: 'Task execution agent for performing specific operations',
    tier: 'worker',
    model: 'fast',
    maxIterations: 20,
    allowedTools: null,
    disallowedTools: _normalizeToolList(['rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: 'You are a sub-agent working for a parent agent. Stay tightly scoped to the delegated task. Keep your final response concise for parent synthesis.',
    spawnable: true,
  },
  researcher: {
    id: 'researcher',
    name: 'Research Agent',
    description: 'Research agent for investigation and information gathering',
    tier: 'worker',
    model: 'fast',
    maxIterations: 10,
    allowedTools: _normalizeToolList(['read', 'grep', 'glob', 'web_search', 'web_fetch']),
    disallowedTools: _normalizeToolList(['write', 'bash', 'rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: 'You are a research sub-agent. Investigate thoroughly but do NOT modify any files. Report findings with specific file paths and line numbers.',
    spawnable: true,
  },
  verifier: {
    id: 'verifier',
    name: 'Verification Agent',
    description: 'Verification agent for testing and validation',
    tier: 'worker',
    model: 'fast',
    maxIterations: 8,
    allowedTools: _normalizeToolList(['read', 'grep', 'glob', 'bash']),
    disallowedTools: _normalizeToolList(['write', 'rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: 'You are a verification sub-agent. Independently verify that changes work correctly. Do NOT assume success - prove it.',
    spawnable: true,
  },
  planner: {
    id: 'planner',
    name: 'Planner Agent',
    description: 'Planning agent for task decomposition and scheduling',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 5,
    allowedTools: _normalizeToolList(['read', 'grep', 'glob']),
    disallowedTools: _normalizeToolList(['write', 'bash', 'rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: 'You are a planning sub-agent. Decompose complex tasks into clear, actionable steps. Prioritize and identify dependencies.',
    spawnable: true,
  },
  critic: {
    id: 'critic',
    name: 'Critic Agent',
    description: 'Review agent for code review and quality assessment',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 5,
    allowedTools: _normalizeToolList(['read', 'grep', 'glob']),
    disallowedTools: _normalizeToolList(['write', 'bash', 'rm_rf', 'format', 'shutdown']),
    systemPromptSuffix: 'You are a critic sub-agent. Review work critically but constructively. Identify issues, suggest improvements, and assess quality.',
    spawnable: true,
  },
};

const AGENT_TIERS = {
  chat: { description: 'Direct user interaction', modelDefault: 'fast', maxSpawnDepth: 0 },
  reasoning: { description: 'Deep analysis and planning', modelDefault: 'reasoning', maxSpawnDepth: 1 },
  worker: { description: 'Task execution', modelDefault: 'fast', maxSpawnDepth: 2 },
};

const MAX_SPAWN_DEPTH = 3;

class AgentDefinitionRegistry extends EventEmitter {
  constructor(config = {}) {
    super();
    this._definitions = new Map();
    this._workspaceDefs = new Map();
    this._composedDefs = new Map();
    this._workspaceDir = config.workspaceDir || WORKSPACE_DIR;
    this._dataDir = config.dataDir || DATA_DIR;

    this._composer = config.composer || null;
    this._profileLoader = config.profileLoader || null;

    for (const [id, def] of Object.entries(BUILTIN_AGENTS)) {
      this._definitions.set(id, { ...def, source: 'builtin' });
    }

    this._loadWorkspaceDefinitions();
  }

  get composer() {
    if (!this._composer) {
      this._composer = new AgentComposer({ workspaceDir: this._workspaceDir });
      const profileLoader = this._profileLoader || new EnterpriseProfileLoader({ workspaceDir: this._workspaceDir });
      profileLoader.applyToDomainRegistry(this._composer.domainRegistry);
      this._syncComposedAgents();
    }
    return this._composer;
  }

  _syncComposedAgents() {
    this._composedDefs.clear();
    const composed = this.composer.composeAll();
    for (const agent of composed) {
      this._composedDefs.set(agent.id, { ...agent, source: 'composed' });
    }
    this.emit('agents:composed', { count: composed.length });
  }

  _loadWorkspaceDefinitions() {
    const defDir = path.join(this._workspaceDir, '.crabpaw', 'agents');
    if (!fs.existsSync(defDir)) return;

    try {
      const files = fs.readdirSync(defDir).filter(f => f.endsWith('.toml') || f.endsWith('.json'));
      for (const file of files) {
        try {
          const filePath = path.join(defDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          let def;

          if (file.endsWith('.json')) {
            def = JSON.parse(content);
          } else {
            def = this._parseTomlAgent(content);
          }

          if (def && def.id) {
            def.source = 'workspace';
            this._workspaceDefs.set(def.id, def);
            this.emit('agent:loaded', { id: def.id, source: 'workspace', file });
          }
        } catch (e) {
          this.emit('agent:load_error', { file, error: e.message });
        }
      }
    } catch { console.warn('[agent-registry] silent catch, error swallowed'); }
  }

  _parseTomlAgent(content) {
    const def = {};
    const lines = content.split('\n');
    let currentSection = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('[')) {
        currentSection = trimmed.slice(1, -1).trim();
        continue;
      }

      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');

      if (currentSection === 'agent') {
        if (key === 'allowed_tools') {
          def.allowedTools = value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (key === 'disallowed_tools') {
          def.disallowedTools = value.split(',').map(s => s.trim()).filter(Boolean);
        } else {
          def[key] = this._parseTomlValue(value);
        }
      }
    }

    return def.id ? def : null;
  }

  _parseTomlValue(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    return value;
  }

  get(agentId) {
    const workspaceDef = this._workspaceDefs.get(agentId);
    if (workspaceDef) return { ...workspaceDef };

    const builtinDef = this._definitions.get(agentId);
    if (builtinDef) return { ...builtinDef };

    const composedDef = this._composedDefs.get(agentId);
    if (composedDef) return { ...composedDef };

    if (this._composer) {
      const parsed = this._composer.getComposedAgent(agentId);
      if (parsed) return { ...parsed, source: 'composed' };
    }

    return null;
  }

  register(definition) {
    if (!definition || !definition.id) {
      throw new Error('Agent definition must have an id');
    }

    const existing = this._definitions.get(definition.id);
    if (existing && existing.source === 'builtin') {
      this.emit('agent:override', { id: definition.id, from: 'builtin', to: 'custom' });
    }

    this._definitions.set(definition.id, {
      ...definition,
      source: definition.source || 'custom',
    });

    this.emit('agent:registered', { id: definition.id });
  }

  unregister(agentId) {
    const def = this._definitions.get(agentId);
    if (def && def.source === 'builtin') {
      this.emit('agent:unregister_denied', { id: agentId, reason: 'Cannot unregister builtin agent' });
      return false;
    }

    this._definitions.delete(agentId);
    this._workspaceDefs.delete(agentId);
    this.emit('agent:unregistered', { id: agentId });
    return true;
  }

  list() {
    const all = new Map();

    for (const [id, def] of this._definitions) {
      all.set(id, { ...def });
    }

    for (const [id, def] of this._workspaceDefs) {
      all.set(id, { ...def });
    }

    for (const [id, def] of this._composedDefs) {
      all.set(id, { ...def });
    }

    return [...all.values()];
  }

  listSpawnable() {
    return this.list().filter(def => def.spawnable !== false);
  }

  getFilteredTools(agentId, allTools) {
    const def = this.get(agentId);
    if (!def) return allTools;

    let tools = [...allTools];

    if (def.allowedTools && def.allowedTools.length > 0) {
      const allowedSet = new Set(def.allowedTools);
      tools = tools.filter(t => allowedSet.has(t.name || t));
    }

    if (def.disallowedTools && def.disallowedTools.length > 0) {
      const disallowedSet = new Set(def.disallowedTools);
      tools = tools.filter(t => !disallowedSet.has(t.name || t));
    }

    return tools;
  }

  getSystemPromptSuffix(agentId) {
    const def = this.get(agentId);
    if (!def) return '';

    if (def.source === 'composed' && def.systemPrompt) {
      return def.systemPrompt;
    }

    return def.systemPromptSuffix || '';
  }

  resolveModel(agentId, _modelRouter) {
    const def = this.get(agentId);
    if (!def || !def.model) return null;
    return def.model;
  }

  getMaxIterations(agentId) {
    const def = this.get(agentId);
    return def?.maxIterations || 10;
  }

  checkSpawnDepth(currentDepth) {
    return currentDepth < MAX_SPAWN_DEPTH;
  }
}

class TriagePipeline extends EventEmitter {
  constructor(config = {}) {
    super();
    this._registry = config.registry || new AgentDefinitionRegistry();
    this._model = config.model || null;
    this._rules = config.rules || this._buildDefaultRules();
    this._escalationHandlers = new Map();
  }

  setModel(model) {
    this._model = model;
  }

  registerEscalationHandler(triggerType, handler) {
    this._escalationHandlers.set(triggerType, handler);
  }

  async triage(event) {
    const context = {
      source: event.source || 'unknown',
      content: event.content || '',
      metadata: event.metadata || {},
      timestamp: event.timestamp || Date.now(),
      priority: event.priority || 'normal',
    };

    const decision = this._evaluateRules(context);

    if (decision.escalate) {
      await this._handleEscalation(decision, context);
    }

    this.emit('triage:decision', {
      eventId: event.id,
      agentId: decision.agentId,
      priority: decision.priority,
      escalate: decision.escalate,
      reason: decision.reason,
    });

    return decision;
  }

  _evaluateRules(context) {
    for (const rule of this._rules) {
      if (rule.match(context)) {
        return {
          agentId: rule.agentId,
          priority: rule.priority || context.priority,
          escalate: rule.escalate || false,
          reason: rule.reason || `Matched rule: ${rule.name}`,
          model: rule.model || null,
        };
      }
    }

    return {
      agentId: 'chat',
      priority: context.priority,
      escalate: false,
      reason: 'Default routing to chat agent',
      model: null,
    };
  }

  _buildDefaultRules() {
    return [
      {
        name: 'urgent_escalation',
        match: (ctx) => ctx.priority === 'urgent' || ctx.priority === 'critical',
        agentId: 'reasoning',
        priority: 'urgent',
        escalate: true,
        reason: 'Urgent/critical priority requires reasoning agent',
      },
      {
        name: 'code_modification',
        match: (ctx) => /\b(implement|fix|refactor|create|modify|delete|update)\b.*\b(file|code|function|class|module)\b/i.test(ctx.content),
        agentId: 'worker',
        reason: 'Code modification request routed to worker agent',
      },
      {
        name: 'research_query',
        match: (ctx) => /\b(search|find|investigate|analyze|research|look up|explore)\b/i.test(ctx.content),
        agentId: 'researcher',
        reason: 'Research query routed to researcher agent',
      },
      {
        name: 'verification_request',
        match: (ctx) => /\b(verify|test|check|validate|confirm|review)\b/i.test(ctx.content),
        agentId: 'verifier',
        reason: 'Verification request routed to verifier agent',
      },
      {
        name: 'planning_request',
        match: (ctx) => /\b(plan|design|architect|decompose|organize|schedule)\b/i.test(ctx.content),
        agentId: 'planner',
        reason: 'Planning request routed to planner agent',
      },
      {
        name: 'review_request',
        match: (ctx) => /\b(review|critique|evaluate|assess|judge)\b/i.test(ctx.content),
        agentId: 'critic',
        reason: 'Review request routed to critic agent',
      },
      {
        name: 'complex_reasoning',
        match: (ctx) => ctx.content.length > 500 && /\b(because|therefore|however|although|consequently|furthermore)\b/i.test(ctx.content),
        agentId: 'reasoning',
        reason: 'Complex reasoning detected, routed to reasoning agent',
      },
    ];
  }

  async _handleEscalation(decision, context) {
    const handler = this._escalationHandlers.get(context.source);
    if (handler) {
      try {
        await handler(decision, context);
      } catch (e) {
        this.emit('escalation:error', { source: context.source, error: e.message });
      }
    }

    this.emit('escalation:triggered', {
      agentId: decision.agentId,
      priority: decision.priority,
      reason: decision.reason,
    });
  }
}

class SubAgentRoleContract {
  static buildContract(agentId, task, parentContext = {}) {
    const contract = [
      '## Sub-agent Role Contract',
      '',
      'You are a sub-agent working for a parent CrabPaw agent, not a direct end-user assistant.',
      '- Stay tightly scoped to the delegated task.',
      '- Keep tool arguments and follow-up prompts compact.',
      '- Keep your final response concise for parent synthesis.',
      '- Do NOT ask the user questions; report findings to the parent agent.',
      '- If you encounter an error, report it clearly and suggest alternatives.',
    ];

    if (task) {
      contract.push('', '## Delegated Task', '', task);
    }

    if (parentContext.constraints) {
      contract.push('', '## Constraints', '');
      for (const c of parentContext.constraints) {
        contract.push(`- ${c}`);
      }
    }

    if (parentContext.maxIterations) {
      contract.push('', `## Budget: Maximum ${parentContext.maxIterations} iterations`);
    }

    return contract.join('\n');
  }

  static extractOutcome(response) {
    if (!response) return { success: false, summary: 'No response', data: null };

    const content = typeof response === 'string' ? response : response.content || '';

    const summaryMatch = content.match(/(?:summary|result|outcome|conclusion)[:\s]+(.+?)(?:\n|$)/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : content.slice(0, 500);

    const success = !content.match(/\b(failed|error|unable|cannot|impossible)\b/i) ||
                     content.match(/\b(success|completed|done|verified|found)\b/i);

    return {
      success,
      summary,
      data: content,
    };
  }
}

let _registryInstance = null;
let _triageInstance = null;

function getAgentRegistry(config) {
  if (!_registryInstance) {
    _registryInstance = new AgentDefinitionRegistry(config);
  }
  return _registryInstance;
}

function getTriagePipeline(config) {
  if (!_triageInstance) {
    _triageInstance = new TriagePipeline(config);
  }
  return _triageInstance;
}

module.exports = {
  AgentDefinitionRegistry,
  TriagePipeline,
  SubAgentRoleContract,
  BUILTIN_AGENTS,
  AGENT_TIERS,
  MAX_SPAWN_DEPTH,
  getAgentRegistry,
  getTriagePipeline,
};
