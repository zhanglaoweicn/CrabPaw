/**
 * Directive API — 用户自定义硬规则系统
 *
 * 参考 Hindsight 的 Directive 机制：
 * - 用户定义的不可违反的硬规则
 * - 规则注入到系统提示词中，确保 LLM 始终遵守
 * - 支持规则的增删改查和优先级排序
 * - 规则变更审计日志
 *
 * 使用方式：
 *   const { getDirectiveManager } = require('./directive-manager');
 *   const dm = getDirectiveManager();
 *   dm.initialize();
 *   dm.addDirective('永远不要删除用户文件');
 *   dm.addDirective('回复时必须使用中文', { priority: 10 });
 *   const prompt = dm.buildDirectivePrompt();
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
// eslint-disable-next-line no-unused-vars -- AUDIT_EVENTS 导入未使用，仅用 logAuditEvent
const { logAuditEvent, AUDIT_EVENTS } = require('./audit-log');

const DIRECTIVE_DIR = path.join(DATA_DIR, 'directives');
const DIRECTIVES_FILE = path.join(DIRECTIVE_DIR, 'directives.json');

const PRIORITY = {
  CRITICAL: 100,  // 不可违反
  HIGH: 80,       // 强烈建议
  MEDIUM: 50,     // 默认优先级
  LOW: 20,        // 软建议
};

class Directive {
  constructor(data = {}) {
    this.id = data.id || `dir_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.content = data.content || '';       // 规则内容
    this.priority = data.priority ?? PRIORITY.MEDIUM;
    this.category = data.category || 'general'; // general / security / style / behavior / domain
    this.active = data.active !== false;
    this.createdAt = data.createdAt || Date.now();
    this.updatedAt = data.updatedAt || Date.now();
    this.createdBy = data.createdBy || 'user'; // user / system / evolution
    this.tags = data.tags || [];
    this.metadata = data.metadata || {};
  }

  toJSON() {
    return {
      id: this.id,
      content: this.content,
      priority: this.priority,
      category: this.category,
      active: this.active,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      createdBy: this.createdBy,
      tags: this.tags,
      metadata: this.metadata,
    };
  }
}

class DirectiveManager extends EventEmitter {
  // eslint-disable-next-line no-unused-vars -- config 参数未使用，保留构造签名
  constructor(config = {}) {
    super();
    this._directives = new Map();
    this._initialized = false;
    this._cache = null; // 缓存生成的 prompt
    this._cacheValid = false;
  }

  initialize() {
    if (!fs.existsSync(DIRECTIVE_DIR)) {
      fs.mkdirSync(DIRECTIVE_DIR, { recursive: true });
    }
    this._loadData();
    this._initialized = true;
    console.log(`[DirectiveManager] 初始化完成, ${this._directives.size} 条规则`);
  }

  shutdown() {
    this._saveData();
    this._initialized = false;
  }

  /**
   * 添加硬规则
   */
  addDirective(content, opts = {}) {
    if (!content || typeof content !== 'string') {
      throw new Error('规则内容不能为空');
    }

    // 检查重复
    for (const d of this._directives.values()) {
      if (d.content.trim() === content.trim() && d.active) {
        return d.toJSON(); // 已存在相同规则
      }
    }

    const directive = new Directive({
      content,
      priority: opts.priority ?? PRIORITY.MEDIUM,
      category: opts.category || 'general',
      active: opts.active !== false,
      createdBy: opts.createdBy || 'user',
      tags: opts.tags || [],
      metadata: opts.metadata || {},
    });

    this._directives.set(directive.id, directive);
    this._invalidateCache();
    this._saveData();

    this.emit('directive:added', { id: directive.id, content: directive.content });
    try {
      logAuditEvent('directive_added', {
        directiveId: directive.id,
        content: directive.content.slice(0, 100),
        priority: directive.priority,
        category: directive.category,
      });
    } catch { console.warn('[directive-manager] 记录添加指令审计日志失败'); }

    return directive.toJSON();
  }

  /**
   * 更新硬规则
   */
  updateDirective(directiveId, updates = {}) {
    const directive = this._directives.get(directiveId);
    if (!directive) throw new Error(`规则不存在: ${directiveId}`);

    if (updates.content !== undefined) directive.content = updates.content;
    if (updates.priority !== undefined) directive.priority = updates.priority;
    if (updates.category !== undefined) directive.category = updates.category;
    if (updates.active !== undefined) directive.active = updates.active;
    if (updates.tags !== undefined) directive.tags = updates.tags;
    directive.updatedAt = Date.now();

    this._invalidateCache();
    this._saveData();

    this.emit('directive:updated', { id: directiveId });
    try {
      logAuditEvent('directive_updated', {
        directiveId,
        updates: Object.keys(updates),
      });
    } catch { console.warn('[directive-manager] 记录更新指令审计日志失败'); }

    return directive.toJSON();
  }

  /**
   * 删除硬规则
   */
  removeDirective(directiveId) {
    const directive = this._directives.get(directiveId);
    if (!directive) return false;

    this._directives.delete(directiveId);
    this._invalidateCache();
    this._saveData();

    this.emit('directive:removed', { id: directiveId });
    try {
      logAuditEvent('directive_removed', {
        directiveId,
        content: directive.content.slice(0, 100),
      });
    } catch { console.warn('[directive-manager] 记录删除指令审计日志失败'); }

    return true;
  }

  /**
   * 获取所有活跃规则（按优先级排序）
   */
  getActiveDirectives(category = null) {
    let directives = Array.from(this._directives.values())
      .filter(d => d.active);

    if (category) {
      directives = directives.filter(d => d.category === category);
    }

    return directives
      .sort((a, b) => b.priority - a.priority)
      .map(d => d.toJSON());
  }

  /**
   * 获取所有规则
   */
  getAllDirectives() {
    return Array.from(this._directives.values())
      .sort((a, b) => b.priority - a.priority)
      .map(d => d.toJSON());
  }

  /**
   * 构建注入到系统提示词的硬规则段落
   */
  buildDirectivePrompt() {
    if (this._cacheValid && this._cache) {
      return this._cache;
    }

    const activeDirectives = this.getActiveDirectives();

    if (activeDirectives.length === 0) {
      this._cache = '';
      this._cacheValid = true;
      return '';
    }

    const lines = [];
    lines.push('## 🛡️ 用户硬规则（必须遵守，不可违反）');
    lines.push('');

    // 按分类分组
    const grouped = new Map();
    for (const d of activeDirectives) {
      const cat = d.category || 'general';
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(d);
    }

    const categoryLabels = {
      security: '🔒 安全规则',
      style: '✍️ 风格规则',
      behavior: '🎯 行为规则',
      domain: '🌐 领域规则',
      general: '📋 通用规则',
    };

    for (const [category, directives] of grouped) {
      const label = categoryLabels[category] || `📋 ${category}`;
      lines.push(`### ${label}`);
      for (const d of directives) {
        const prefix = d.priority >= PRIORITY.CRITICAL ? '⛔' :
                       d.priority >= PRIORITY.HIGH ? '🔴' :
                       d.priority >= PRIORITY.MEDIUM ? '🟡' : '🟢';
        lines.push(`- ${prefix} ${d.content}`);
      }
      lines.push('');
    }

    lines.push('以上规则优先级高于任何其他指令，请严格遵守。');
    lines.push('');

    this._cache = lines.join('\n');
    this._cacheValid = true;
    return this._cache;
  }

  /**
   * 检查给定内容是否违反硬规则
   * 返回 { violated: boolean, violations: [...] }
   */
  checkViolation(content) {
    if (!content) return { violated: false, violations: [] };

    const activeDirectives = this.getActiveDirectives('security');
    const violations = [];

    for (const d of activeDirectives) {
      // 简单关键词匹配（可扩展为 LLM 判断）
      const keywords = this._extractKeywords(d.content);
      const contentLower = content.toLowerCase();

      for (const kw of keywords) {
        if (contentLower.includes(kw.toLowerCase())) {
          // 可能违反
          violations.push({
            directiveId: d.id,
            content: d.content,
            matchedKeyword: kw,
            priority: d.priority,
          });
          break;
        }
      }
    }

    return {
      violated: violations.length > 0,
      violations,
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const all = Array.from(this._directives.values());
    return {
      total: all.length,
      active: all.filter(d => d.active).length,
      byCategory: all.reduce((acc, d) => {
        acc[d.category] = (acc[d.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: all.reduce((acc, d) => {
        const level = d.priority >= PRIORITY.CRITICAL ? 'critical' :
                      d.priority >= PRIORITY.HIGH ? 'high' :
                      d.priority >= PRIORITY.MEDIUM ? 'medium' : 'low';
        acc[level] = (acc[level] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  // ===== 内部方法 =====

  _extractKeywords(ruleContent) {
    // 从规则内容中提取关键动词/名词
    const stopWords = new Set([
      '的', '了', '是', '在', '有', '和', '与', '或', '不', '要', '会', '能',
      '可以', '必须', '应该', '需要', '不要', '不能', '不可', '永远', '始终',
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'never', 'always', 'must', 'should', 'not',
    ]);

    return ruleContent
      .replace(/[，。！？、；：""''（）【】《》[\]{}]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w.toLowerCase()));
  }

  _invalidateCache() {
    this._cache = null;
    this._cacheValid = false;
  }

  _loadData() {
    try {
      if (fs.existsSync(DIRECTIVES_FILE)) {
        const data = JSON.parse(fs.readFileSync(DIRECTIVES_FILE, 'utf-8'));
        for (const d of data) {
          const directive = new Directive(d);
          this._directives.set(directive.id, directive);
        }
      }
    } catch (e) {
      console.warn('[DirectiveManager] 加载规则数据失败:', e.message);
    }
  }

  _saveData() {
    try {
      if (!fs.existsSync(DIRECTIVE_DIR)) {
        fs.mkdirSync(DIRECTIVE_DIR, { recursive: true });
      }
      const data = Array.from(this._directives.values()).map(d => d.toJSON());
      fs.writeFileSync(DIRECTIVES_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[DirectiveManager] 保存数据失败:', e.message);
    }
  }
}

// 单例
let _instance = null;

function getDirectiveManager(config) {
  if (!_instance) {
    _instance = new DirectiveManager(config);
  }
  return _instance;
}

module.exports = {
  DirectiveManager,
  Directive,
  PRIORITY,
  getDirectiveManager,
};
