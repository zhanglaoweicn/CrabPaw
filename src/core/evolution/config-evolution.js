/**
 * @deprecated 配置进化引擎 — 空壳实现，evolve() 无实际效果。
 * analyze() 返回硬编码数据，identifyOpportunities/improve/apply 均为模板代码。
 * 保留导出以维持 evolution-system.js 和 evolution-handler.js 的引用兼容，
 * 后续版本应移除此模块。
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const CONFIG_EVOLUTION_PATH = path.join(config.DATA_DIR, 'config-evolution.json');

class ConfigEvolutionEngine {
  constructor() { this.data = null; this.isEvolving = false; }

  async init() {
    try {
      const raw = await fs.readFile(CONFIG_EVOLUTION_PATH, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = { recommendations: [], appliedChanges: [], stats: { totalRecommendations: 0, applied: 0, avgImprovement: 0 } };
      await this.saveData();
    }
    console.log('⚙️ 配置进化引擎已初始化');
  }

  async saveData() { await fs.writeFile(CONFIG_EVOLUTION_PATH, JSON.stringify(this.data, null, 2)); }

  async evolve() {
    if (this.isEvolving) return { improvement: 0 };
    this.isEvolving = true;
    try {
      const analysis = await this.analyze();
      const opportunities = await this.identifyOpportunities(analysis);
      const improvements = [];
      for (const opp of opportunities) {
        try { improvements.push(await this.improve(opp)); } catch (e) {
          /* ignored */
          console.warn('[config-evolution.js] 空 catch 补日志:', e && e.message);
        }

      }
      if (improvements.some(i => i.improvement > 0)) await this.apply(improvements);
      return { improvement: improvements.reduce((s, i) => s + (i.improvement || 0), 0) };
    } finally { this.isEvolving = false; }
  }

  async analyze() {
    return {
      configSize: Object.keys(this.data).length,
      recentChanges: this.data.appliedChanges?.slice(-5) || [],
      recommendationCount: this.data.recommendations?.length || 0
    };
  }

  async identifyOpportunities(_analysis) {
    const opps = [];
    // 检测可优化的配置项
    opps.push({ type: 'optimize_model', priority: 'medium', description: '优化模型配置' });
    opps.push({ type: 'optimize_tts', priority: 'low', description: '优化TTS配置' });
    return opps;
  }

  async improve(opp) {
    switch (opp.type) {
      case 'optimize_model': return { type: 'optimize_model', improvement: 1 };
      case 'optimize_tts': return { type: 'optimize_tts', improvement: 0.5 };
      default: return { improvement: 0 };
    }
  }

  async apply(improvements) {
    this.data.stats.applied += improvements.length;
    await this.saveData();
  }

  async validate(improvements) {
    return { passed: improvements.some(i => i.improvement > 0), validCount: improvements.filter(i => i.improvement > 0).length, totalCount: improvements.length };
  }

  getReport() { return this.data.stats; }
}

let engine = null;
async function getConfigEvolutionEngine() {
  if (!engine) { engine = new ConfigEvolutionEngine(); await engine.init(); }
  return engine;
}

module.exports = { ConfigEvolutionEngine, getConfigEvolutionEngine };
