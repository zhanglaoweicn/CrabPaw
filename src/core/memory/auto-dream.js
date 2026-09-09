const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const {
  PromptFingerprint,
  ToolOptimizer,
  TaskProgressTracker,
  SmartDreamScheduler,
  DreamReplay,
} = require('../../services');
const { MemoryArchiver, MEMORY_LAYERS: _MEMORY_LAYERS } = require('./memory-archiver');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('../config');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const DREAM_FILE = path.join(MEMORY_DIR, 'dream.json');
const LOCK_FILE = path.join(MEMORY_DIR, '.dream-lock');

const AUTO_DREAM_CONFIG = {
  minHours: 24,
  minSessions: 5
};

function resolveLLMCall() {
  try {
    const { getAuxiliaryClient } = require('../auxiliary-client');
    const client = getAuxiliaryClient();
    if (client && typeof client.chat === 'function') {
      return async (prompt, text) => {
        const result = await client.chat([
          { role: 'system', content: prompt },
          { role: 'user', content: text },
        ], { maxTokens: 200, temperature: 0.1 });
        return result?.content || result;
      };
    }
  } catch (e) {
    /* fallback to regex */
    console.warn('[auto-dream.js] 空 catch 补日志:', e && e.message);
  }


  try {
    const ai = require('../ai');
    if (ai && typeof ai.chat === 'function') {
      return async (prompt, text) => {
        // 2026-08-17 根因修复: silent 模式——提取 prompt 不得作为 user 消息写入
        // 主对话历史（此前每次对话后提取都污染历史 → 模型把用户消息当提取任务
        // → "```json\n[]\n```…不提取" 驴唇不对马嘴）。
        return await ai.chat(
          { models: { currentProvider: 'deepseek' } },
          [],
          'memory-extractor',
          `${prompt}\n\nUser messages:\n${text}`,
          { silent: true }
        );
      };
    }
  } catch (e) {
    /* fallback to regex */
    console.warn('[auto-dream.js] 空 catch 补日志:', e && e.message);
  }


  return null;
}

class AutoDream extends EventEmitter {
  constructor(autoMemory) {
    super();
    this.autoMemory = autoMemory;
    this.dreaming = false;
    this.lastDreamTime = 0;
    this.dreamInterval = AUTO_DREAM_CONFIG.minHours * 60 * 60 * 1000;
    this.minSessions = AUTO_DREAM_CONFIG.minSessions;
    this.minHours = AUTO_DREAM_CONFIG.minHours;
    this.dreamResults = null;
    this.timer = null;
    this.sessionCount = 0;
    this.lockAcquired = false;

    this.fingerprint = new PromptFingerprint();
    this.toolOptimizer = new ToolOptimizer();
    this.progressTracker = new TaskProgressTracker();
    this.scheduler = new SmartDreamScheduler();
    this.replay = new DreamReplay();
    this.archiver = new MemoryArchiver(MEMORY_DIR);

    this._setupEventForwarding();
  }

  _setupEventForwarding() {
    this.progressTracker.on('task:milestone', (data) => {
      this.emit('dream:milestone', data);
    });

    this.progressTracker.on('task:progress', (data) => {
      this.emit('dream:progress', data);
    });

    this.scheduler.on('dream:recorded', (data) => {
      this.emit('dream:recorded', data);
    });
  }

