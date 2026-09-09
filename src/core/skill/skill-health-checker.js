/**
 * Skill Health Checker — 技能健康检查
 *
 * 参考 ECC skill-evolution/health.js 模式，为 CrabPaw 提供：
 * - 过期检测：技能长时间未使用
 * - 冲突检测：功能重叠的技能
 * - 冗余检测：内容高度相似的技能
 * - 依赖缺失检测：技能依赖的工具/包不可用
 * - 健康报告：汇总所有问题并给出建议
 */



const { getQualityTracker } = require('./skill-quality-tracker');

const STALE_DAYS = 30;         // 超过 30 天未使用视为过期
const SIMILARITY_THRESHOLD = 0.7;  // 描述相似度阈值

class SkillHealthChecker {
  constructor(config = {}) {
    this.staleDays = config.staleDays || STALE_DAYS;
    this.similarityThreshold = config.similarityThreshold || SIMILARITY_THRESHOLD;
  }

  /**
   * 对技能列表执行全面健康检查
   * @param {Array} skills - loadSkills() 返回的技能列表
   * @param {Array} availableToolNames - 当前可用的工具名列表
   * @returns {Object} 健康报告
   */
  check(skills, availableToolNames = []) {
    const issues = [];
    const toolSet = new Set(availableToolNames);

    for (const skill of skills) {
      // 1. 过期检测
      const staleness = this._checkStaleness(skill);
      if (staleness) issues.push(staleness);

      // 2. 依赖缺失检测
      const depIssue = this._checkDependencies(skill, toolSet);
      if (depIssue) issues.push(depIssue);
    }

    // 3. 冲突/冗余检测（需要两两比较）
    const overlapIssues = this._checkOverlaps(skills);
    issues.push(...overlapIssues);

    // 汇总
    const summary = {
      totalSkills: skills.length,
      healthy: skills.length - new Set(issues.map(i => i.skillName)).size,
      issues: issues.length,
      bySeverity: {
        critical: issues.filter(i => i.severity === 'critical').length,
        warning: issues.filter(i => i.severity === 'warning').length,
        info: issues.filter(i => i.severity === 'info').length,
      },
      byType: {},
      details: issues,
    };

    for (const issue of issues) {
      summary.byType[issue.type] = (summary.byType[issue.type] || 0) + 1;
    }

    return summary;
  }

  /**
   * 过期检测：技能长时间未使用
   */
  _checkStaleness(skill) {
    try {
      const tracker = getQualityTracker();
      const stats = tracker.getStats(skill.name);
      if (!stats || stats.totalCalls === 0) {
        // 从未使用过的技能，检查创建时间
        const firstSeen = stats?.firstSeen;
        if (firstSeen) {
          const daysSinceCreation = (Date.now() - new Date(firstSeen).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceCreation > this.staleDays) {
            return {
              skillName: skill.name,
              type: 'stale',
              severity: 'info',
              message: `技能 ${skill.name} 创建 ${Math.round(daysSinceCreation)} 天以来从未被使用`,
              suggestion: '考虑移除或归档此技能',
            };
          }
        }
        return null;
      }

      const lastUpdated = stats.lastUpdated;
      if (!lastUpdated) return null;

      const daysSinceUse = (Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUse > this.staleDays) {
        return {
          skillName: skill.name,
          type: 'stale',
          severity: 'warning',
          message: `技能 ${skill.name} 已 ${Math.round(daysSinceUse)} 天未使用`,
          suggestion: '考虑移除或降低优先级',
        };
      }
    } catch (e) {
      /* QualityTracker 不可用时静默降级 */
      console.warn('[skill-health-checker.js] 空 catch 补日志:', e && e.message);
    }

    return null;
  }

  /**
   * 依赖缺失检测：技能依赖的工具不可用
   */
  _checkDependencies(skill, toolSet) {
    const requiresTools = skill.requiresTools || skill.allowedTools || [];
    if (requiresTools.length === 0) return null;

    const missing = requiresTools.filter(t => !toolSet.has(t));
    if (missing.length > 0) {
      return {
        skillName: skill.name,
        type: 'missing_dependency',
        severity: missing.length === requiresTools.length ? 'critical' : 'warning',
        message: `技能 ${skill.name} 依赖的工具不可用: ${missing.join(', ')}`,
        suggestion: missing.length === requiresTools.length
          ? '所有依赖工具均不可用，此技能无法执行'
          : `部分依赖工具不可用，功能可能受限`,
      };
    }
    return null;
  }

  /**
   * 冲突/冗余检测：功能重叠的技能
   */
  _checkOverlaps(skills) {
    const issues = [];
    const checked = new Set();

    for (let i = 0; i < skills.length; i++) {
      for (let j = i + 1; j < skills.length; j++) {
        const pairKey = [skills[i].name, skills[j].name].sort().join('::');
        if (checked.has(pairKey)) continue;
        checked.add(pairKey);

        const similarity = this._computeSimilarity(skills[i], skills[j]);
        if (similarity >= this.similarityThreshold) {
          issues.push({
            skillName: skills[i].name,
            type: 'overlap',
            severity: 'info',
            message: `技能 ${skills[i].name} 与 ${skills[j].name} 功能重叠 (相似度: ${(similarity * 100).toFixed(0)}%)`,
            suggestion: '考虑合并或明确区分职责',
            relatedSkill: skills[j].name,
          });
        }
      }
    }
    return issues;
  }

  /**
   * 计算两个技能的相似度（基于描述和名称的关键词重叠）
   */
  _computeSimilarity(a, b) {
    const tokensA = this._tokenize(a.name + ' ' + (a.description || ''));
    const tokensB = this._tokenize(b.name + ' ' + (b.description || ''));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.min(tokensA.size, tokensB.size);
  }

  /**
   * 简单分词：按空格/连字符/下划线拆分，转小写
   */
  _tokenize(text) {
    return new Set(
      text.toLowerCase()
        .replace(/[-_]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2)  // 忽略过短的词
    );
  }

  /**
   * 生成人类可读的健康报告
   */
  formatReport(report) {
    const lines = [];
    lines.push('📊 技能健康报告');
    lines.push(`总计: ${report.totalSkills} 个技能, ${report.healthy} 个健康, ${report.issues} 个问题`);
    lines.push('');

    if (report.bySeverity.critical > 0) {
      lines.push(`🚨 严重: ${report.bySeverity.critical} 个`);
      for (const d of report.details.filter(d => d.severity === 'critical')) {
        lines.push(`   - ${d.skillName}: ${d.message}`);
      }
      lines.push('');
    }

    if (report.bySeverity.warning > 0) {
      lines.push(`⚠️ 警告: ${report.bySeverity.warning} 个`);
      for (const d of report.details.filter(d => d.severity === 'warning')) {
        lines.push(`   - ${d.skillName}: ${d.message}`);
      }
      lines.push('');
    }

    if (report.bySeverity.info > 0) {
      lines.push(`ℹ️ 建议: ${report.bySeverity.info} 个`);
      for (const d of report.details.filter(d => d.severity === 'info')) {
        lines.push(`   - ${d.skillName}: ${d.message}`);
      }
    }

    return lines.join('\n');
  }
}

let _instance = null;
function getSkillHealthChecker() {
  if (!_instance) _instance = new SkillHealthChecker();
  return _instance;
}

module.exports = { SkillHealthChecker, getSkillHealthChecker };
