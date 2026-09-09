/**
 * Skill Fusion Engine ?技能融合引?
 *
 * 发现可以~合/为更强大组合技能的技能对?
 *
 * 核心能力?
 *   1. 分析~合候选（基于组合图谱 + Jaccard 相似度）
 *   2. 生成~合计划（LLM 驱动?
 *   3. 执行~合并技能，归档旧技能）
 *   4. 记录谱系和融合历?
 *
 * 存储：data/.crabpaw/fusions/fusion-history.json
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(__dirname, '..', '..', '..');
const DATA_DIR = require('../config').DATA_DIR; // 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const FUSION_DIR = path.join(DATA_DIR, 'fusions');
const FUSION_HISTORY_FILE = path.join(FUSION_DIR, 'fusion-history.json');
const GLOBAL_SKILLS_DIR = path.join(BASE_DIR, 'data', 'skills');

// ~合候选阈?

const MIN_JACCARD_SIMILARITY = 0.1;
const MIN_COMBINED_SCORE = 0.25;

class SkillFusionEngine {
  constructor(config = {}) {
    this._fusionDir = config.fusionDir || FUSION_DIR;
    this._fusionHistoryFile = config.fusionHistoryFile || FUSION_HISTORY_FILE;
    this._skillsDir = config.skillsDir || GLOBAL_SKILLS_DIR;
    this._history = [];
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;

    if (!fs.existsSync(this._fusionDir)) {
      fs.mkdirSync(this._fusionDir, { recursive: true });
    }

    this._loadHistory();
    this._initialized = true;
  }

  /**
   * 分析~合候选技能对
   * 使用两种信号?
   *   1. 组合图谱数据（技能频繁共同使?= ~合候选）
   *   2. 描述的关键词重叠度（Jaccard 相似度）作为辅助信号
   *
   * @param {Array<{name: string, description: string}>} skillsList
   * @returns {Array<{skillA: string, skillB: string, score: number, signals: object}>}
   */
  analyzeFusionCandidates(skillsList) {
    if (!skillsList || skillsList.length < 2) return [];

    this.initialize();

    let graph;
    try {
      const { getCompositionGraph } = require('./skill-composition-graph');
      graph = getCompositionGraph();
      graph.initialize();
    } catch (e) {
      graph = null;
    }

    const skillNames = new Set(skillsList.map(s => s.name));

    // 信号1：组合图谱共现强?
    const cooccurrenceScores = new Map();
    if (graph) {
      const stats = graph.getStats();
      if (stats && stats.topCompositions) {
        for (const comp of stats.topCompositions) {
          if (comp.skills.length >= 2) {
            const a = comp.skills[0];
            const b = comp.skills[1];
            if (skillNames.has(a) && skillNames.has(b) && a !== b) {
              const key = this._pairKey(a, b);
              const existing = cooccurrenceScores.get(key);
              if (!existing || comp.strength > existing.strength) {
                cooccurrenceScores.set(key, {
                  skillA: a, skillB: b,
                  strength: comp.strength,
                  count: comp.count,
                  successRate: comp.successRate || 0,
                });
              }
            }
          }
        }
      }

      const compositions = graph.discoverFrequentCompositions
        ? graph.discoverFrequentCompositions({ minStrength: 0 })
        : [];
      for (const comp of compositions) {
        if (comp.skills.length >= 2) {
          const a = comp.skills[0];
          const b = comp.skills[1];
          if (skillNames.has(a) && skillNames.has(b) && a !== b) {
            const key = this._pairKey(a, b);
            if (!cooccurrenceScores.has(key)) {
              cooccurrenceScores.set(key, {
                skillA: a, skillB: b,
                strength: comp.strength,
                count: comp.count,
                successRate: comp.successRate || 0,
              });
            }
          }
        }
      }
    }

    // 信号2：Jaccard 相似?
    const jaccardScores = new Map();
    const tokensCache = new Map();
    for (const skill of skillsList) {
      const text = skill.description || skill.name;
      tokensCache.set(skill.name, this._tokenize(text));
    }

    const namesArr = Array.from(skillNames);
    for (let i = 0; i < namesArr.length; i++) {
      for (let j = i + 1; j < namesArr.length; j++) {
        const a = namesArr[i];
        const b = namesArr[j];
        const tokensA = tokensCache.get(a) || new Set();
        const tokensB = tokensCache.get(b) || new Set();
        const jaccard = this._jaccardSimilarity(tokensA, tokensB);
        if (jaccard >= MIN_JACCARD_SIMILARITY) {
          jaccardScores.set(this._pairKey(a, b), {
            jaccard,
            tokensA: tokensA.size,
            tokensB: tokensB.size,
          });
        }
      }
    }

    // 合并信号计算总分
    const candidates = [];
    const allPairKeys = new Set([
      ...cooccurrenceScores.keys(),
      ...jaccardScores.keys(),
    ]);

    for (const key of allPairKeys) {
      const cooc = cooccurrenceScores.get(key) || { strength: 0, count: 0, successRate: 0 };
      const jac = jaccardScores.get(key) || { jaccard: 0 };

      const score = 0.55 * Math.min(1, cooc.strength * 2) + 0.45 * jac.jaccard;

      if (score >= MIN_COMBINED_SCORE) {
        const [skillA, skillB] = this._unpairKey(key);
        if (this._wasAlreadyFused(skillA, skillB)) continue;

        candidates.push({
          skillA,
          skillB,
          score: Math.round(score * 1000) / 1000,
          signals: {
            cooccurrenceStrength: Math.round(cooc.strength * 1000) / 1000,
            cooccurrenceCount: cooc.count,
            cooccurrenceSuccessRate: Math.round((cooc.successRate || 0) * 1000) / 1000,
            jaccardSimilarity: Math.round(jac.jaccard * 1000) / 1000,
          },
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  /**
   * 生成~合计划（使?LLM?
   *
   * @param {object} skillA - { name, description }
   * @param {object} skillB - { name, description }
   * @param {object} llmClient - { complete(prompt) => string }
   * @returns {Promise<object>} ~合计划
   */
  async generateFusionPlan(skillA, skillB, llmClient) {
    this.initialize();

    const contentA = this._readSkillMd(skillA);
    const contentB = this._readSkillMd(skillB);

    const prompt = `You are a skill fusion architect. Given two skills, create a plan to merge them into a single, more powerful combined skill.

=== SKILL A: ${skillA.name} ===
Description: ${skillA.description || 'N/A'}
Content:
${contentA.slice(0, 2000)}

=== SKILL B: ${skillB.name} ===
Description: ${skillB.description || 'N/A'}
Content:
${contentB.slice(0, 2000)}

=== TASK ===
Produce a JSON fusion plan with these fields:
{
  "combinedName": "kebab-case-name",
  "description": "One-line description of the combined skill",
  "synergy": "How these two skills complement each other",
  "mergedSkillMd": "The merged SKILL.md content (full markdown)",
  "mergedExecutor": "The combined executor logic description"
}

Return ONLY valid JSON, no markdown fences.`;

    let planJson;
    if (llmClient && typeof llmClient.complete === 'function') {
      const response = await llmClient.complete(prompt);
      planJson = this._extractJson(response);
    } else {
      planJson = this._generateBasicPlan(skillA, skillB);
    }

    return {
      skillA: { name: skillA.name, description: skillA.description },
      skillB: { name: skillB.name, description: skillB.description },
      combinedName: planJson.combinedName || `${skillA.name}-${skillB.name}-fusion`,
      description: planJson.description || `Fusion of ${skillA.name} and ${skillB.name}`,
      synergy: planJson.synergy || 'Combined complementary skills',
      mergedSkillMd: planJson.mergedSkillMd || this._generateMergedSkillMd(skillA, skillB, planJson),
      mergedExecutor: planJson.mergedExecutor || `Orchestrates ${skillA.name} then ${skillB.name}`,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 执行~合：创建新组合技能，归档旧技?
   *
   * @param {object} plan - generateFusionPlan 的输?
   * @returns {{ success: boolean, newSkillName: string, newSkillPath: string, archivedPaths: string[] }}
   */
  executeFusion(plan) {
    this.initialize();

    const combinedName = plan.combinedName;
    const newSkillDir = path.join(this._skillsDir, combinedName);

    let finalName = combinedName;
    let finalDir = newSkillDir;
    let suffix = 1;
    while (fs.existsSync(finalDir)) {
      suffix++;
      finalName = `${combinedName}-${suffix}`;
      finalDir = path.join(this._skillsDir, finalName);
    }

    fs.mkdirSync(finalDir, { recursive: true });

    const skillMdContent = plan.mergedSkillMd
      || `# ${finalName}\n\n${plan.description}\n\nFusion of ${plan.skillA.name} + ${plan.skillB.name}`;
    fs.writeFileSync(path.join(finalDir, 'SKILL.md'), skillMdContent, 'utf-8');

    const meta = {
      name: finalName,
      version: '1.0.0',
      description: plan.description,
      sourceType: 'fusion',
      fusionParents: [plan.skillA.name, plan.skillB.name],
      createdAt: plan.createdAt || new Date().toISOString(),
    };
    fs.writeFileSync(path.join(finalDir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

    const archivedPaths = [];
    for (const parentName of [plan.skillA.name, plan.skillB.name]) {
      const oldDir = path.join(this._skillsDir, parentName);
      if (fs.existsSync(oldDir)) {
        const archivedDir = path.join(this._skillsDir, `.archived-${parentName}`);
        try {
          if (fs.existsSync(archivedDir)) {
            fs.rmSync(archivedDir, { recursive: true, force: true });
          }
          fs.renameSync(oldDir, archivedDir);
          archivedPaths.push(archivedDir);
        } catch (e) {

          // 归档失败则保?

          console.warn('[skill-fusion-engine.js] 空 catch 补日志:', e && e.message);
        }

      }
    }

    this._recordLineage(finalName, plan.skillA.name, plan.skillB.name, plan);

    const record = {
      id: `fusion-${Date.now()}`,
      timestamp: new Date().toISOString(),
      combinedName: finalName,
      parents: [plan.skillA.name, plan.skillB.name],
      description: plan.description,
      synergy: plan.synergy,
      score: plan.score || null,
      newSkillPath: finalDir,
      archivedPaths,
    };
    this._history.push(record);
    this._saveHistory();

    return {
      success: true,
      newSkillName: finalName,
      newSkillPath: finalDir,
      archivedPaths,
      record,
    };
  }

  /**
   * 获取~合建议
   * @param {number} limit
   * @returns {Array<{skillA: string, skillB: string, score: number, reason: string}>}
   */
  getFusionSuggestions(limit = 10) {
    this.initialize();

    const skillsList = this._collectInstalledSkills();
    if (skillsList.length < 2) return [];

    const candidates = this.analyzeFusionCandidates(skillsList);

    return candidates.slice(0, limit).map(c => ({
      skillA: c.skillA,
      skillB: c.skillB,
      score: c.score,
      reason: this._buildReasonString(c.signals),
      signals: c.signals,
    }));
  }

  /**
   * 获取~合历史
   */
  getFusionHistory() {
    this.initialize();
    return [...this._history];
  }

  // ========================= 内部方法 =========================

  _pairKey(a, b) {
    return a < b ? `${a}|||${b}` : `${b}|||${a}`;
  }

  _unpairKey(key) {
    return key.split('|||');
  }

  _tokenize(text) {
    if (!text) return new Set();
    const tokens = text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
    return new Set(tokens);
  }

  _jaccardSimilarity(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  _readSkillMd(skill) {
    if (!skill) return '';
    const skillMdPath = skill.skillMdPath
      || path.join(this._skillsDir, skill.name, 'SKILL.md');
    try {
      if (fs.existsSync(skillMdPath)) {
        return fs.readFileSync(skillMdPath, 'utf-8');
      }
    } catch (e) {
      /* ignore */
      console.warn('[skill-fusion-engine.js] 空 catch 补日志:', e && e.message);
    }

    return '';
  }

  _extractJson(text) {
      try {
      return JSON.parse(text);
      } catch (e) {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
      try { return JSON.parse(match[0]); } catch (e2) {
        /* ignore */
        console.warn('[skill-fusion-engine.js] 空 catch 补日志:', e2 && e2.message);
      }
      }
      }

    return {};
  }

  _generateBasicPlan(skillA, skillB) {
    return {
      combinedName: `${skillA.name}-${skillB.name}-fusion`,
      description: `Combined skill: ${skillA.description || skillA.name} + ${skillB.description || skillB.name}`,
      synergy: `${skillA.name} and ${skillB.name} are frequently used together`,
    };
  }

  _generateMergedSkillMd(skillA, skillB, plan) {
    const contentA = this._readSkillMd(skillA);
    const contentB = this._readSkillMd(skillB);
    return `# ${plan.combinedName}\n\n## Description\n${plan.description}\n\n## Synergy\n${plan.synergy}\n\n## Source A: ${skillA.name}\n${contentA.slice(0, 1500)}\n\n## Source B: ${skillB.name}\n${contentB.slice(0, 1500)}\n`;
  }

  _collectInstalledSkills() {
    const skills = [];
    if (!fs.existsSync(this._skillsDir)) return skills;

    try {
      const entries = fs.readdirSync(this._skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.archived-')) continue;

        const skillDir = path.join(this._skillsDir, entry.name);
        const skillMdPath = path.join(skillDir, 'SKILL.md');
        let description = '';

        if (fs.existsSync(skillMdPath)) {
          try {
            const content = fs.readFileSync(skillMdPath, 'utf-8');
            const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (fm) {
              const lines = fm[1].split('\n');
              for (const line of lines) {
                const ci = line.indexOf(':');
                if (ci > 0) {
                  const key = line.slice(0, ci).trim();
                  const val = line.slice(ci + 1).trim().replace(/^["']|["']$/g, '');
                  if (key === 'description') description = val;
                }
              }
            }
          } catch (e) { /* ignore */ }
        }

        skills.push({ name: entry.name, description, skillMdPath });
      }
    } catch (e) { /* ignore */ }

    return skills;
  }

  _wasAlreadyFused(skillA, skillB) {
    for (const record of this._history) {
      const parents = record.parents || [];
      if (parents.includes(skillA) && parents.includes(skillB)) return true;
    }
    return false;
  }

  _buildReasonString(signals) {
    const parts = [];
    if (signals.cooccurrenceCount > 0) {
      parts.push(`frequently used together (${signals.cooccurrenceCount}x)`);
    }
    if (signals.jaccardSimilarity > 0.15) {
      parts.push(`similar descriptions (${(signals.jaccardSimilarity * 100).toFixed(0)}% overlap)`);
    }
    if (parts.length === 0) {
      parts.push('potential complementary skills');
    }
    return parts.join('; ');
  }

  _recordLineage(newSkill, parentA, parentB, plan) {
    const lineagePath = path.join(this._skillsDir, newSkill, '_lineage.json');
    try {
      const lineage = {
        skill: newSkill,
        derivesFrom: [parentA, parentB],
        fusionPlan: { synergy: plan.synergy, description: plan.description },
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(lineagePath, JSON.stringify(lineage, null, 2), 'utf-8');
    } catch (e) { /* ignore */ }
  }

  _loadHistory() {
    try {
      if (fs.existsSync(this._fusionHistoryFile)) {
        const data = JSON.parse(fs.readFileSync(this._fusionHistoryFile, 'utf-8'));
        this._history = Array.isArray(data) ? data : (data.history || []);
      }
    } catch (e) {
      this._history = [];
    }
  }

  _saveHistory() {
    try {
      if (!fs.existsSync(this._fusionDir)) {
        fs.mkdirSync(this._fusionDir, { recursive: true });
      }
      const tmpFile = this._fusionHistoryFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this._history, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this._fusionHistoryFile);
    } catch (e) {
      console.error('[FusionEngine] Failed to save history:', e.message);
    }
  }

  shutdown() {
    // no-op
  }
}

let _instance = null;

function getSkillFusionEngine(config) {
  if (!_instance) {
    _instance = new SkillFusionEngine(config);
  }
  return _instance;
}

module.exports = { SkillFusionEngine, getSkillFusionEngine };