  start() {
    console.log("[memory system]");
    
    this.timer = setInterval(() => {
      this.checkAndDream();
    }, 60 * 60 * 1000);
    
    this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  incrementSessionCount() {
    this.sessionCount++;
  }

  async checkAndDream() {
    if (this.dreaming) return;

    const context = {
      idleTime: Date.now() - this.lastDreamTime,
      memoryUsage: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
      completedSessions: this.sessionCount,
      tokensUsed: this._estimateTokensUsed(),
    };

    const decision = this.scheduler.shouldDream(context);

    if (!decision) {
      return;
    }

    if (!await this._tryAcquireLock()) {
      console.log("[dream] Lock occupied, skipping");
      return;
    }

    console.log(`[memory-system] dream triggered: ${decision.reason}`);
    await this.dream();
  }

  _estimateTokensUsed() {
    return this.progressTracker.getStats().totalMilestones * 1000;
  }

  async _tryAcquireLock() {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const lockContent = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
        const lockTime = parseInt(lockContent);
        
        if (Date.now() - lockTime < 60 * 60 * 1000) {
          return false;
        }
      }
      
      fs.writeFileSync(LOCK_FILE, String(Date.now()));
      this.lockAcquired = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  async _releaseLock() {
    try {
      if (this.lockAcquired && fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
        this.lockAcquired = false;
      }
    } catch (e) {

      // ignore

      console.warn('[auto-dream.js] 空 catch 补日志:', e && e.message);
    }

  }

  async dream() {
    if (this.dreaming) return;
    
    this.dreaming = true;
    this.lastDreamTime = Date.now();
    this.sessionCount = 0;
    
    const taskId = `dream_${Date.now()}`;
    this.progressTracker.createTask(taskId, {
      startTime: Date.now(),
      type: 'auto_dream'
    });
    this.progressTracker.startTask(taskId);
    
    console.log("[memory system]");
    this.emit('dream:start');

    try {
      this.progressTracker.updateProgress(taskId, 10, 'phase:orient');

      const sessions = await this._collectSessions();
      console.log("[dream] processing...");
      
      await this.replay.saveSnapshot('orient', { sessions });

      const memories = Array.from(this.autoMemory.memories.values());
      console.log("[dream] processing...");

      this.progressTracker.updateProgress(taskId, 30, 'phase:gather');

      const gatheredInfo = await this._gatherSignal(sessions, memories);
      console.log("[dream] processing...");

      await this.replay.saveSnapshot('gather', { gatheredInfo });

      this.progressTracker.updateProgress(taskId, 60, 'phase:consolidate');

      const results = await this._consolidate(gatheredInfo, memories);
      console.log("[dream] processing...");

      await this.replay.saveSnapshot('consolidate', { results });

      this.progressTracker.updateProgress(taskId, 80, 'phase:prune');

      await this._prune(results);
      console.log('[memory-system] Phase 4 — Prune: complete');

      await this.replay.saveSnapshot('prune', { pruned: true });

      await this._storeResults(results, gatheredInfo);
      console.log("[dream] processing...");

      this.dreamResults = results;
      
      this.progressTracker.updateProgress(taskId, 100, 'complete');
      this.progressTracker.completeTask(taskId, { duration: Date.now() - this.lastDreamTime });
      
      this.scheduler.recordDream({
        strategy: 'auto',
        duration: Date.now() - this.lastDreamTime,
        memoriesProcessed: memories.length,
        tokensSaved: this._calculateTokensSaved(),
        success: true,
      });
      
      this.emit('dream:complete', results);
      
      console.log("[memory system]");
      
      return results;
    } catch (e) {
      console.error("[dream] error in processing");
      this.progressTracker.failTask(taskId, e);
      this.scheduler.recordDream({
        strategy: 'auto',
        success: false,
        error: e.message,
      });
      this.emit('dream:error', e);
      return null;
    } finally {
      this.dreaming = false;
      await this._releaseLock();
    }
  }

  async _collectSessions() {
    const sessions = [];
    
    if (!fs.existsSync(SESSIONS_DIR)) {
      return sessions;
    }

    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .slice(-50);

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8');
        const session = JSON.parse(content);
        sessions.push(session);
      } catch (e) {

        // skip invalid sessions

        console.warn('[auto-dream.js] 空 catch 补日志:', e && e.message);
      }

    }

