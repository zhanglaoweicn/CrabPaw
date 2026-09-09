/**
 * Memory Snapshot — 记忆冻结快照注入
 *
 * - 会话开始时将精选记忆以冻结块注入系统提示
 * - 严格字符限制，强制聚焦高信息密度
 * - 双文件角色分离：AGENT.md（环境/经验）+ USER.md（用户偏好）
 * - 容量使用率感知，支持主动合并
 * - 保留 LLM 前缀缓存（会话中不更新冻结快照）
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');
const { atomicWriteJSON, atomicWriteFile } = require('../atomic-write');

const SNAPSHOT_DIR = path.join(DATA_DIR, 'memory-snapshot');
const AGENT_MEMORY_FILE = path.join(SNAPSHOT_DIR, 'AGENT.md');
const USER_MEMORY_FILE = path.join(SNAPSHOT_DIR, 'USER.md');
const SNAPSHOT_META_FILE = path.join(SNAPSHOT_DIR, 'snapshot-meta.json');

// 字符限制
const AGENT_MEMORY_LIMIT = 2200;   // Agent 记忆上限
const USER_MEMORY_LIMIT = 1375;    // 用户记忆上限
const MERGE_THRESHOLD = 0.8;       // 80% 使用率触发主动合并

const DEFAULT_CONFIG = {
  agentMemoryLimit: AGENT_MEMORY_LIMIT,
  userMemoryLimit: USER_MEMORY_LIMIT,
  mergeThreshold: MERGE_THRESHOLD,
  autoSave: true,
  securityScan: true,
};

class MemorySnapshot extends EventEmitter {
  constructor(config = {}) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._snapshotDir = config.snapshotDir || SNAPSHOT_DIR;
    this._agentFile = config.agentFile || AGENT_MEMORY_FILE;
    this._userFile = config.userFile || USER_MEMORY_FILE;
    this._metaFile = config.metaFile || SNAPSHOT_META_FILE;

    // 运行时状态
    this._agentMemory = '';
    this._userMemory = '';
    this._frozenBlock = null;       // 冻结快照（会话开始时生成，会话中不更新）
    this._frozenAt = null;
    this._dirty = false;            // 是否有未持久化的修改

    this._loadFromDisk();
  }

  // ── 冻结快照接口 ──

  /**
   * 生成冻结快照，注入系统提示
   * 会话开始时调用一次，之后不再更新（保留前缀缓存）
   */
  freeze() {
    const agentSection = this._formatSection('AGENT', this._agentMemory, this._config.agentMemoryLimit);
    const userSection = this._formatSection('USER', this._userMemory, this._config.userMemoryLimit);

    this._frozenBlock = `§${agentSection}§${userSection}§`;
    this._frozenAt = Date.now();

    this.emit('snapshot:frozen', {
      agentUsage: this.getAgentUsage(),
      userUsage: this.getUserUsage(),
      totalChars: this._frozenBlock.length,
    });

    return this._frozenBlock;
  }

  /**
   * 获取当前冻结快照（不重新生成）
   */
  getFrozenBlock() {
    return this._frozenBlock;
  }

  /**
   * 解冻（会话结束时调用，将运行时修改持久化到磁盘）
   */
  unfreeze() {
    if (this._dirty) {
      this._saveToDisk();
      this._dirty = false;
    }
    this._frozenBlock = null;
    this._frozenAt = null;
  }

  // ── 记忆读写接口 ──

  /**
   * 添加 Agent 记忆条目
   * @returns {{ ok: boolean, usage: number, error?: string }}
   */
  addAgentMemory(entry) {
    if (!entry || typeof entry !== 'string') {
      return { ok: false, usage: this.getAgentUsage(), error: 'empty entry' };
    }

    const newContent = this._agentMemory
      ? `${this._agentMemory}\n- ${entry}`
      : `- ${entry}`;

    if (newContent.length > this._config.agentMemoryLimit) {
      const usage = newContent.length / this._config.agentMemoryLimit;
      if (usage >= 1.0) {
        return {
          ok: false,
          usage,
          error: 'AGENT memory full — merge or remove existing entries first',
          currentEntries: this._parseEntries(this._agentMemory),
        };
      }
    }

    this._agentMemory = newContent;
    this._dirty = true;

    const usage = this.getAgentUsage();
    this.emit('memory:added', { type: 'agent', entry, usage });

    if (usage >= this._config.mergeThreshold) {
      this.emit('memory:merge-needed', { type: 'agent', usage });
    }

    return { ok: true, usage };
  }

  /**
   * 添加用户记忆条目
   */
  addUserMemory(entry) {
    if (!entry || typeof entry !== 'string') {
      return { ok: false, usage: this.getUserUsage(), error: 'empty entry' };
    }

    const newContent = this._userMemory
      ? `${this._userMemory}\n- ${entry}`
      : `- ${entry}`;

    if (newContent.length > this._config.userMemoryLimit) {
      const usage = newContent.length / this._config.userMemoryLimit;
      if (usage >= 1.0) {
        return {
          ok: false,
          usage,
          error: 'USER memory full — merge or remove existing entries first',
          currentEntries: this._parseEntries(this._userMemory),
        };
      }
    }

    this._userMemory = newContent;
    this._dirty = true;

    const usage = this.getUserUsage();
    this.emit('memory:added', { type: 'user', entry, usage });

    if (usage >= this._config.mergeThreshold) {
      this.emit('memory:merge-needed', { type: 'user', usage });
    }

    return { ok: true, usage };
  }

  /**
   * 子字符串匹配替换
   */
  replaceAgentMemory(oldStr, newStr) {
    if (!this._agentMemory.includes(oldStr)) {
      return { ok: false, error: 'substring not found' };
    }
    this._agentMemory = this._agentMemory.replace(oldStr, newStr);
    this._dirty = true;
    return { ok: true, usage: this.getAgentUsage() };
  }

  replaceUserMemory(oldStr, newStr) {
    if (!this._userMemory.includes(oldStr)) {
      return { ok: false, error: 'substring not found' };
    }
    this._userMemory = this._userMemory.replace(oldStr, newStr);
    this._dirty = true;
    return { ok: true, usage: this.getUserUsage() };
  }

  /**
   * 子字符串匹配删除
   */
  removeAgentMemory(oldStr) {
    return this.replaceAgentMemory(oldStr, '');
  }

  removeUserMemory(oldStr) {
    return this.replaceUserMemory(oldStr, '');
  }

  // ── 主动合并接口 ──

  /**
   * 合并指定类型的记忆条目
   * 将多个相关条目压缩为一个，释放容量
   * @param {'agent'|'user'} type
   * @param {string[]} entriesToMerge - 要合并的条目文本
   * @param {string} mergedContent - 合并后的内容
   */
  mergeEntries(type, entriesToMerge, mergedContent) {
    const memory = type === 'agent' ? this._agentMemory : this._userMemory;
    let newMemory = memory;

    // 移除被合并的条目
    for (const entry of entriesToMerge) {
      newMemory = newMemory.replace(`- ${entry}`, '');
    }
    // 清理空行
    newMemory = newMemory.replace(/\n{2,}/g, '\n').trim();

    // 添加合并后的内容
    if (mergedContent) {
      newMemory = newMemory
        ? `${newMemory}\n- ${mergedContent}`
        : `- ${mergedContent}`;
    }

    if (type === 'agent') {
      this._agentMemory = newMemory;
    } else {
      this._userMemory = newMemory;
    }
    this._dirty = true;

    const usage = type === 'agent' ? this.getAgentUsage() : this.getUserUsage();
    this.emit('memory:merged', { type, mergedCount: entriesToMerge.length, usage });

    return { ok: true, usage };
  }

  /**
   * 自动合并：找到同主题的条目并合并
   * 需要外部 LLM 支持来生成合并内容
   */
  // eslint-disable-next-line no-unused-vars
  async autoMerge(type, options = {}) {
    const memory = type === 'agent' ? this._agentMemory : this._userMemory;
    const entries = this._parseEntries(memory);

    if (entries.length < 2) {
      return { ok: false, reason: 'not enough entries to merge' };
    }

    // 简单策略：按关键词分组，同组条目可合并
    const groups = this._groupByKeywords(entries);
    let mergedCount = 0;

    for (const [keyword, group] of Object.entries(groups)) {
      if (group.length < 2) continue;
      if (type === 'agent' ? this.getAgentUsage() < this._config.mergeThreshold
                          : this.getUserUsage() < this._config.mergeThreshold) {
        break; // 容量够用就不再合并
      }

      const mergedContent = `[${keyword}] ${group.map(e => e.trim()).join('; ')}`;
      this.mergeEntries(type, group, mergedContent);
      mergedCount += group.length;
    }

    return { ok: true, mergedCount, usage: type === 'agent' ? this.getAgentUsage() : this.getUserUsage() };
  }

  // ── 使用率接口 ──

  getAgentUsage() {
    return this._agentMemory.length / this._config.agentMemoryLimit;
  }

  getUserUsage() {
    return this._userMemory.length / this._config.userMemoryLimit;
  }

  /**
   * 获取 Agent 记忆原始内容（公共 getter）
   */
  getAgentMemory() {
    return this._agentMemory || '';
  }

  /**
   * 获取用户记忆原始内容（公共 getter）
   */
  getUserMemory() {
    return this._userMemory || '';
  }

  /**
   * 获取解析后的条目数组（前端友好格式）
   */
  getAgentEntries() {
    return this._parseEntries(this._agentMemory);
  }

  getUserEntries() {
    return this._parseEntries(this._userMemory);
  }

  getUsageReport() {
    return {
      agent: {
        chars: this._agentMemory.length,
        limit: this._config.agentMemoryLimit,
        usage: this.getAgentUsage(),
        entries: this._parseEntries(this._agentMemory).length,
        needsMerge: this.getAgentUsage() >= this._config.mergeThreshold,
      },
      user: {
        chars: this._userMemory.length,
        limit: this._config.userMemoryLimit,
        usage: this.getUserUsage(),
        entries: this._parseEntries(this._userMemory).length,
        needsMerge: this.getUserUsage() >= this._config.mergeThreshold,
      },
      frozen: this._frozenBlock !== null,
      frozenAt: this._frozenAt,
    };
  }

  // ── 系统提示注入 ──

  /**
   * 生成用于系统提示的记忆块
   * 包含使用率百分比，让 Agent 感知容量压力
   */
  getSystemPromptBlock() {
    if (!this._frozenBlock) {
      this.freeze();
    }

    const report = this.getUsageReport();
    const agentPct = Math.round(report.agent.usage * 100);
    const userPct = Math.round(report.user.usage * 100);

    return `<memory-snapshot agent-usage="${agentPct}%" user-usage="${userPct}%">\n${this._frozenBlock}\n</memory-snapshot>`;
  }

  // ── 持久化 ──

  _loadFromDisk() {
    try {
      if (fs.existsSync(this._agentFile)) {
        this._agentMemory = fs.readFileSync(this._agentFile, 'utf-8').trim();
      }
      if (fs.existsSync(this._userFile)) {
        this._userMemory = fs.readFileSync(this._userFile, 'utf-8').trim();
      }
    } catch (e) {

      // 首次运行，文件不存在

      console.warn('[memory-snapshot.js] 空 catch 补日志:', e && e.message);
    }

  }

  _saveToDisk() {
    try {
      if (!fs.existsSync(this._snapshotDir)) {
        fs.mkdirSync(this._snapshotDir, { recursive: true });
      }
      if (this._agentMemory) {
        atomicWriteFile(this._agentFile, this._agentMemory);
      }
      if (this._userMemory) {
        atomicWriteFile(this._userFile, this._userMemory);
      }
      // 保存元数据
      const meta = {
        lastSaved: Date.now(),
        agentChars: this._agentMemory.length,
        userChars: this._userMemory.length,
      };
      atomicWriteJSON(this._metaFile, meta);
    } catch (e) {
      this.emit('snapshot:error', { operation: 'save', error: e.message });
    }
  }

  // ── 内部工具 ──

  _formatSection(label, content, limit) {
    const usage = content.length / limit;
    const pct = Math.round(usage * 100);
    const header = `[${label} MEMORY — ${pct}% used]`;
    if (!content) return header;
    return `${header}\n${content}`;
  }

  _parseEntries(memory) {
    if (!memory) return [];
    return memory.split('\n')
      .filter(line => line.trim().startsWith('-'))
      .map(line => line.replace(/^-\s*/, ''));
  }

  _groupByKeywords(entries) {
    const groups = {};
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', 'the', 'a', 'is', 'and', 'to', 'of']);

    for (const entry of entries) {
      const words = entry.split(/[\s,，。.、；;：:]+/)
        .filter(w => w.length >= 2 && !stopWords.has(w.toLowerCase()));
      for (const word of words.slice(0, 3)) { // 只取前 3 个关键词
        if (!groups[word]) groups[word] = [];
        groups[word].push(entry);
      }
    }

    // 只保留有 2+ 条目的组
    for (const key of Object.keys(groups)) {
      if (groups[key].length < 2) delete groups[key];
    }

    return groups;
  }

  // ── 生命周期 ──

  shutdown() {
    if (this._dirty) {
      this._saveToDisk();
    }
  }
}

// 单例
let _instance = null;

function getMemorySnapshot(config) {
  if (!_instance) {
    _instance = new MemorySnapshot(config);
  }
  return _instance;
}

module.exports = {
  MemorySnapshot,
  getMemorySnapshot,
  AGENT_MEMORY_LIMIT,
  USER_MEMORY_LIMIT,
  MERGE_THRESHOLD,
};
