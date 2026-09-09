/**
 * 记忆进化引擎 - 记忆压缩、用户画像进化、跨会话记忆
 * 实现记忆的自我优化能力
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const MEMORY_EVOLUTION_PATH = path.join(config.DATA_DIR, 'memory-evolution.json');

const DEFAULT_MEMORY_DATA = {
  // 工作记忆（短期）
  workingMemory: [],
  // 情景记忆（中期）
  episodicMemory: [],
  // 语义记忆（长期）
  semanticMemory: [],
  // 用户画像
  userProfile: {
    basic: {},
    preferences: {},
    usagePatterns: {},
    communicationStyle: {},
    workHabits: {},
    evolutionHistory: []
  },
  // 记忆索引
  index: {},
  // 进化统计
  stats: {
    totalMemories: 0,
    compressedMemories: 0,
    forgottenMemories: 0,
    averageRetrievalTime: 0,
    cacheHitRate: 0,
    userProfileUpdates: 0
  }
};

class MemoryEvolutionEngine {
  constructor() {
    this.data = null;
    this.isEvolving = false;
    this._enhancedMemory = null; // 桥接：实际的增强记忆系统（P1：须为 memory-manager 的 EnhancedMemorySystem 真身）
    this._decayEngine = null;    // 桥接：记忆衰减引擎
    this._savePromise = null;    // P0：批量落盘——同 tick 多次 saveData 合并为一次写
    this._dirty = false;
  }

  /**
   * 绑定 EnhancedMemorySystem — 让进化操作影响实际记忆数据
   * P1: 必须绑 memory-manager 的 EnhancedMemorySystem 真身（src/core/memory/index.js
   * 的 HRR 语义记忆类）；绑定 EvolutionAwareMemory 自身会构成自我复制环
   * （_syncToEnhancedMemory 的 store() 又回到本引擎 store()）。
   */
  setEnhancedMemory(enhancedMemory) {
    this._enhancedMemory = enhancedMemory;
  }

  /**
   * 绑定 MemoryDecayEngine — 让进化触发衰减检查
   */
  setDecayEngine(decayEngine) {
    this._decayEngine = decayEngine;
  }

  async init() {
    try {
      this.data = await this.loadData();
      console.log('🧠 记忆进化引擎已初始化');
    } catch (err) {
      this.data = DEFAULT_MEMORY_DATA;
      await this.saveData();
    }
  }

  async loadData() {
    try {
      const data = await fs.readFile(MEMORY_EVOLUTION_PATH, 'utf-8');
      return JSON.parse(data);
    } catch { return DEFAULT_MEMORY_DATA; }
  }

  /**
   * 批量落盘（P0）：此前每条消息 store() 全量重写整个 JSON（1.1MB/644 条时
   * 每次写入 O(n) 且伴随大量中间态）。现做写合并：同一 tick 内多次调用只写一次
   * （setImmediate 合并，序列化发生在写入时取最新 this.data），等待方 await 同一 Promise。
   */
  async saveData() {
    this._dirty = true;
    if (this._savePromise) return this._savePromise;
    this._savePromise = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          if (this._dirty) {
            await fs.writeFile(MEMORY_EVOLUTION_PATH, JSON.stringify(this.data, null, 2));
            this._dirty = false;
          }
        } catch (e) {
          console.error("[memory-evolution] 记忆数据落盘失败:", e.message);
        }
        resolve();
        this._savePromise = null;
      });
    });
    return this._savePromise;
  }

  /** 强制立即落盘（测试/进程退出前用） */
  async flushData() {
    if (this._dirty) {
      await fs.writeFile(MEMORY_EVOLUTION_PATH, JSON.stringify(this.data, null, 2));
      this._dirty = false;
    }
  }

  async evolve() {
    if (this.isEvolving) return { improvement: 0 };
    this.isEvolving = true;
    console.log('🧠 开始记忆进化...');

    try {
      const analysis = await this.analyze();
      const opportunities = await this.identifyOpportunities(analysis);
      const improvements = [];
      for (const opp of opportunities) {
        try { improvements.push(await this.improve(opp)); }
        catch (err) { console.error('🧠 记忆改进失败:', err); }
      }
      const validation = await this.validate(improvements);
      if (validation.passed) await this.apply(improvements);

      // ===== 桥接：同步进化结果到实际记忆系统 =====
      let syncResult = null;
      if (this._enhancedMemory) {
        try {
          syncResult = await this._syncToEnhancedMemory(improvements);
        } catch (err) {
          console.warn('🧠 同步到增强记忆系统失败:', err.message);
        }
      }

      // ===== 桥接：触发衰减引擎检查 =====
      if (this._decayEngine) {
        try {
          const decayResult = await this._decayEngine._runDecayCycle();
          console.log(`🧠 衰减检查完成: 衰减=${decayResult.decayed}, 巩固=${decayResult.consolidated}, 修剪=${decayResult.pruned}`);
        } catch (err) {
          console.warn('🧠 衰减检查失败:', err.message);
        }
      }

      const totalImprovement = improvements.reduce((s, i) => s + (i.improvement || 0), 0);
      console.log(`🧠 记忆进化完成，改进: ${totalImprovement.toFixed(2)}%`);
      return { improvement: totalImprovement, analysis, opportunities: opportunities.length, improvements: improvements.length, syncResult };
    } finally { this.isEvolving = false; }
  }

  /**
   * 同步进化结果到增强记忆系统（P1：setEnhancedMemory 已改绑 memory-manager 的
   * EnhancedMemorySystem 真身，此处走其 addFact 写入 API——HRR 语义记忆；
   * 不再把数据塞回本引擎形成自我复制环）
   */
  async _syncToEnhancedMemory(_improvements) {
    if (!this._enhancedMemory) return null;

    const result = { factsSynced: 0, factsPruned: 0, factsPromoted: 0 };

    try {
      // 使用 EnhancedMemorySystem 的 retrieve/store API
      // 1. 同步新记忆：将进化引擎中的高价值记忆添加到增强系统
      const newHighValue = this.data.semanticMemory.filter(
        m => (m.importance || 0) > 0.8 && m.content
      );

      for (const mem of newHighValue.slice(0, 5)) {
        try {
          await this._enhancedMemory.addFact(mem.content, {
            category: mem.type || 'evolved',
            tags: mem.tags || [],
            confidence: mem.importance || 0.8,
          });
          result.factsSynced++;
        } catch (e) {

          // 单条同步失败不影响整体

          console.warn('[memory-evolution.js] 空 catch 补日志:', e && e.message);
        }

      }

      // 2. 同步提升：增加高重要性记忆的信任度（通过重新存储提升权重）
      const promotedMemories = [
        ...this.data.episodicMemory.filter(m => m.promoted),
        ...this.data.semanticMemory.filter(m => m.promoted),
      ];

      for (const promoted of promotedMemories.slice(0, 3)) {
          try {
          await this._enhancedMemory.addFact(promoted.content, {
          category: promoted.type || 'promoted',
          tags: promoted.tags || [],
          confidence: Math.min(1, (promoted.importance || 0.5) + 0.1),
          });
          result.factsPromoted++;
          } catch (e) {
            // 单条同步失败不影响整体
            console.warn('[memory-evolution.js] 空 catch 补日志:', e && e.message);
          }

      }

      // 3. 标记低重要性记忆为遗忘（在进化引擎内部处理）
      const forgottenCount = this.data.workingMemory
        .filter(m => m.forgotten || (m.importance || 0) < 0.1).length;
      result.factsPruned = forgottenCount;

    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  async analyze() {
    return {
      totalMemories: this.data.workingMemory.length + this.data.episodicMemory.length + this.data.semanticMemory.length,
      workingMemorySize: this.data.workingMemory.length,
      episodicMemorySize: this.data.episodicMemory.length,
      semanticMemorySize: this.data.semanticMemory.length,
      userProfileCompleteness: this.calculateProfileCompleteness()
    };
  }

  calculateProfileCompleteness() {
    const profile = this.data.userProfile;
    const fields = ['basic', 'preferences', 'usagePatterns', 'communicationStyle', 'workHabits'];
    const filled = fields.filter(f => Object.keys(profile[f] || {}).length > 0).length;
    return filled / fields.length;
  }

  async identifyOpportunities(analysis) {
    const opps = [];
    // 记忆压缩
    if (analysis.workingMemorySize > 100) {
      opps.push({ type: 'compress_working', priority: 'high', description: '压缩工作记忆' });
    }
    if (analysis.episodicMemorySize > 500) {
      opps.push({ type: 'compress_episodic', priority: 'medium', description: '压缩情景记忆' });
    }
    // 用户画像进化
    if (analysis.userProfileCompleteness < 0.8) {
      opps.push({ type: 'evolve_profile', priority: 'high', description: '进化用户画像' });
    }
    // 记忆遗忘
    opps.push({ type: 'forget_irrelevant', priority: 'low', description: '遗忘不相关记忆' });
    // 记忆升级
    opps.push({ type: 'promote_memories', priority: 'medium', description: '提升重要记忆等级' });
    return opps;
  }

  async improve(opportunity) {
    switch (opportunity.type) {
      case 'compress_working': return await this.compressWorkingMemory();
      case 'compress_episodic': return await this.compressEpisodicMemory();
      case 'evolve_profile': return await this.evolveUserProfile();
      case 'forget_irrelevant': return await this.forgetIrrelevantMemories();
      case 'promote_memories': return await this.promoteMemories();
      default: return { improvement: 0 };
    }
  }

  async compressWorkingMemory() {
    const before = this.data.workingMemory.length;
    // 按重要性排序，保留重要的
    this.data.workingMemory.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    const compressed = this.data.workingMemory.slice(0, 50);
    const promoted = this.data.workingMemory.slice(50).filter(m => (m.importance || 0) > 0.7);
    this.data.episodicMemory.push(...promoted);
    this.data.workingMemory = compressed;
    this.data.stats.compressedMemories += before - compressed.length;
    await this.saveData();
    return { type: 'compress_working', improvement: (before - compressed.length) / before * 10 };
  }

  async compressEpisodicMemory() {
    const before = this.data.episodicMemory.length;
    this.data.episodicMemory.sort((a, b) => (b.importance || 0) - (a.importance || 0));
    const compressed = this.data.episodicMemory.slice(0, 200);
    const promoted = this.data.episodicMemory.slice(200).filter(m => (m.importance || 0) > 0.9);
    this.data.semanticMemory.push(...promoted);
    this.data.episodicMemory = compressed;
    this.data.stats.compressedMemories += before - compressed.length;
    await this.saveData();
    return { type: 'compress_episodic', improvement: (before - compressed.length) / before * 5 };
  }

  async evolveUserProfile() {
    // 从记忆中提取用户偏好
    const allMemories = [...this.data.workingMemory, ...this.data.episodicMemory, ...this.data.semanticMemory];
    // 分析沟通风格
    const commMemories = allMemories.filter(m => m.type === 'communication');
    if (commMemories.length > 0) {
      this.data.userProfile.communicationStyle = {
        formality: this.analyzeFormality(commMemories),
        preferredLength: this.analyzePreferredLength(commMemories),
        tonePreference: this.analyzeTone(commMemories),
        lastUpdated: new Date().toISOString()
      };
    }
    // 分析工作习惯
    const workMemories = allMemories.filter(m => m.type === 'work');
    if (workMemories.length > 0) {
      this.data.userProfile.workHabits = {
        peakHours: this.analyzePeakHours(workMemories),
        preferredTools: this.analyzePreferredTools(workMemories),
        taskPatterns: this.analyzeTaskPatterns(workMemories),
        lastUpdated: new Date().toISOString()
      };
    }
    this.data.stats.userProfileUpdates++;
    this.data.userProfile.evolutionHistory.push({ timestamp: new Date().toISOString(), completeness: this.calculateProfileCompleteness() });
    await this.saveData();
    return { type: 'evolve_profile', improvement: 3 };
  }

  analyzeFormality(memories) {
    const texts = memories.map(m => m.content || '').filter(Boolean);
    if (texts.length === 0) return 'unknown';
    const casualMarkers = (texts.join(' ').match(/(吧|啊|呢|哈|嘿|哦|啦|嘛|呀|喂)/g) || []).length;
    const formalMarkers = (texts.join(' ').match(/(请|您|谨|敬|烦|劳|惠|赐|拜|恳)/g) || []).length;
    if (formalMarkers > casualMarkers * 2) return 'formal';
    if (casualMarkers > formalMarkers * 2) return 'casual';
    return 'mixed';
  }

  analyzePreferredLength(memories) {
    const lengths = memories.map(m => (m.content || '').length).filter(l => l > 0);
    if (lengths.length === 0) return 'unknown';
    const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length;
    if (avg < 50) return 'brief';
    if (avg < 200) return 'medium';
    return 'detailed';
  }

  analyzeTone(memories) {
    const texts = memories.map(m => m.content || '').filter(Boolean);
    if (texts.length === 0) return 'unknown';
    const positiveMarkers = (texts.join(' ').match(/(好|棒|赞|喜欢|感谢|谢谢|不错|优秀|完美)/g) || []).length;
    const negativeMarkers = (texts.join(' ').match(/(不|错|差|烦|讨厌|问题|bug|错误|失败)/g) || []).length;
    if (positiveMarkers > negativeMarkers * 2) return 'positive';
    if (negativeMarkers > positiveMarkers * 2) return 'critical';
    return 'neutral';
  }

  analyzePeakHours(memories) {
    const hours = memories
      .map(m => m.timestamp ? new Date(m.timestamp).getHours() : null)
      .filter(h => h !== null);
    if (hours.length === 0) return [];
    const hourCounts = {};
    hours.forEach(h => { hourCounts[h] = (hourCounts[h] || 0) + 1; });
    return Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([h]) => parseInt(h));
  }

  analyzePreferredTools(memories) {
    const toolMentions = {};
    memories.forEach(m => {
      const content = m.content || '';
      const toolMatch = content.match(/(?:使用|用|运行|执行|调用)\s*(\w+)/g);
      if (toolMatch) {
        toolMatch.forEach(t => {
          const tool = t.replace(/(?:使用|用|运行|执行|调用)\s*/, '');
          toolMentions[tool] = (toolMentions[tool] || 0) + 1;
        });
      }
    });
    return Object.entries(toolMentions)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool]) => tool);
  }

  analyzeTaskPatterns(memories) {
    const patterns = {};
    memories.forEach(m => {
      const type = m.type || 'unknown';
      patterns[type] = (patterns[type] || 0) + 1;
    });
    return Object.entries(patterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));
  }

  async forgetIrrelevantMemories() {
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30天
    const before = this.data.workingMemory.length;
    this.data.workingMemory = this.data.workingMemory.filter(m => {
      const age = now - new Date(m.timestamp || 0).getTime();
      return age < maxAge || (m.importance || 0) > 0.5;
    });
    this.data.stats.forgottenMemories += before - this.data.workingMemory.length;
    await this.saveData();
    return { type: 'forget_irrelevant', improvement: 1 };
  }

  async promoteMemories() {
    // 将高重要性的工作记忆提升到情景记忆
    const toPromote = this.data.workingMemory.filter(m => (m.importance || 0) > 0.8 && !m.promoted);
    toPromote.forEach(m => { m.promoted = true; });
    this.data.episodicMemory.push(...toPromote);
    // 将高重要性的情景记忆提升到语义记忆
    const toPromote2 = this.data.episodicMemory.filter(m => (m.importance || 0) > 0.95 && !m.promoted);
    toPromote2.forEach(m => { m.promoted = true; });
    this.data.semanticMemory.push(...toPromote2);
    await this.saveData();
    return { type: 'promote_memories', improvement: 2 };
  }

  async validate(improvements) {
    return { passed: improvements.some(i => i.improvement > 0), validCount: improvements.filter(i => i.improvement > 0).length, totalCount: improvements.length };
  }

  async apply(improvements) {
    // 同步统计到 JSON 数据
    const skills = Object.values(this.data.skills || {});
    if (skills.length > 0) {
      this.data.stats.averageImportance = skills.reduce((s, m) => s + (m.importance || 0), 0) / skills.length;
    }
    this.data.stats.totalMemories = (this.data.semanticMemory?.length || 0) + (this.data.episodicMemory?.length || 0) + (this.data.workingMemory?.length || 0);

    // 同步进化结果到实际记忆系统
    if (this._enhancedMemory && improvements && improvements.length > 0) {
      try {
        await this._syncToEnhancedMemory(improvements);
      } catch (err) {
        console.warn('🧠 apply() 同步到增强记忆系统失败:', err.message);
      }
    }

    await this.saveData();
  }

  // === 记忆操作 API ===

  async store(memory) {
    const entry = { ...memory, id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), importance: memory.importance || 0.5 };
    if (entry.importance > 0.8) {
      this.data.semanticMemory.push(entry);
    } else if (entry.importance > 0.5) {
      this.data.episodicMemory.push(entry);
    } else {
      this.data.workingMemory.push(entry);
    }
    this.data.stats.totalMemories++;
    await this.saveData();
    return entry;
  }

  async retrieve(query, limit = 10) {
    const startTime = Date.now();
    const allMemories = [...this.data.semanticMemory, ...this.data.episodicMemory, ...this.data.workingMemory];
    // 简单关键词匹配
    const keywords = query.toLowerCase().split(/\s+/);
    const scored = allMemories.map(m => {
      const text = (m.content || '').toLowerCase();
      const score = keywords.reduce((s, kw) => s + (text.includes(kw) ? 1 : 0), 0) + (m.importance || 0);
      return { ...m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);
    const retrievalTime = Date.now() - startTime;
    this.data.stats.averageRetrievalTime = (this.data.stats.averageRetrievalTime * 0.9) + (retrievalTime * 0.1);
    await this.saveData();
    return results;
  }

  getUserProfile() { return this.data.userProfile; }

  getReport() {
    return {
      stats: this.data.stats,
      profileCompleteness: this.calculateProfileCompleteness(),
      memoryDistribution: {
        working: this.data.workingMemory.length,
        episodic: this.data.episodicMemory.length,
        semantic: this.data.semanticMemory.length
      }
    };
  }
}

let engine = null;
async function getMemoryEvolutionEngine() {
  if (!engine) { engine = new MemoryEvolutionEngine(); await engine.init(); }
  return engine;
}

module.exports = { MemoryEvolutionEngine, getMemoryEvolutionEngine };
