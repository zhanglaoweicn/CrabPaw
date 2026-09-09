/**
 * EnhancedMemorySystem — 语义记忆子系统
 *
 * 职责：HRR 向量检索、实体解析、信任评分、LLM 记忆更新、
 * Agent 隔离、上下文围栏。这是记忆系统的"语义理解"层。
 *
 * 注意：此类与 enhanced-memory.js 的 EvolutionAwareMemory 不同 —
 * EvolutionAwareMemory 负责进化引擎集成和用户画像进化；
 * EnhancedMemorySystem 负责语义向量检索和结构化记忆管理。
 *
 * 升级特性：
 * 1. HRR 向量检索 - 语义级别的记忆检索
 * 2. 信任评分系统 - 动态评估记忆质量
 * 3. 实体解析系统 - 自动提取实体并关联记忆
 * 4. LLM 驱动更新 - 智能提取和更新记忆
 * 5. Per-Agent 隔离 - 每个 agent 独立的记忆空间
 * 6. 上下文围栏 - 防止记忆被误认为用户输入
 * 7. 预取机制 - 每轮对话前异步预取相关记忆
 */

const { HRREngine, HybridRetriever } = require('./hrr-engine');
const { TrustScoreManager, TrustFeedbackCollector, TRUST_CONSTANTS } = require('./scoring');
const { EntityExtractor, EntityResolver, EntityAwareMemoryStore } = require('./entity-resolution');
const { LLMMemoryUpdater, MemoryConsolidator } = require('./llm-updater');
const { AgentMemoryStore, GlobalMemoryStore, HybridMemoryManager } = require('./memory-isolation');
// 2026-08-31 Eval 隔离轮 Task 2：默认 dataDir 改走 config.DATA_DIR（此前 CWD 相对
// './data/'+'.crabpaw' 式 CWD 相对硬编码——CRABPAW_DATA_DIR 重定向对裸构造失效，eval 曾
// 借此写真实 memory/memory.json(415MB)。默认绝对路径与 repo 根 CWD 下旧值同文件）。
const path = require('path');
const { DATA_DIR } = require('../config');
const {
  MemoryFence,
  MemoryPrefetcher,
  MemoryContextManager,
  TurnMemoryIntegration,
  buildMemoryContextBlock,
  sanitizeContext,
} = require('./context-fence');

const {
  TeamMemoryStore,
  TeamMemberManager,
  TeamMemoryManager,
  MEMORY_SCOPES,
  MEMORY_PERMISSIONS,
} = require('./team-memory');

const {
  MemoryArchiver,
  MEMORY_LAYERS,
  ARCHIVE_CONFIG,
} = require('./memory-archiver');

const {
  SessionPersistence,
} = require('./session-persistence');

const { UnifiedMemoryStore, getUnifiedStore } = require('./unified-store');
const scoring = require('./scoring');
const { ToolMemoryStore, ToolMemoryRule, ToolMemoryCaptureHook, renderToolMemoryRules } = require('./tool-memory');
const { EntityCoOccurrenceGraph, GraphEdge, TypedRelation } = require('./entity-graph');

const EventEmitter = require('events');

class EnhancedMemorySystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      dataDir: config.dataDir || path.join(DATA_DIR, 'memory'),
      hrrDim: config.hrrDim || 1024,
      defaultTrust: config.defaultTrust || 0.5,
      maxFacts: config.maxFacts || 100,
      maxPrefetchResults: config.maxPrefetchResults || 10,
      autoPrefetch: config.autoPrefetch !== false,
      ...config,
    };

    this.hrrEngine = new HRREngine({ dim: this.config.hrrDim });
    this.trustManager = new TrustScoreManager({
      defaultTrust: this.config.defaultTrust,
    });
    this.entityExtractor = new EntityExtractor();
    this.entityResolver = new EntityResolver();
    this.llmUpdater = new LLMMemoryUpdater({
      maxFactsPerUpdate: this.config.maxFacts,
    });
    this.consolidator = new MemoryConsolidator({
      maxFacts: this.config.maxFacts,
    });
    this.agentStore = new AgentMemoryStore({
      baseDir: this.config.dataDir,
    });
    this.globalStore = new GlobalMemoryStore({
      memoryPath: `${this.config.dataDir}/memory.json`,
    });
    this.hybridManager = new HybridMemoryManager({
      agent: { baseDir: this.config.dataDir },
      global: { memoryPath: `${this.config.dataDir}/memory.json` },
    });
    this.contextManager = new MemoryContextManager({
      autoPrefetch: this.config.autoPrefetch,
      maxPrefetchResults: this.config.maxPrefetchResults,
    });

    this._setupEventForwarding();
  }

  _setupEventForwarding() {
    this.trustManager.on('feedback:recorded', (data) => {
      this.emit('trust:feedback', data);
    });

    this.llmUpdater.on('analysis:complete', (data) => {
      this.emit('llm:analysis', data);
    });

    this.agentStore.on('agent:initialized', (data) => {
      this.emit('agent:initialized', data);
    });

    this.contextManager.on('turn:memory_prepared', (data) => {
      this.emit('context:prepared', data);
    });
  }

  setModel(model) {
    this.llmUpdater.setModel(model);
  }

  async initialize() {
    await this.globalStore.load();
    this.emit('system:initialized', {
      dataDir: this.config.dataDir,
    });
  }

  async search(query, options = {}) {
    const memory = await this.hybridManager.getMemory(options.agentName);
    const facts = memory.facts || [];

    const queryVec = this.hrrEngine.encodeText(query);

    let scored = facts.map(fact => {
      let hrrSim = 0.5;
      if (fact.hrrVector) {
        try {
          const factVec = this.hrrEngine.bytesToPhases(fact.hrrVector);
          hrrSim = (this.hrrEngine.similarity(queryVec, factVec) + 1) / 2;
        } catch (e) {
          hrrSim = 0.5;
        }
      }

      const trustScore = this.trustManager.calculateEffectiveTrust(fact);
      const score = hrrSim * trustScore;

      return { ...fact, score, hrrSim, trustScore };
    });

    scored.sort((a, b) => b.score - a.score);

    if (options.category) {
      scored = scored.filter(f => f.category === options.category);
    }

    const minTrust = options.minTrust || 0;
    if (minTrust > 0) {
      scored = scored.filter(f => (f.trustScore || 0) >= minTrust);
    }

    return scored.slice(0, options.limit || 10);
  }

  async getFact(factId, options = {}) {
    const memory = await this.hybridManager.getMemory(options.agentName);
    return memory.facts?.find(f => f.id === factId) || null;
  }

  async updateFact(factId, updates, options = {}) {
    const memory = await this.hybridManager.getMemory(options.agentName);
    const factIndex = memory.facts?.findIndex(f => f.id === factId);

    if (factIndex === -1 || factIndex === undefined) {
      throw new Error(`Fact ${factId} not found`);
    }

    const updatedFact = {
      ...memory.facts[factIndex],
      ...updates,
      id: factId,
      updatedAt: Date.now(),
    };

    if (updates.content && updates.content !== memory.facts[factIndex].content) {
      updatedFact.hrrVector = this.hrrEngine.encodeTextToBytes(updates.content);
    }

    memory.facts[factIndex] = updatedFact;
    await this.hybridManager.updateMemory(options.agentName, {
      facts: memory.facts,
    });

    this.emit('fact:updated', { factId, updates });
    return updatedFact;
  }

  async deleteFact(factId, options = {}) {
    const memory = await this.hybridManager.getMemory(options.agentName);
    const factIndex = memory.facts?.findIndex(f => f.id === factId);

    if (factIndex === -1 || factIndex === undefined) {
      throw new Error(`Fact ${factId} not found`);
    }

    memory.facts.splice(factIndex, 1);
    await this.hybridManager.updateMemory(options.agentName, {
      facts: memory.facts,
    });

    this.emit('fact:deleted', { factId });
    return true;
  }

  async addFact(content, options = {}) {
    const hrrVector = this.hrrEngine.encodeTextToBytes(content);
    const entities = this.entityExtractor.extractWithConfidence(content);

    const fact = this.trustManager.initializeFact({
      content,
      category: options.category || 'general',
      tags: options.tags || [],
      hrrVector,
      entities: entities.map(e => e.name),
    }, options.confidence);

    for (const entity of entities) {
      const resolved = this.entityResolver.resolve(entity.name);
      if (!resolved) {
        this.entityResolver.registerEntity(entity);
      }
      this.entityResolver.linkFactToEntity(fact.id, this.entityResolver.resolve(entity.name)?.id);
    }

    const savedFact = await this.hybridManager.addFact(options.agentName, fact);

    this.emit('fact:added', {
      factId: savedFact.id,
      content: content.slice(0, 100),
      entities: entities.length,
    });

    return savedFact;
  }

  async recordFeedback(factId, feedback, options = {}) {
    const memory = await this.hybridManager.getMemory(options.agentName);
    const fact = memory.facts?.find(f => f.id === factId);

    if (!fact) {
      throw new Error(`Fact ${factId} not found`);
    }

    const updatedFact = this.trustManager.recordFeedback(fact, feedback);

    await this.hybridManager.updateMemory(options.agentName, {
      facts: memory.facts.map(f => f.id === factId ? updatedFact : f),
    });

    return updatedFact;
  }

  async probeEntity(entityName, options = {}) {
    const entity = this.entityResolver.resolve(entityName);
    if (!entity) {
      return { entity: null, facts: [] };
    }

    const factIds = this.entityResolver.getFactsForEntity(entity.id);
    const memory = await this.hybridManager.getMemory(options.agentName);
    const facts = memory.facts?.filter(f => factIds.includes(f.id)) || [];

    return { entity, facts };
  }

  async reasonEntities(entityNames, options = {}) {
    const factCounts = new Map();

    for (const name of entityNames) {
      const entity = this.entityResolver.resolve(name);
      if (!entity) continue;

      const factIds = this.entityResolver.getFactsForEntity(entity.id);
      for (const factId of factIds) {
        factCounts.set(factId, (factCounts.get(factId) || 0) + 1);
      }
    }

    const memory = await this.hybridManager.getMemory(options.agentName);
    const connectedFacts = Array.from(factCounts.entries())
      .filter(([_, count]) => count >= 2)
      .map(([factId, count]) => {
        const fact = memory.facts?.find(f => f.id === factId);
        return fact ? { ...fact, entityMatchCount: count } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.entityMatchCount - a.entityMatchCount);

    return connectedFacts;
  }

  async analyzeConversation(messages, options = {}) {
    const currentMemory = await this.hybridManager.getMemory(options.agentName);
    return await this.llmUpdater.analyzeConversation(messages, currentMemory);
  }

  async updateFromConversation(messages, options = {}) {
    const analysis = await this.analyzeConversation(messages, options);
    const currentMemory = await this.hybridManager.getMemory(options.agentName);

    const updatedMemory = await this.consolidator.mergeMemorySections(
      currentMemory,
      analysis
    );

    await this.hybridManager.updateMemory(options.agentName, updatedMemory);

    this.emit('memory:updated', {
      factsAdded: analysis.facts?.length || 0,
      sectionsUpdated: this._countSectionUpdates(analysis),
    });

    return updatedMemory;
  }

  _countSectionUpdates(update) {
    let count = 0;
    if (update.user) {
      for (const section of Object.values(update.user)) {
        if (section.shouldUpdate) count++;
      }
    }
    if (update.history) {
      for (const section of Object.values(update.history)) {
        if (section.shouldUpdate) count++;
      }
    }
    return count;
  }

  async prepareTurnContext(userMessage, options = {}) {
    return await this.contextManager.prepareContext(userMessage, options);
  }

  async getStats() {
    const memory = await this.hybridManager.getMemory();

    return {
      totalFacts: memory.facts?.length || 0,
      entities: this.entityResolver.getStats(),
      agents: this.hybridManager.getStats(),
      cache: this.contextManager.getStats(),
    };
  }

  async export() {
    const memory = await this.hybridManager.getMemory();
    const entities = this.entityResolver.export();

    return {
      version: '2.0',
      exportedAt: Date.now(),
      memory,
      entities,
      config: this.config,
    };
  }

  async import(data) {
    if (data.version !== '2.0') {
      throw new Error('Incompatible memory version');
    }

    if (data.memory) {
      await this.hybridManager.globalStore.save(data.memory);
    }

    if (data.entities) {
      this.entityResolver.import(data.entities);
    }

    this.emit('memory:imported', {
      factCount: data.memory?.facts?.length || 0,
      entityCount: data.entities?.entities?.length || 0,
    });
  }
}

module.exports = {
  EnhancedMemorySystem,
  HRREngine,
  HybridRetriever,
  TrustScoreManager,
  TrustFeedbackCollector,
  TRUST_CONSTANTS,
  EntityExtractor,
  EntityResolver,
  EntityAwareMemoryStore,
  LLMMemoryUpdater,
  MemoryConsolidator,
  AgentMemoryStore,
  GlobalMemoryStore,
  HybridMemoryManager,
  MemoryFence,
  MemoryPrefetcher,
  MemoryContextManager,
  TurnMemoryIntegration,
  buildMemoryContextBlock,
  sanitizeContext,
  TeamMemoryStore,
  TeamMemberManager,
  TeamMemoryManager,
  MEMORY_SCOPES,
  MEMORY_PERMISSIONS,
  MemoryArchiver,
  MEMORY_LAYERS,
  ARCHIVE_CONFIG,
  SessionPersistence,
  UnifiedMemoryStore,
  getUnifiedStore,
  scoring,
  ToolMemoryStore,
  ToolMemoryRule,
  ToolMemoryCaptureHook,
  renderToolMemoryRules,
  EntityCoOccurrenceGraph,
  GraphEdge,
  TypedRelation,
};
