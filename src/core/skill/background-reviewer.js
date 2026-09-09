/**
 * Background Reviewer - 后台回顾增强模块
 * 
 * 功能：
 * - 会话结束后的自动回顾
 * - 技能使用模式分析
 * - 优化建议生成
 * - 自动提炼可复用流程
 * - 与记忆系统集成
 */

const fs = require('fs');
const path = require('path');
// BUG FIX: enhanced-skill-creator 已删除（死代码清理），改用活的 skill-editor
const { createSkill } = require('../skill-editor');
const { getCrabPawSubDir } = require('../path-utils');

const MIN_SESSION_LENGTH = 5;
const MIN_PATTERN_FREQUENCY = 2;

class BackgroundReviewer {
  constructor(config = {}) {
    this.config = {
      minSessionLength: config.minSessionLength || MIN_SESSION_LENGTH,
      minPatternFrequency: config.minPatternFrequency || MIN_PATTERN_FREQUENCY,
      autoCreateSkills: config.autoCreateSkills !== false,
      dataDir: config.dataDir || getCrabPawSubDir('data'),
      ...config,
    };

    this._reviewsPath = path.join(this.config.dataDir, 'reviews');
    this._patternsPath = path.join(this.config.dataDir, 'patterns.json');

    this._ensureDirs();
    this._patterns = this._loadPatterns();
  }

  _ensureDirs() {
    if (!fs.existsSync(this._reviewsPath)) {
      fs.mkdirSync(this._reviewsPath, { recursive: true });
    }
  }

  _loadPatterns() {
    if (fs.existsSync(this._patternsPath)) {
      try {
        return JSON.parse(fs.readFileSync(this._patternsPath, 'utf-8'));
      } catch (e) {
        return { toolSequences: {}, errorPatterns: {}, successPatterns: {} };
      }
    }
    return { toolSequences: {}, errorPatterns: {}, successPatterns: {} };
  }

  _savePatterns() {
    fs.writeFileSync(this._patternsPath, JSON.stringify(this._patterns, null, 2));
  }

  async reviewSession(sessionId, conversationHistory, metadata = {}) {
    if (conversationHistory.length < this.config.minSessionLength) {
      console.log(`会话长度不足 (${conversationHistory.length}/${this.config.minSessionLength})，跳过回顾`);
      return null;
    }

    const review = {
      sessionId,
      timestamp: new Date().toISOString(),
      metadata,
      analysis: {},
      recommendations: [],
      skillCandidates: [],
    };

    const toolCalls = this._extractToolCalls(conversationHistory);
    review.analysis.toolCalls = {
      total: toolCalls.length,
      unique: [...new Set(toolCalls.map(t => t.tool))].length,
      sequence: toolCalls.map(t => t.tool),
    };

    this._updatePatterns(toolCalls);

    const sequences = this._findRepeatingSequences(toolCalls);
    if (sequences.length > 0) {
      review.analysis.repeatingSequences = sequences;
      review.recommendations.push({
        type: 'automation',
        message: `发现 ${sequences.length} 个重复操作序列，建议创建技能自动化`,
        sequences: sequences.map(s => s.sequence),
      });
    }

    const errors = this._extractErrors(conversationHistory);
    if (errors.length > 0) {
      review.analysis.errors = errors;
      review.recommendations.push({
        type: 'error_handling',
        message: `发现 ${errors.length} 个错误，建议添加错误处理`,
        errors: errors.map(e => e.message),
      });
    }

    const skillCandidates = this._identifySkillCandidates(toolCalls, sequences);
    review.skillCandidates = skillCandidates;

    if (this.config.autoCreateSkills && skillCandidates.length > 0) {
      for (const candidate of skillCandidates.filter(c => c.priority === 'high')) {
        try {
          const result = await createSkill({
            name: candidate.name,
            description: candidate.description,
            category: 'general',
          });
          review.createdSkills = review.createdSkills || [];
          if (result.success) {
            review.createdSkills.push(result.skillName);
          } else {
            console.warn(`创建技能失败: ${result.error}`);
          }
        } catch (e) {
          console.warn(`创建技能失败: ${e.message}`);
        }
      }
    }

    const reviewPath = path.join(this._reviewsPath, `${sessionId}.json`);
    fs.writeFileSync(reviewPath, JSON.stringify(review, null, 2));

    console.log(`📋 会话回顾完成: ${sessionId}`);
    return review;
  }

