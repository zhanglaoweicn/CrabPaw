/**
 * EvolutionAwareMemory — 进化感知的记忆集成层
 *
 * 职责：将 MemoryEvolutionEngine 与 UnifiedMemoryStore 桥接，
 * 提供重要性评估、智能检索和用户画像进化。
 *
 * 注意：此类与 memory/index.js 的 EnhancedMemorySystem 不同 —
 * EnhancedMemorySystem 负责 HRR 向量检索、实体解析、信任评分等
 * 语义记忆能力；EvolutionAwareMemory 负责进化引擎集成和用户画像。
 *
 * 将进化引擎与现有记忆系统打通：
 * 1. 进化感知存储 - 存储时自动评估重要性并分层
 * 2. 智能检索 - 结合用户画像和上下文的语义检索
 * 3. 记忆进化 - 自动压缩、遗忘、提升
 * 4. 跨会话记忆 - 会话间记忆持久化和关联
 * 5. 用户画像进化 - 从交互中持续学习用户偏好
 */

const { getMemoryEvolutionEngine } = require('./evolution/memory-evolution');
const { getUnifiedStore } = require('./memory/unified-store');

class EvolutionAwareMemory {
  constructor() {
    this.evolutionEngine = null;
    this.unifiedStore = null;
    this.initialized = false;
  }

  async init() {
    try {
      this.evolutionEngine = await getMemoryEvolutionEngine();
      this.unifiedStore = await getUnifiedStore();

      // 修复绑定断裂 + 自环（P1）：此前 setEnhancedMemory(this) 绑回自身引擎——
      // _syncToEnhancedMemory 调 store() 又回到 evolutionEngine.store()，自我复制环
      // （HRR/统一存储从未收到数据）。改绑 memory-manager 的 EnhancedMemorySystem
      // 真身（src/core/memory/index.js 的 HRR 语义记忆类）。
      try {
        const { memoryManager } = require('./memory-system');
        const realEnhanced = memoryManager && memoryManager.enhancedMemory;
        if (realEnhanced && typeof realEnhanced.initialize === 'function') {
          await realEnhanced.initialize();
        }
        this.evolutionEngine.setEnhancedMemory(realEnhanced || null);
      } catch (e) {
        console.warn('[enhanced-memory] enhanced memory system bind failed:', e.message);
        this.evolutionEngine.setEnhancedMemory(null);
      }
      try {
        const { memoryManager } = require('./memory-system');
        if (memoryManager && memoryManager.memoryDecay) {
          this.evolutionEngine.setDecayEngine(memoryManager.memoryDecay);
        }
      } catch (e) {
        console.warn('[enhanced-memory] decay engine bind failed:', e.message);
      }

      this.initialized = true;
      console.log('🧠 进化感知记忆已初始化');
    } catch (err) {
      console.warn('⚠️ 进化感知记忆初始化失败:', err.message);
      this.initialized = false;
    }
  }

  /**
   * 存储记忆（进化感知）
   */
  async store(memory) {
    if (!this.initialized) return null;

    // 1. 评估记忆重要性
    const importance = this.assessImportance(memory);

    // 2. 存储到进化引擎
    const entry = await this.evolutionEngine.store({
      ...memory,
      importance
    });

    // 3. 如果重要性高，也存储到统一存储
    if (importance > 0.7 && this.unifiedStore) {
      try {
        this.unifiedStore.addMemory({
          id: entry.id,
          type: memory.type || 'general',
          content: memory.content,
          importance,
          source: 'enhanced_memory',
          namespace: memory.userId || 'global',
        });
      } catch (e) { console.warn('[enhanced-memory] 统一存储写入失败:', e.message); }
    }

    return entry;
  }

  /**
   * 检索记忆（智能检索）
   */
  async retrieve(query, options = {}) {
    if (!this.initialized) return [];

    const { limit = 10, includeProfile = true, minImportance = 0 } = options;

    // 1. 从进化引擎检索
    const results = await this.evolutionEngine.retrieve(query, limit);

    // 2. 过滤低重要性 + P0 污染修复：type==='conversation' 是原始对话裸消息，
    //    不是"相关记忆"，不注入 prompt
    const filtered = results.filter(r =>
      (r.importance || 0) >= minImportance && r.type !== 'conversation'
    );

    // 3. 附加用户画像（如果需要）
    const profile = includeProfile ? this.evolutionEngine.getUserProfile() : null;
    return { memories: filtered, profile };
  }

  /**
   * 评估记忆重要性
   */
  assessImportance(memory) {
    let importance = memory.importance || 0.5;

    // 基于类型调整
    const typeWeights = {
      user_preference: 0.9,
      user_feedback: 0.85,
      task_result: 0.7,
      conversation: 0.5,
      system_event: 0.3,
      error: 0.6
    };
    importance = Math.max(importance, typeWeights[memory.type] || 0.5);

    // 基于情感强度调整
    if (memory.sentiment === 'positive') importance *= 1.1;
    if (memory.sentiment === 'negative') importance *= 1.15;

    return Math.min(importance, 1.0);
  }

  /**
   * 获取用户画像
   */
  getUserProfile() {
    if (!this.initialized) return {};
    return this.evolutionEngine.getUserProfile();
  }

  /**
   * 触发记忆进化
   */
  async evolve() {
    if (!this.initialized) return { improvement: 0 };
    return await this.evolutionEngine.evolve();
  }

  /**
   * 获取记忆报告
   */
  getReport() {
    if (!this.initialized) return {};
    return this.evolutionEngine.getReport();
  }
}

let _evolutionAwareMemory = null;
async function getEvolutionAwareMemory() {
  if (!_evolutionAwareMemory) {
    _evolutionAwareMemory = new EvolutionAwareMemory();
    await _evolutionAwareMemory.init();
  }
  return _evolutionAwareMemory;
}

/**
 * 向后兼容别名（逐步迁移用）。
 * 注意：此别名返回 EvolutionAwareMemory，与 memory/index.js 导出的
 * EnhancedMemorySystem（HRR 向量语义记忆类）同名异义。需要真正的
 * EnhancedMemorySystem 时请 require('./memory').EnhancedMemorySystem。
 * @deprecated 使用 getEvolutionAwareMemory（或 memory/index.js 的 EnhancedMemorySystem）
 */
const getEnhancedMemorySystem = getEvolutionAwareMemory;

module.exports = { EvolutionAwareMemory, getEvolutionAwareMemory, getEnhancedMemorySystem };
