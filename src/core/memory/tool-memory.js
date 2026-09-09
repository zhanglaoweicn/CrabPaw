const crypto = require('crypto');
const { EventEmitter } = require('events');

const PRIORITY_LEVELS = { critical: 3, high: 2, normal: 1 };
const SOURCE_TYPES = ['user_explicit', 'post_turn', 'programmatic'];
const TOOL_MEMORY_PROMPT_CAP = 30;
const TOOL_MEMORY_HEADING = '## Tool Memory Rules';

function toolMemoryNamespace(toolName) {
  return `tool-${toolName}`;
}

class ToolMemoryRule {
  constructor(opts = {}) {
    this.id = opts.id || `tmr_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.toolName = opts.toolName || '';
    this.rule = opts.rule || '';
    this.priority = opts.priority || 'normal';
    this.source = opts.source || 'programmatic';
    this.tags = opts.tags || [];
    this.createdAt = opts.createdAt || new Date().toISOString();
    this.updatedAt = opts.updatedAt || new Date().toISOString();
  }

  get priorityValue() {
    return PRIORITY_LEVELS[this.priority] || 1;
  }

  toJSON() {
    return {
      id: this.id,
      toolName: this.toolName,
      rule: this.rule,
      priority: this.priority,
      source: this.source,
      tags: this.tags,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static fromJSON(data) {
    return new ToolMemoryRule(data);
  }
}

class ToolMemoryStore extends EventEmitter {
  constructor(unifiedStore) {
    super();
    this._store = unifiedStore;
    this._cache = new Map();
  }

  putRule(rule) {
    if (!(rule instanceof ToolMemoryRule)) {
      rule = new ToolMemoryRule(rule);
    }
    rule.updatedAt = new Date().toISOString();

    if (this._store && typeof this._store.addToolMemory === 'function') {
      this._store.addToolMemory({
        id: rule.id,
        tool_name: rule.toolName,
        content: rule.rule,
        priority: rule.priority,
        source: rule.source,
        metadata: { tags: rule.tags, namespace: toolMemoryNamespace(rule.toolName) },
      });
    }

    const cacheKey = `${rule.toolName}:${rule.id}`;
    this._cache.set(cacheKey, rule);
    this.emit('rule:put', { id: rule.id, toolName: rule.toolName, priority: rule.priority });
    return rule;
  }

  getRule(toolName, ruleId) {
    const cacheKey = `${toolName}:${ruleId}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    if (this._store && typeof this._store.getToolMemory === 'function') {
      const row = this._store.getToolMemory(ruleId);
      if (row) {
        const rule = new ToolMemoryRule({
          id: row.id,
          toolName: row.tool_name,
          rule: row.rule,
          priority: row.priority,
          source: row.source,
          tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
        this._cache.set(cacheKey, rule);
        return rule;
      }
    }
    return null;
  }

  listRules(toolName) {
    const rules = [];

    // eslint-disable-next-line no-unused-vars
    for (const [key, rule] of this._cache) {
      if (rule.toolName === toolName) {
        rules.push(rule);
      }
    }

    if (this._store && typeof this._store.listToolMemory === 'function') {
      const rows = this._store.listToolMemory(toolName);
      for (const row of rows) {
        const cacheKey = `${row.tool_name}:${row.id}`;
        if (!this._cache.has(cacheKey)) {
          const rule = new ToolMemoryRule({
            id: row.id,
            toolName: row.tool_name,
            rule: row.rule,
            priority: row.priority,
            source: row.source,
            tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          });
          this._cache.set(cacheKey, rule);
          rules.push(rule);
        }
      }
    }

    return rules.sort((a, b) => b.priorityValue - a.priorityValue);
  }

  deleteRule(toolName, ruleId) {
    const cacheKey = `${toolName}:${ruleId}`;
    this._cache.delete(cacheKey);

    if (this._store && typeof this._store.deleteToolMemory === 'function') {
      this._store.deleteToolMemory(ruleId);
    }

    this.emit('rule:deleted', { id: ruleId, toolName });
    return true;
  }

  rulesForPrompt(toolNames = []) {
    const allRules = [];

    if (toolNames.length === 0) {
      // eslint-disable-next-line no-unused-vars
      for (const [key, rule] of this._cache) {
        if (rule.priority === 'critical' || rule.priority === 'high') {
          allRules.push(rule);
        }
      }

      if (this._store && typeof this._store.listToolMemory === 'function') {
        const rows = this._store.listToolMemory();
        for (const row of rows) {
          if (row.priority === 'critical' || row.priority === 'high') {
            const cacheKey = `${row.tool_name}:${row.id}`;
            if (!this._cache.has(cacheKey)) {
              allRules.push(new ToolMemoryRule({
                id: row.id,
                toolName: row.tool_name,
                rule: row.rule,
                priority: row.priority,
                source: row.source,
                tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
                createdAt: row.created_at,
                updatedAt: row.updated_at,
              }));
            }
          }
        }
      }
    } else {
      for (const toolName of toolNames) {
        const rules = this.listRules(toolName);
        for (const rule of rules) {
          if (rule.priority === 'critical' || rule.priority === 'high') {
            allRules.push(rule);
          }
        }
      }
    }

    allRules.sort((a, b) => {
      if (a.priorityValue !== b.priorityValue) return b.priorityValue - a.priorityValue;
      if (a.toolName !== b.toolName) return a.toolName.localeCompare(b.toolName);
      return a.rule.localeCompare(b.rule);
    });

    const capped = allRules.slice(0, TOOL_MEMORY_PROMPT_CAP);
    return {
      rendered: renderToolMemoryRules(capped),
      rules: capped,
    };
  }

  listToolNames() {
    const names = new Set();
    // eslint-disable-next-line no-unused-vars
    for (const [key, rule] of this._cache) {
      names.add(rule.toolName);
    }
    return Array.from(names).sort();
  }

  record(toolName, ruleText, opts = {}) {
    return this.putRule(new ToolMemoryRule({
      toolName,
      rule: ruleText,
      priority: opts.priority || 'normal',
      source: opts.source || 'programmatic',
      tags: opts.tags || [],
    }));
  }
}

function renderToolMemoryRules(rules) {
  if (!rules || rules.length === 0) return '';

  const lines = [TOOL_MEMORY_HEADING, ''];
  let currentTool = null;

  for (const rule of rules) {
    if (rule.toolName !== currentTool) {
      if (currentTool !== null) lines.push('');
      lines.push(`### ${rule.toolName}`);
      currentTool = rule.toolName;
    }
    const priorityTag = rule.priority === 'critical' ? ' [CRITICAL]' : rule.priority === 'high' ? ' [HIGH]' : '';
    lines.push(`- ${rule.rule}${priorityTag}`);
  }

  return lines.join('\n');
}

class ToolMemoryCaptureHook {
  constructor(store) {
    this._store = store;
    this._failureCounts = new Map();
    this._failureThreshold = 3;
  }

  recordToolFailure(toolName, error) {
    const key = toolName;
    const count = (this._failureCounts.get(key) || 0) + 1;
    this._failureCounts.set(key, count);

    if (count >= this._failureThreshold) {
      this._store.record(toolName, `Tool ${toolName} has failed ${count} times. Last error: ${(error || '').slice(0, 200)}`, {
        priority: 'high',
        source: 'post_turn',
        tags: ['auto-captured', 'failure-pattern'],
      });
      this._failureCounts.delete(key);
    }
  }

  recordUserEdict(toolName, edict) {
    this._store.record(toolName, edict, {
      priority: 'critical',
      source: 'user_explicit',
      tags: ['user-edict'],
    });
  }

  reset() {
    this._failureCounts.clear();
  }
}

module.exports = {
  ToolMemoryRule,
  ToolMemoryStore,
  ToolMemoryCaptureHook,
  toolMemoryNamespace,
  renderToolMemoryRules,
  PRIORITY_LEVELS,
  SOURCE_TYPES,
  TOOL_MEMORY_PROMPT_CAP,
  TOOL_MEMORY_HEADING,
};