  _extractToolCalls(history) {
    const calls = [];
    for (const msg of history) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const call of msg.tool_calls) {
          calls.push({
            tool: call.function.name,
            params: JSON.parse(call.function.arguments || '{}'),
            timestamp: msg.timestamp || Date.now(),
          });
        }
      }
    }
    return calls;
  }

  _updatePatterns(toolCalls) {
    const sequence = toolCalls.map(t => t.tool).join(' -> ');
    this._patterns.toolSequences[sequence] = (this._patterns.toolSequences[sequence] || 0) + 1;
    this._savePatterns();
  }

  _findRepeatingSequences(toolCalls) {
    const sequences = [];
    const toolNames = toolCalls.map(t => t.tool);

    for (let len = 2; len <= Math.min(5, toolNames.length / 2); len++) {
      for (let i = 0; i <= toolNames.length - len * 2; i++) {
        const seq1 = toolNames.slice(i, i + len).join(' -> ');
        for (let j = i + len; j <= toolNames.length - len; j++) {
          const seq2 = toolNames.slice(j, j + len).join(' -> ');
          if (seq1 === seq2) {
            const existing = sequences.find(s => s.sequence === seq1);
            if (existing) {
              existing.count++;
            } else {
              sequences.push({
                sequence: seq1,
                count: 2,
                positions: [i, j],
              });
            }
          }
        }
      }
    }

    return sequences.filter(s => s.count >= this.config.minPatternFrequency);
  }

  _extractErrors(history) {
    const errors = [];
    for (const msg of history) {
      if (msg.role === 'tool' && msg.content) {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (content.includes('error') || content.includes('Error') || content.includes('失败')) {
          errors.push({
            message: content.slice(0, 200),
            timestamp: msg.timestamp,
          });
        }
      }
    }
    return errors;
  }

  _identifySkillCandidates(toolCalls, sequences) {
    const candidates = [];

    for (const seq of sequences) {
      const tools = seq.sequence.split(' -> ');
      const steps = tools.map((tool, i) => ({
        skill: tool,
        input: '',
        outputKey: `result_${i + 1}`,
        description: `执行 ${tool}`,
      }));

      candidates.push({
        name: this._generateSkillName(tools),
        description: `自动识别的重复流程: ${seq.sequence}`,
        steps,
        priority: seq.count >= 3 ? 'high' : 'medium',
        frequency: seq.count,
      });
    }

    const uniqueTools = [...new Set(toolCalls.map(t => t.tool))];
    if (uniqueTools.length >= 3 && toolCalls.length >= 5) {
      const highFreqTools = uniqueTools
        .map(tool => ({
          tool,
          count: toolCalls.filter(t => t.tool === tool).length,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);

      if (!candidates.some(c => c.name.includes('frequent'))) {
        candidates.push({
          name: `frequent-${highFreqTools[0].tool}-workflow`,
          description: `高频工具组合: ${highFreqTools.map(t => t.tool).join(', ')}`,
          steps: highFreqTools.map((t, i) => ({
            skill: t.tool,
            input: '',
            outputKey: `result_${i + 1}`,
            description: `执行 ${t.tool} (使用${t.count}次)`,
          })),
          priority: 'low',
        });
      }
    }

    return candidates;
  }

  _generateSkillName(tools) {
    const uniqueTools = [...new Set(tools)];
    if (uniqueTools.length === 1) {
      return `${uniqueTools[0].toLowerCase()}-automation`;
    }
    return `${uniqueTools.slice(0, 2).join('-').toLowerCase()}-workflow`;
  }

  async analyzePatterns(timeRange = '7d') {
    const now = Date.now();
    const ranges = {
      '1d': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    };
    const cutoff = now - (ranges[timeRange] || ranges['7d']);

    const reviews = [];
    const files = fs.readdirSync(this._reviewsPath).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const review = JSON.parse(fs.readFileSync(path.join(this._reviewsPath, file), 'utf-8'));
        if (new Date(review.timestamp).getTime() > cutoff) {
          reviews.push(review);
        }
      } catch (e) {
        console.warn('读取审查记录失败:', file, e.message);
      }
    }

    const analysis = {
      timeRange,
      totalSessions: reviews.length,
      totalToolCalls: 0,
      toolUsage: {},
      repeatingPatterns: [],
      topErrors: [],
      skillCreationRate: 0,
    };

    for (const review of reviews) {
      if (review.analysis?.toolCalls) {
        analysis.totalToolCalls += review.analysis.toolCalls.total;
        for (const tool of review.analysis.toolCalls.sequence) {
          analysis.toolUsage[tool] = (analysis.toolUsage[tool] || 0) + 1;
        }
      }

      if (review.analysis?.repeatingSequences) {
        for (const seq of review.analysis.repeatingSequences) {
          const existing = analysis.repeatingPatterns.find(p => p.sequence === seq.sequence);
          if (existing) {
            existing.sessions++;
          } else {
            analysis.repeatingPatterns.push({
              sequence: seq.sequence,
              sessions: 1,
            });
          }
        }
      }

      if (review.analysis?.errors) {
        for (const error of review.analysis.errors) {
          const existing = analysis.topErrors.find(e => e.message === error.message);
          if (existing) {
            existing.count++;
          } else {
            analysis.topErrors.push({
              message: error.message,
              count: 1,
            });
          }
        }
      }
    }

    analysis.toolUsage = Object.entries(analysis.toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {});

    analysis.repeatingPatterns.sort((a, b) => b.sessions - a.sessions);
    analysis.topErrors.sort((a, b) => b.count - a.count);

    const createdCount = reviews.filter(r => r.createdSkills?.length > 0).length;
    analysis.skillCreationRate = reviews.length > 0 ? createdCount / reviews.length : 0;

    return analysis;
  }

  async generateOptimizationReport(timeRange = '7d') {
    const analysis = await this.analyzePatterns(timeRange);

    const lines = [];
    lines.push('# 技能优化报告');
    lines.push('');
    lines.push(`生成时间: ${new Date().toISOString()}`);
    lines.push(`分析范围: ${timeRange}`);
    lines.push('');

    lines.push('## 概览');
    lines.push('');
    lines.push(`- 分析会话数: ${analysis.totalSessions}`);
    lines.push(`- 工具调用总数: ${analysis.totalToolCalls}`);
    lines.push(`- 技能创建率: ${(analysis.skillCreationRate * 100).toFixed(1)}%`);
    lines.push('');

    lines.push('## 工具使用排行');
    lines.push('');
    for (const [tool, count] of Object.entries(analysis.toolUsage)) {
      lines.push(`- ${tool}: ${count} 次`);
    }
    lines.push('');

    if (analysis.repeatingPatterns.length > 0) {
      lines.push('## 重复模式');
      lines.push('');
      for (const pattern of analysis.repeatingPatterns.slice(0, 5)) {
        lines.push(`- ${pattern.sequence} (${pattern.sessions} 个会话)`);
      }
      lines.push('');
    }

    if (analysis.topErrors.length > 0) {
      lines.push('## 常见错误');
      lines.push('');
      for (const error of analysis.topErrors.slice(0, 5)) {
        lines.push(`- ${error.message.slice(0, 100)}... (${error.count} 次)`);
      }
      lines.push('');
    }

    lines.push('## 建议');
    lines.push('');
    if (analysis.repeatingPatterns.length > 0) {
      lines.push('1. 考虑为高频重复模式创建自动化技能');
    }
    if (analysis.topErrors.length > 0) {
      lines.push('2. 针对常见错误添加错误处理机制');
    }
    if (analysis.skillCreationRate < 0.1) {
      lines.push('3. 技能创建率较低，建议检查自动创建配置');
    }

    return lines.join('\n');
  }

  getReviewHistory(limit = 10) {
    const files = fs.readdirSync(this._reviewsPath)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        const statA = fs.statSync(path.join(this._reviewsPath, a));
        const statB = fs.statSync(path.join(this._reviewsPath, b));
        return statB.mtimeMs - statA.mtimeMs;
      })
      .slice(0, limit);

    return files.map(file => {
      try {
        return JSON.parse(fs.readFileSync(path.join(this._reviewsPath, file), 'utf-8'));
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
  }
}

module.exports = BackgroundReviewer;
