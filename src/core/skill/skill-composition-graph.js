/**
 * Skill Composition Graph — 技能组合图谱
 *
 * 记录和发现技能之间的组合关系，构建有向加权图：
 *
 *   节点 = 技能
 *   边   = 组合关系（A → B 表示 "A 之后常使用 B"）
 *   权重 = 共现频率 + 成功率 + 时间邻近度
 *
 * 核心能力：
 *   1. 记录技能共现（同一会话内连续使用的技能对）
 *   2. 计算组合强度（频率 × 成功率 × 时间衰减）
 *   3. 发现隐式技能链（高频组合 → 固化为模板）
 *   4. 检测涌现能力（组合效果 > 单独效果之和）
 *   5. 预测后续技能（给定当前技能，推荐下一步）
 *
 * 存储：JSON 文件，与 skill-quality.db 同级
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');

const GRAPH_DIR = path.join(DATA_DIR, 'composition');
const GRAPH_FILE = path.join(GRAPH_DIR, 'graph.json');
const COOCCURRENCE_FILE = path.join(GRAPH_DIR, 'cooccurrences.json');

// 组合强度计算参数
const COOCCURRENCE_WINDOW_MS = 5 * 60 * 1000;  // 5 分钟内视为同一任务链
const MIN_COOCCURRENCES = 3;                      // 最少共现次数才纳入图谱
const TIME_DECAY_HALF_LIFE = 30 * 24 * 3600 * 1000; // 30 天半衰期
const EMERGENCE_THRESHOLD = 1.3;                  // 组合效果超过单独效果 1.3 倍视为涌现

class SkillCompositionGraph extends EventEmitter {
  constructor(config = {}) {
    super();
    this._graphDir = config.graphDir || GRAPH_DIR;
    this._graphFile = config.graphFile || GRAPH_FILE;
    this._cooccurrenceFile = config.cooccurrenceFile || COOCCURRENCE_FILE;
    this._windowMs = config.windowMs || COOCCURRENCE_WINDOW_MS;
    this._minCooccurrences = config.minCooccurrences || MIN_COOCCURRENCES;

    // 图数据结构
    // edges: { "A→B": { count, successCount, avgGap, lastSeen, strength } }
    this._edges = new Map();
    // 节点元数据
    this._nodes = new Map();
    // 会话内的技能序列（用于检测共现）
    this._sessionChains = new Map(); // sessionId → [{skill, timestamp, success}]
    // 涌现能力记录
    this._emergences = [];

    this._dirty = false;
    this._saveTimer = null;
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;

    if (!fs.existsSync(this._graphDir)) {
      fs.mkdirSync(this._graphDir, { recursive: true });
    }

    this._load();
    this._initialized = true;

    // 定期保存
    this._saveTimer = setInterval(() => {
      if (this._dirty) this._save();
    }, 60000);

    console.log('[CompositionGraph] 技能组合图谱初始化完成', {
      nodes: this._nodes.size,
      edges: this._edges.size,
      emergences: this._emergences.length,
    });
  }

  /**
   * 记录技能执行（会话内）
   * @param {string} sessionId - 会话 ID
   * @param {string} skillName - 技能名
   * @param {boolean} success - 是否成功
   */
  recordExecution(sessionId, skillName, success) {
    if (!this._initialized) return;

    // 确保节点存在
    if (!this._nodes.has(skillName)) {
      this._nodes.set(skillName, {
        totalCalls: 0,
        successCount: 0,
        lastSeen: Date.now(),
      });
    }
    const node = this._nodes.get(skillName);
    node.totalCalls++;
    if (success) node.successCount++;
    node.lastSeen = Date.now();

    // 追加到会话链
    if (!this._sessionChains.has(sessionId)) {
      this._sessionChains.set(sessionId, []);
    }
    const chain = this._sessionChains.get(sessionId);
    const now = Date.now();
    chain.push({ skill: skillName, timestamp: now, success });

    // 检测与链中前序技能的共现
    for (let i = chain.length - 2; i >= 0; i--) {
      const prev = chain[i];
      const gap = now - prev.timestamp;
      if (gap > this._windowMs) break; // 超出时间窗口，停止回溯

      this._recordCooccurrence(prev.skill, skillName, {
        gap,
        bothSuccess: prev.success && success,
      });
    }

    // 清理过期会话链（超过 1 小时无活动）
    this._cleanupSessionChains();

    this._dirty = true;
    this.emit('execution:recorded', { sessionId, skillName, success });
  }

  /**
   * 记录共现关系
   */
  _recordCooccurrence(skillA, skillB, { gap, bothSuccess }) {
    const key = `${skillA}→${skillB}`;
    if (!this._edges.has(key)) {
      this._edges.set(key, {
        from: skillA,
        to: skillB,
        count: 0,
        successCount: 0,
        totalGap: 0,
        lastSeen: Date.now(),
        strength: 0,
      });
    }
    const edge = this._edges.get(key);
    edge.count++;
    if (bothSuccess) edge.successCount++;
    edge.totalGap += gap;
    edge.lastSeen = Date.now();

    // 重新计算组合强度
    edge.strength = this._calculateStrength(edge);
  }

  /**
   * 计算组合强度
   * strength = frequency_factor × success_factor × recency_factor
   */
  _calculateStrength(edge) {
    // 频率因子：对数缩放，避免高频组合过度主导
    const freqFactor = Math.log2(edge.count + 1) / Math.log2(100);

    // 成功率因子
    const successRate = edge.count > 0 ? edge.successCount / edge.count : 0;
    const successFactor = 0.3 + 0.7 * successRate; // 最低 0.3，避免零成功完全消失

    // 时间衰减因子
    const ageMs = Date.now() - edge.lastSeen;
    const recencyFactor = Math.pow(0.5, ageMs / TIME_DECAY_HALF_LIFE);

    return freqFactor * successFactor * recencyFactor;
  }

  /**
   * 预测后续技能
   * @param {string} currentSkill - 当前技能
   * @param {object} options - 选项
   * @returns {Array<{skill: string, strength: number, confidence: number}>}
   */
  predictNext(currentSkill, options = {}) {
    const maxResults = options.maxResults || 5;
    const minStrength = options.minStrength || 0.1;
    const candidates = [];

    // eslint-disable-next-line no-unused-vars
    for (const [key, edge] of this._edges) {
      if (edge.from === currentSkill && edge.strength >= minStrength) {
        candidates.push({
          skill: edge.to,
          strength: edge.strength,
          confidence: Math.min(1, edge.count / 10), // 基于样本量的置信度
          cooccurrenceCount: edge.count,
          successRate: edge.count > 0 ? edge.successCount / edge.count : 0,
        });
      }
    }

    candidates.sort((a, b) => b.strength - a.strength);
    return candidates.slice(0, maxResults);
  }

  /**
   * 发现高频组合（候选技能链模板）
   * @param {object} options - 选项
   * @returns {Array<{skills: string[], strength: number, count: number, successRate: number}>}
   */
  discoverFrequentCompositions(options = {}) {
    const minCount = options.minCount || this._minCooccurrences;
    const minStrength = options.minStrength || 0.3;
    const compositions = [];

    // eslint-disable-next-line no-unused-vars
    for (const [key, edge] of this._edges) {
      if (edge.count >= minCount && edge.strength >= minStrength) {
        compositions.push({
          skills: [edge.from, edge.to],
          strength: edge.strength,
          count: edge.count,
          successRate: edge.count > 0 ? edge.successCount / edge.count : 0,
          avgGap: edge.count > 0 ? edge.totalGap / edge.count : 0,
        });
      }
    }

    // 扩展为三技能链（A→B→C）
    const tripleCompositions = this._discoverTripleCompositions(compositions, minCount);
    compositions.push(...tripleCompositions);

    compositions.sort((a, b) => b.strength - a.strength);
    return compositions;
  }

  /**
   * 发现三技能链
   */
  _discoverTripleCompositions(pairCompositions, minCount) {
    const triples = [];
    const pairMap = new Map();

    for (const comp of pairCompositions) {
      const key = `${comp.skills[0]}→${comp.skills[1]}`;
      pairMap.set(key, comp);
    }

    for (const comp of pairCompositions) {
      const [a, b] = comp.skills;
      // 查找 B→C 的组合
      // eslint-disable-next-line no-unused-vars
      for (const [key, nextComp] of pairMap) {
        if (nextComp.skills[0] === b) {
          const c = nextComp.skills[1];
          const tripleStrength = (comp.strength + nextComp.strength) / 2;
          const tripleCount = Math.min(comp.count, nextComp.count);

          if (tripleCount >= minCount) {
            triples.push({
              skills: [a, b, c],
              strength: tripleStrength,
              count: tripleCount,
              successRate: (comp.successRate + nextComp.successRate) / 2,
              avgGap: (comp.avgGap + nextComp.avgGap) / 2,
            });
          }
        }
      }
    }

    return triples;
  }

  /**
   * 检测涌现能力
   * 涌现 = 组合效果 > 单独效果之和 × 阈值
   *
   * 效果 = 成功率 × 使用频率归一化
   */
  detectEmergence() {
    const emergences = [];

    // eslint-disable-next-line no-unused-vars
    for (const [key, edge] of this._edges) {
      if (edge.count < this._minCooccurrences) continue;

      const nodeA = this._nodes.get(edge.from);
      const nodeB = this._nodes.get(edge.to);
      if (!nodeA || !nodeB) continue;

      // 单独效果
      const effectA = nodeA.totalCalls > 0 ? nodeA.successCount / nodeA.totalCalls : 0;
      const effectB = nodeB.totalCalls > 0 ? nodeB.successCount / nodeB.totalCalls : 0;
      const individualEffect = effectA + effectB;

      // 组合效果
      const combinedEffect = edge.count > 0 ? edge.successCount / edge.count : 0;

      // 涌现比
      const emergenceRatio = individualEffect > 0 ? combinedEffect / (individualEffect / 2) : 0;

      if (emergenceRatio >= EMERGENCE_THRESHOLD) {
        emergences.push({
          skills: [edge.from, edge.to],
          emergenceRatio,
          combinedSuccessRate: combinedEffect,
          individualSuccessRates: { [edge.from]: effectA, [edge.to]: effectB },
          count: edge.count,
          strength: edge.strength,
        });
      }
    }

    emergences.sort((a, b) => b.emergenceRatio - a.emergenceRatio);
    this._emergences = emergences;
    this._dirty = true;

    if (emergences.length > 0) {
      this.emit('emergence:detected', { count: emergences.length, top: emergences[0] });
    }

    return emergences;
  }

  /**
   * 获取技能的完整组合图景
   */
  getSkillProfile(skillName) {
    const outgoing = [];
    const incoming = [];

    // eslint-disable-next-line no-unused-vars
    for (const [key, edge] of this._edges) {
      if (edge.from === skillName) {
        outgoing.push({ to: edge.to, strength: edge.strength, count: edge.count });
      }
      if (edge.to === skillName) {
        incoming.push({ from: edge.from, strength: edge.strength, count: edge.count });
      }
    }

    outgoing.sort((a, b) => b.strength - a.strength);
    incoming.sort((a, b) => b.strength - a.strength);

    return {
      skill: skillName,
      node: this._nodes.get(skillName) || null,
      outgoing,
      incoming,
      emergences: this._emergences.filter(e => e.skills.includes(skillName)),
    };
  }

  /**
   * 获取图谱统计
   */
  getStats() {
    return {
      nodes: this._nodes.size,
      edges: this._edges.size,
      emergences: this._emergences.length,
      activeSessions: this._sessionChains.size,
      topCompositions: this.discoverFrequentCompositions({ minCount: 2 }).slice(0, 10),
    };
  }

  /**
   * 清理过期会话链
   */
  _cleanupSessionChains() {
    const maxAge = 60 * 60 * 1000; // 1 小时
    const now = Date.now();

    for (const [sessionId, chain] of this._sessionChains) {
      const lastActivity = chain[chain.length - 1]?.timestamp || 0;
      if (now - lastActivity > maxAge) {
        this._sessionChains.delete(sessionId);
      }
    }
  }

  /**
   * 重新计算所有边的强度（定期维护）
   */
  recalculateStrengths() {
    // eslint-disable-next-line no-unused-vars
    for (const [key, edge] of this._edges) {
      edge.strength = this._calculateStrength(edge);
    }
    this._dirty = true;
  }

  _load() {
    try {
      if (fs.existsSync(this._graphFile)) {
        const data = JSON.parse(fs.readFileSync(this._graphFile, 'utf-8'));
        if (data.nodes) {
          for (const [k, v] of Object.entries(data.nodes)) this._nodes.set(k, v);
        }
        if (data.edges) {
          for (const [k, v] of Object.entries(data.edges)) this._edges.set(k, v);
        }
        this._emergences = data.emergences || [];
      }
    } catch (e) {
      console.warn('[skill-composition-graph] load failed (first run?):', e.message);
    }
  }

  _save() {
    try {
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        nodes: Object.fromEntries(this._nodes),
        edges: Object.fromEntries(this._edges),
        emergences: this._emergences,
      };

      const tmpFile = this._graphFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this._graphFile);
      this._dirty = false;
    } catch (err) {
      console.error('[CompositionGraph] 保存失败:', err.message);
    }
  }

  shutdown() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this._save();
  }
}

// 单例
let _instance = null;

function getCompositionGraph(config) {
  if (!_instance) {
    _instance = new SkillCompositionGraph(config);
  }
  return _instance;
}

module.exports = { SkillCompositionGraph, getCompositionGraph, EMERGENCE_THRESHOLD };
