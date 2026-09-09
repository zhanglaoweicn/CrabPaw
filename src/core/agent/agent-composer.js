const { EventEmitter } = require('events');
const { CapabilityRegistry, CAPABILITY_TIER_MAP } = require('./capability-registry');
const { DomainRegistry } = require('./domain-registry');

const AGENT_TIERS = {
  CHAT: 'chat',
  REASONING: 'reasoning',
  WORKER: 'worker',
};

class AgentComposer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._capabilityRegistry = config.capabilityRegistry || new CapabilityRegistry(config);
    this._domainRegistry = config.domainRegistry || new DomainRegistry(config);
    this._composedCache = new Map();
  }

  get capabilityRegistry() {
    return this._capabilityRegistry;
  }

  get domainRegistry() {
    return this._domainRegistry;
  }

  compose(capabilityId, domainId) {
    const cacheKey = `${domainId}_${capabilityId}`;
    if (this._composedCache.has(cacheKey)) {
      return { ...this._composedCache.get(cacheKey) };
    }

    const cap = this._capabilityRegistry.get(capabilityId);
    if (!cap) {
      this.emit('compose:error', { capabilityId, domainId, reason: 'Capability not found' });
      return null;
    }

    const domain = this._domainRegistry.get(domainId);
    if (!domain) {
      this.emit('compose:error', { capabilityId, domainId, reason: 'Domain not found' });
      return null;
    }

    const tier = CAPABILITY_TIER_MAP[capabilityId] || cap.tier || 'worker';
    const agentId = `${domainId}_${capabilityId}`;

    const composed = {
      id: agentId,
      name: `${domain.name}${cap.name}`,
      nameEn: `${domain.nameEn} ${cap.nameEn}`,
      emoji: cap.emoji,
      description: `${domain.name}领域的${cap.name}，${cap.description}`,
      capabilityId,
      domainId,
      tier,
      model: cap.model || 'fast',
      maxIterations: cap.maxIterations || 10,
      allowedTools: this._resolveTools(capabilityId, domainId),
      disallowedTools: cap.disallowedTools || [],
      systemPrompt: this.generateSystemPrompt(capabilityId, domainId),
      spawnable: tier !== 'chat',
      source: 'composed',
    };

    this._composedCache.set(cacheKey, composed);
    this.emit('agent:composed', { agentId, capabilityId, domainId, tier });
    return composed;
  }

  composeAll() {
    const agents = [];
    const activeDomains = this._domainRegistry.listActive();
    const capabilities = this._capabilityRegistry.list();

    for (const domain of activeDomains) {
      for (const cap of capabilities) {
        const agent = this.compose(cap.id, domain.id);
        if (agent) {
          agents.push(agent);
        }
      }
    }

    return agents;
  }

  composeForDomain(domainId) {
    const agents = [];
    const capabilities = this._capabilityRegistry.list();

    for (const cap of capabilities) {
      const agent = this.compose(cap.id, domainId);
      if (agent) {
        agents.push(agent);
      }
    }

    return agents;
  }

  composeForCapability(capabilityId) {
    const agents = [];
    const activeDomains = this._domainRegistry.listActive();

    for (const domain of activeDomains) {
      const agent = this.compose(capabilityId, domain.id);
      if (agent) {
        agents.push(agent);
      }
    }

    return agents;
  }

  getComposedAgent(agentId) {
    if (this._composedCache.has(agentId)) {
      return { ...this._composedCache.get(agentId) };
    }

    const parsed = this._parseAgentId(agentId);
    if (parsed) {
      return this.compose(parsed.capabilityId, parsed.domainId);
    }

    return null;
  }

  listComposedAgents() {
    return this.composeAll();
  }

  generateSystemPrompt(capabilityId, domainId) {
    return this._capabilityRegistry.generatePrompt(capabilityId, domainId, this._domainRegistry);
  }

  resolveModel(capabilityId, _domainId) {
    const cap = this._capabilityRegistry.get(capabilityId);
    return cap?.model || 'fast';
  }

  resolveTier(agentId) {
    const parsed = this._parseAgentId(agentId);
    if (!parsed) return 'worker';
    return CAPABILITY_TIER_MAP[parsed.capabilityId] || 'worker';
  }

  _resolveTools(capabilityId, _domainId) {
    const cap = this._capabilityRegistry.get(capabilityId);
    return cap?.allowedTools || null;
  }

  _parseAgentId(agentId) {
    const parts = agentId.split('_');
    if (parts.length < 2) return null;

    const capabilities = this._capabilityRegistry.list();
    const capIds = new Set(capabilities.map(c => c.id));

    for (let i = 1; i < parts.length; i++) {
      const domainPart = parts.slice(0, i).join('_');
      const capPart = parts.slice(i).join('_');

      if (capIds.has(capPart) && this._domainRegistry.get(domainPart)) {
        return { domainId: domainPart, capabilityId: capPart };
      }
    }

    if (parts.length === 2) {
      const [domainPart, capPart] = parts;
      if (capIds.has(capPart) && this._domainRegistry.get(domainPart)) {
        return { domainId: domainPart, capabilityId: capPart };
      }
    }

    return null;
  }

  invalidateCache() {
    this._composedCache.clear();
  }

  getFilteredTools(agentId, allTools) {
    const agent = this.getComposedAgent(agentId);
    if (!agent) return allTools;

    let tools = [...allTools];

    if (agent.allowedTools && agent.allowedTools.length > 0) {
      const allowedSet = new Set(agent.allowedTools);
      tools = tools.filter(t => allowedSet.has(t.name || t));
    }

    if (agent.disallowedTools && agent.disallowedTools.length > 0) {
      const disallowedSet = new Set(agent.disallowedTools);
      tools = tools.filter(t => !disallowedSet.has(t.name || t));
    }

    return tools;
  }
}

module.exports = { AgentComposer, AGENT_TIERS };