    return sessions;
  }

  async _gatherSignal(sessions, memories) {
    const gathered = [];
    
    for (const session of sessions) {
      if (session.messages) {
        for (const msg of session.messages) {
          if (msg.role === 'user' && msg.content) {
            gathered.push({
              type: 'user_message',
              content: msg.content.slice(0, 500),
              timestamp: msg.timestamp
            });
          }
        }
      }
    }

    for (const memory of memories) {
      gathered.push({
        type: 'existing_memory',
        id: memory.id,
        title: memory.title || 'Untitled',
        content: memory.content.slice(0, 500),
        memoryType: memory.type
      });
    }

    return gathered;
  }

  async _consolidate(gatheredInfo, memories) {
    const insights = [];
    const associations = [];
    let llmConsolidated = 0;

    const typeCount = {};
    for (const info of gatheredInfo) {
      if (info.memoryType) {
        typeCount[info.memoryType] = (typeCount[info.memoryType] || 0) + 1;
      }
    }
    for (const [type, count] of Object.entries(typeCount)) {
      if (count > 3) {
        insights.push({
          type: 'pattern',
          content: `发现 ${count} 条类型为 ${type} 的记忆可能需要整合`,
          topics: [type],
          importance: 0.7,
        });
      }
    }

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const commonTags = memories[i].tags.filter(t => memories[j].tags.includes(t));
        if (commonTags.length > 0) {
          associations.push({
            from: memories[i].id, to: memories[j].id, commonTags,
          });
        }
      }
    }

    // 话题聚类（LLM 蒸馏之前，纯确定性 v1）
    try {
      const { TopicIndex } = require("./topic-index");
      const idx = new TopicIndex();
      const cluster = idx.indexMemories(memories.map((m) => ({ id: m.id, content: m.content })));
      if (cluster.topics.length > 0) {
        const topicsDir = DATA_DIR;
        if (!fs.existsSync(topicsDir)) fs.mkdirSync(topicsDir, { recursive: true });
        // 持久化话题（含记忆内容，供 SmartLoader Step 6 重建 tokens）
        const topicsWithMemories = cluster.topics.map(t => ({
          id: t.id,
          title: t.title,
          memoryIds: t.memoryIds,
          memories: t.memoryIds.map(mid => {
            const mem = memories.find(m => m.id === mid);
            return mem ? { id: mem.id, content: mem.content || "" } : null;
          }).filter(Boolean),
        }));
        fs.writeFileSync(path.join(topicsDir, "topics.json"), JSON.stringify(topicsWithMemories, null, 2), "utf8");
      }
    } catch (e) {
      console.warn("[auto-dream] 话题聚类失败:", e.message || e);
    }
    const llmCall = resolveLLMCall();
    if (llmCall && memories.length >= 10) {
      try {
        const memoryTexts = memories.slice(0, 30).map(m =>
          `[${m.type || 'general'}] ${(m.title || '').slice(0, 60)}: ${(m.content || '').slice(0, 150)}`
        ).join('\n');

        const distillPrompt = `You are a memory consolidation engine. Given these raw memories, identify:
1. REDUNDANT — 2+ memories saying the same thing (merge them)
2. CONTRADICT — 2 memories that conflict
3. DISTILL — a memory that can be summarized into a shorter, clearer form
4. INSIGHT — a pattern that emerges across multiple memories

Return JSON: {"redundant":[{"ids":[],"merged":"..."}],"contradicts":[{"a":"id","b":"id","reason":"..."}],"distill":[{"id":"...","shortened":"..."}],"insights":[{"content":"...","confidence":0.5}]}
Only return findings you are confident about. Empty arrays if nothing found.`;

        const response = await llmCall(distillPrompt, memoryTexts);
        const text = typeof response === 'string' ? response : (response?.content || response?.text || '');
        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        try {
          const parsed = JSON.parse(cleaned);
          if (parsed.redundant?.length > 0) {
            insights.push({
              type: 'redundant',
              content: `发现 ${parsed.redundant.length} 组重复记忆可合并`,
              details: parsed.redundant,
              importance: 0.8,
            });
            llmConsolidated += parsed.redundant.length;
          }
          if (parsed.contradicts?.length > 0) {
            insights.push({
              type: 'contradiction',
              content: `发现 ${parsed.contradicts.length} 组矛盾记忆`,
              details: parsed.contradicts,
              importance: 0.9,
            });
            llmConsolidated += parsed.contradicts.length;
          }
          if (parsed.insights?.length > 0) {
            for (const ins of parsed.insights) {
              insights.push({
                type: 'insight',
                content: ins.content,
                confidence: ins.confidence || 0.5,
                importance: 0.6,
              });
              llmConsolidated++;
            }
          }
        } catch (parseErr) {

          // JSON 解析失败不影响基础统计

          console.warn('[auto-dream.js] 空 catch 补日志:', parseErr && parseErr.message);
        }

      } catch (e) {
        console.debug('[dream] LLM distillation skipped:', e.message);
      }
    }

    return {
      insights,
      associations,
      consolidated: insights.length + associations.length,
      llmConsolidated,
      stats: {
        sessionsProcessed: gatheredInfo.filter(i => i.type === 'user_message').length,
        memoriesReviewed: memories.length,
        insightsGenerated: insights.length,
        associationsFound: associations.length,
        llmDistilled: llmConsolidated,
      },
      timestamp: Date.now(),
    };
  }

  async _prune(_results) {
    console.log("[memory system]");
    
    const archiveResults = await this.archiver.runArchiveCycle();
    
    const staleMemories = [];
    for (const [id, memory] of this.autoMemory.memories) {
      const age = Date.now() - memory.updated;
      if (age > 365 * 24 * 60 * 60 * 1000) {
        staleMemories.push(id);
      }
    }

    for (const id of staleMemories) {
      const mem = this.autoMemory.memories.get(id);
      if (mem) {
        mem.status = 'archived';
        mem.archivedAt = Date.now();
        console.log(`[dream] 归档旧记忆: ${id}`);
      }
    }

    if (staleMemories.length > 0) {
      await this.autoMemory.save();
    }

    const archiveStats = this.archiver.getArchiveStats();
    console.log(`[memory-system] archive stats — hot:${archiveStats.hot.count} warm:${archiveStats.warm.count} cold:${archiveStats.cold.count}`);

    return {
      deletedCount: staleMemories.length,
      archivedToWarm: archiveResults.toWarm.length,
      archivedToCold: archiveResults.toCold.length,
      errors: archiveResults.errors,
    };
  }

  async _storeResults(results, gatheredInfo = []) {
    await this.autoMemory._ensureDir();

    fs.writeFileSync(DREAM_FILE, JSON.stringify(results, null, 2), 'utf-8');

    // SP1 源头门控：原始 user message 不再以 type:'session' 直写笔记本（主 gate 也一律拒）。
    // 语义裁定：AutoDream 源头只写 insight 类——本实现无 insight 蒸馏分流，按裁定跳过写，
    // 梦境结果仅保留 dream.json / SQLite 通道。若未来加 insight 分流，仅 insight 类可走 addMemory。
    if (gatheredInfo && gatheredInfo.length > 0) {
      console.debug('[memory-gate] AutoDream 源头: user message 不直写笔记本, 仅保留 dream.json 通道');
    }
  }

  _extractTopicTags(content) {
    const tags = [];
    const lower = content.toLowerCase();
    const chineseKeywords = [
      ['opc', 'OPC'], ['\u4E00\u4EBA\u516C\u53F8', '\u4E00\u4EBA\u516C\u53F8'], ['ai', 'AI'], ['\u667A\u80FD\u4F53', '\u667A\u80FD\u4F53'],
      ['\u4EE3\u7801', '\u7F16\u7A0B'], ['\u5929\u6C14', '\u5929\u6C14'], ['\u80A1\u7968', '\u80A1\u5E02'], ['\u8BBE\u8BA1', '\u8BBE\u8BA1'],
      ['\u6570\u636E\u5E93', '\u6570\u636E\u5E93'], ['api', 'API'], ['\u90E8\u7F72', '\u90E8\u7F72'], ['\u6D4B\u8BD5', '\u6D4B\u8BD5'],
      ['\u5FAE\u4FE1', '\u5FAE\u4FE1'], ['\u4F01\u4E1A\u5FAE\u4FE1', '\u4F01\u5FAE'], ['\u98DE\u4E66', '\u98DE\u4E66'],
      ['\u6587\u6863', '\u6587\u6863'], ['\u5DE5\u5177', '\u5DE5\u5177'], ['\u5DE5\u4F5C\u6D41', '\u5DE5\u4F5C\u6D41'],
      ['\u8BB0\u5FC6', '\u8BB0\u5FC6'], ['\u4F1A\u8BDD', '\u5BF9\u8BDD'], ['\u6280\u80FD', '\u6280\u80FD'],
      ['deepseek', 'DeepSeek'], ['minimax', 'MiniMax'], ['openai', 'OpenAI'],
      ['\u6D77\u62A5', '\u6D77\u62A5'], ['\u7AEF\u5348', '\u7AEF\u5348\u8282'],
    ];
    
    for (const [keyword, tag] of chineseKeywords) {
      if (lower.includes(keyword) || content.includes(keyword)) {
        if (!tags.includes(tag)) tags.push(tag);
        if (tags.length >= 3) break;
      }
    }
    
    if (tags.length === 0) tags.push('\u901A\u7528');
    return tags;
  }

  getStats() {
    const baseStats = {
      dreaming: this.dreaming,
      lastDreamTime: this.lastDreamTime,
      nextDreamTime: this.lastDreamTime + this.dreamInterval,
      sessionCount: this.sessionCount,
      hasResults: this.dreamResults !== null,
      config: {
        minHours: this.minHours,
        minSessions: this.minSessions
      }
    };

    const enhancedStats = {
      fingerprint: this.fingerprint.getCacheStats(),
      toolOptimizer: this.toolOptimizer.getStats(),
      progressTracker: this.progressTracker.getStats(),
      scheduler: this.scheduler.getStats(),
      replay: this.replay.getStats(),
    };

    return { ...baseStats, enhanced: enhancedStats };
  }

  _calculateTokensSaved() {
    const fingerprintStats = this.fingerprint.getCacheStats();
    const toolStats = this.toolOptimizer.getStats();
    
    return fingerprintStats.totalTokensSaved + toolStats.totalUses * 50;
  }

  async rollback(phase) {
    const snapshots = this.replay.getSnapshotsByPhase(phase);
    if (snapshots.length === 0) {
      return null;
    }
    return this.replay.restoreSnapshot(snapshots[snapshots.length - 1].id);
  }
}

module.exports = { AutoDream, AUTO_DREAM_CONFIG, resolveLLMCall };
