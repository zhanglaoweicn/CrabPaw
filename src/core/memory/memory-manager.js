const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { memoryExtractionService } = require('../../services');
const { AutoMemory, MEMORY_TYPES: _MEMORY_TYPES } = require('./auto-memory');
const { AutoDream, resolveLLMCall } = require('./auto-dream');
const { SessionMemory } = require('./session-memory');
const { getSharedSessionPersistence } = require('./session-persistence');
const { getUnifiedStore } = require('./unified-store');
const { MemoryRelations } = require('./memory-relations');
// S4: 用户画像 facets 写入(StabilityDetector 状态机,此前完整实现但从未接线)
const { StabilityDetector, FACET_CLASSES, CUE_FAMILIES } = require('../learning/stability-detector');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('../config');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');

const MEMORY_SECTIONS = {
  USER_CONTEXT: 'user_context',
  CURRENT_FOCUS: 'current_focus',
  HISTORY: 'history',
  FACTS: 'facts',
};
const SECTION_DEFAULTS = {
  preference: 'user_context',
  fact: 'facts',
  project: 'current_focus',
  feedback: 'history',
  correction: 'history',
  intent: 'current_focus',
  note: 'facts',
};

class MemoryManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this._sessionFlushTimers = null;
    this.autoMemory = new AutoMemory();
    this.autoDream = new AutoDream(this.autoMemory);
    this.sessionPersistence = getSharedSessionPersistence();
    this.initialized = false;
    this.storageType = this._getStorageType();
    this.sqlite = null;
    this._currentUserId = 'default';
    this._enhancedMemory = null;
    this._heartbeatLoop = null;
    this._memoryArchiver = null;
    this._ftsSearch = null;
    this._memoryDecay = null;
    this._contextIntegrator = null;
    this._unifiedStore = null;
    this._providerManager = null;
    this._relations = new MemoryRelations();
    this._temporalGraph = null;
    this._extractionQueue = [];
    this._lastExtractionRun = 0;
    this._pendingFlags = [];
    // S4: 用户画像(StabilityDetector)——initialize() 时接线 unifiedStore
    this._stabilityDetector = null;
  }

  get unifiedStore() {
    if (!this._unifiedStore) {
      this._unifiedStore = getUnifiedStore();
    }
    return this._unifiedStore;
  }

  get temporalGraph() {
    if (!this._temporalGraph) {
      try {
        const { getTemporalGraph } = require('./temporal-graph');
        this._temporalGraph = getTemporalGraph();
      } catch (e) { console.warn('[memory-manager] temporalGraph 懒加载失败:', e.message); }
    }
    return this._temporalGraph;
  }

  get enhancedMemory() {
    if (!this._enhancedMemory) {
      try {
        const { EnhancedMemorySystem } = require('../memory');
        // 2026-08-31 Eval 隔离轮 Task 2：此前误传 memoryDir（EnhancedMemorySystem 只认
        // dataDir），配置被忽略 → 回落 CWD 相对 data/.crabpaw/memory 硬编码，
        // eval 的 addFact 因此写进真实 memory/memory.json(415MB) 而非隔离目录。
        this._enhancedMemory = new EnhancedMemorySystem({
          dataDir: MEMORY_DIR,
        });
      } catch (e) {
        console.warn("[dream] warning in processing");
      }
    }
    return this._enhancedMemory;
  }

  get heartbeatLoop() {
    if (!this._heartbeatLoop) {
      try {
        const { globalHeartbeatLoop } = require('./heartbeat-loop');
        this._heartbeatLoop = globalHeartbeatLoop;
        this._heartbeatLoop.setMemorySystem(this);
      } catch (e) {
        console.warn('[memory-manager] heartbeatLoop 懒加载失败:', e.message);
      }
    }
    return this._heartbeatLoop;
  }

  get memoryArchiver() {
    if (!this._memoryArchiver) {
      try {
        const { MemoryArchiver } = require('./memory-archiver');
        this._memoryArchiver = new MemoryArchiver(MEMORY_DIR);
      } catch (e) {
        console.warn('[memory-manager] memoryArchiver 懒加载失败:', e.message);
      }
    }
    return this._memoryArchiver;
  }

  get ftsSearch() {
    if (!this._ftsSearch) {
      try {
        this._ftsSearch = require('./fts-search');
      } catch (e) {
        console.warn('[memory-manager] ftsSearch 懒加载失败:', e.message);
      }
    }
    return this._ftsSearch;
  }

  get memoryDecay() {
    if (!this._memoryDecay) {
      try {
        const { MemoryDecayEngine } = require('./memory-decay');
        this._memoryDecay = new MemoryDecayEngine(this);
      } catch (e) {
        console.warn('[memory-manager] memoryDecay 懒加载失败:', e.message);
      }
    }
    return this._memoryDecay;
  }

  get contextIntegrator() {
    if (!this._contextIntegrator) {
      try {
        const { ContextIntegrator } = require('./context-integrator');
        this._contextIntegrator = new ContextIntegrator(this);
      } catch (e) {
        console.warn('[memory-manager] contextIntegrator 懒加载失败:', e.message);
      }
    }
    return this._contextIntegrator;
  }

  _getStorageType() {
    const configPath = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return config.memoryStorage || 'markdown';
      } catch (e) {
        return 'markdown';
      }
    }
    return 'markdown';
  }

  async initialize() {
    this._unifiedStore = getUnifiedStore();
    this.sqlite = this._unifiedStore;
    this.storageType = 'unified';

    // S4: 接线用户画像(StabilityDetector)——此前完整实现但从未实例化,
    // user_profile_facets 表恒 0 记录,context 注入恒走占位 fallback。
    try {
      this._stabilityDetector = new StabilityDetector();
      this._stabilityDetector.setStore(this._unifiedStore);
    } catch (e) {
      console.warn('[memory] StabilityDetector 初始化失败:', e.message);
      this._stabilityDetector = null;
    }

    await this.autoMemory.initialize();
    await this.sessionPersistence.initialize();
    this.autoDream.start();
    if (this.memoryDecay && typeof this.memoryDecay.start === 'function') {
      this.memoryDecay.start();
    }

    try {
      if (this.enhancedMemory) {
        await this.enhancedMemory.initialize();
        console.log("[memory system]");
      }
    } catch (e) {
      console.warn("[dream] warning in processing");
    }

    try {
      if (this.ftsSearch && typeof this.ftsSearch.initDatabase === 'function') {
        await this.ftsSearch.initDatabase();
        console.log("[dream] processing...");
      }
    } catch (e) {
      console.warn("[dream] warning in processing");
    }

    try {
      if (this.heartbeatLoop) {
        this.heartbeatLoop.start();
      }
    } catch (e) {
      console.warn("[dream] warning in processing");
    }

    try {
      if (this.memoryDecay && typeof this.memoryDecay.start === 'function') {
        this.memoryDecay.start();
      }
    } catch (e) {
      console.warn("[dream] warning in processing");
    }

    this.initialized = true;

    this._cleanupTimer = setInterval(() => this._cleanupExpiredSessions(), 60 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();

    console.log("[memory system]");
    this.emit('initialized');
  }

  getProviderManager() {
    return this._providerManager;
  }

  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this.autoDream && this.autoDream.stop) {
      this.autoDream.stop();
    }
    if (this._heartbeatLoop && typeof this._heartbeatLoop.stop === 'function') {
      this._heartbeatLoop.stop();
    }
    if (this._memoryArchiver && typeof this._memoryArchiver.stop === 'function') {
      this._memoryArchiver.stop();
    }
    if (this._memoryDecay && typeof this._memoryDecay.stop === 'function') {
      this._memoryDecay.stop();
    }
    if (this._sessionFlushTimers) {
      for (const t of this._sessionFlushTimers.values()) clearTimeout(t);
      this._sessionFlushTimers.clear();
    }
    // eslint-disable-next-line no-unused-vars
    for (const [id, session] of this.sessions) {
      try {
        this._saveSession(session);
      } catch (e) {
        console.error("[dream] error in processing");
      }
    }
    if (this._unifiedStore && typeof this._unifiedStore.close === 'function') {
      this._unifiedStore.close();
    }
    if (this._providerManager && typeof this._providerManager.shutdownAll === 'function') {
      this._providerManager.shutdownAll();
    }
    console.log("[memory-system] shutdown complete");
  }

  async _cleanupExpiredSessions() {
    for (const [id, session] of this.sessions) {
      if (session.isExpired()) {
        await this._saveSession(session);
        this.sessions.delete(id);
        this.autoDream.incrementSessionCount();
        console.log(`[memory-system] memory archived: ${id}`);
      }
    }
  }

  async _saveSession(session, userId = null) {
    await this.sessionPersistence.saveSession(
      session.sessionId,
      session.export(),
      userId || this._currentUserId
    );
  }

  /**
   * 2026-08-14 数据链审计 C2: 运行期防抖落盘(1.5s)——写入后 sess_* 文件及时跟进,
   * 历史列表/详情不再读到空快照;同一会话连续消息只排队一次,导出时自然含全部最新。
   */
  _scheduleSessionFlush(session, userId = null) {
    if (!this._sessionFlushTimers) this._sessionFlushTimers = new Map();
    const sid = session.sessionId;
    if (this._sessionFlushTimers.has(sid)) return;
    const timer = setTimeout(async () => {
      this._sessionFlushTimers.delete(sid);
      try {
        await this._saveSession(session, userId);
      } catch (e) {
        console.warn('[memory-system] 会话落盘失败:', e?.message || e);
      }
    }, 1500);
    if (timer.unref) timer.unref();
    this._sessionFlushTimers.set(sid, timer);
  }

  /**
   * 2026-08-14 数据链审计 I3: 显式落盘入口——幽灵清理检查等场景按需刷新磁盘。
   */
  async flushSession(sessionId, userId = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await this._saveSession(session, userId);
    return true;
  }

  async _ensureDir() {
    if (!fs.existsSync(SESSIONS_DIR)) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }
  }

  getSession(sessionId) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new SessionMemory(sessionId));
    }
    return this.sessions.get(sessionId);
  }

  async getOrCreateSession(sessionId, userId = null) {
    const uid = userId || this._currentUserId;

    if (!this.sessions.has(sessionId)) {
      const savedSession = await this.sessionPersistence.loadSession(sessionId);

      if (savedSession) {
        const session = new SessionMemory(sessionId);
        session.messages = savedSession.messages || [];
        session.sections = savedSession.sections || session.sections;
        session.context = savedSession.context || {};
        session.createdAt = savedSession.createdAt || Date.now();
        session.tokenCount = savedSession.tokenCount || 0;
        this.sessions.set(sessionId, session);

        await this.sessionPersistence.updateSessionAccess(sessionId, uid);
        console.log(`[memory-system] session continued: ${sessionId}`);
      } else {
        this.sessions.set(sessionId, new SessionMemory(sessionId));
        await this.sessionPersistence.registerSession(sessionId, uid);
        console.log(`[memory-system] session continued: ${sessionId}`);
      }
    }

    return this.sessions.get(sessionId);
  }

  setCurrentUser(userId) {
    this._currentUserId = userId;
  }

  async continueLastSession(timeExpression = 'yesterday', userId = null) {
    const uid = userId || this._currentUserId;
    const result = await this.sessionPersistence.continueLastSession(uid, timeExpression);

    if (!result) {
      return null;
    }

    const { sessionId, session, meta } = result;

    if (session && !this.sessions.has(sessionId)) {
      const restoredSession = new SessionMemory(sessionId);
      restoredSession.messages = session.messages || [];
      restoredSession.sections = session.sections || restoredSession.sections;
      restoredSession.context = session.context || {};
      restoredSession.createdAt = session.createdAt || Date.now();
      restoredSession.tokenCount = session.tokenCount || 0;
      this.sessions.set(sessionId, restoredSession);
    }

    return {
      sessionId,
      session: this.sessions.get(sessionId),
      meta,
      message: `Restored session from ${timeExpression}`,
    };
  }

  async getHistorySessions(options = {}, userId = null) {
    const uid = userId || this._currentUserId;
    return await this.sessionPersistence.getUserSessions(uid, options);
  }

  async findSessionByKeyword(keyword, userId = null) {
    const uid = userId || this._currentUserId;
    return await this.sessionPersistence.findSessionByKeyword(keyword, uid);
  }

  async getRecentContext(days = 7, userId = null) {
    const uid = userId || this._currentUserId;
    return await this.sessionPersistence.getRecentContext(uid, days);
  }

  /**
   * 2026-08-13 P2-4: 增加 userId 参数——history-index 按 user_id 与 session_id 分列,
   * 语音会话(voice_shell_user)与 gui 会话(原 sessionId 即 user)不混流。
   * 存量三参调用行为不变(user_id 仍等于 sessionId)。
   */
  addMessage(sessionId, role, content, userId = null) {
    const session = this.getSession(sessionId);
    const message = session.addMessage(role, content);

    // 2026-08-14 数据链审计 C2: 消息写入内存后防抖落盘——此前仅关服/4h 过期才 flush,
    // 运行期 sess_* 文件恒为创建时空快照。1.5s 防抖窗口内新消息自然包含在导出中。
    this._scheduleSessionFlush(session, userId);

    try {
      const history = require('../history-index');
      history.addMessage(userId || sessionId, role, content, sessionId).catch(e => console.debug('[memory] Operation failed:', e?.message));
    } catch { console.warn('[memory-system] silent catch, error swallowed'); }

    if (role === 'user' && content && content.length > 15) {
      this._scheduleExtraction(session);
    }

    return { session, message };
  }

  async flushMemories(sessionId, options = {}) {
    const session = this.getSession(sessionId);
    if (!session || session.messages.length === 0) return { flushed: 0, facts: [] };

    const llmCall = options.llmCall || resolveLLMCall();
    if (!llmCall) {
      const extracted = memoryExtractionService._regexFallback(
        session.messages.filter(m => m.role === 'user').map(m => m.content)
      );
      const stored = [];
      for (const item of extracted) {
        if (item.confidence >= 0.4) {
          const mem = await this.addMemory(item.type, item.content.slice(0, 80), item.content, [item.topic], 'private');
          stored.push(mem);
        }
      }
      return { flushed: stored.length, facts: stored, mode: 'regex' };
    }

    const recentMsgs = session.messages.slice(-20).filter(m =>
      (m.role === 'user' || m.role === 'assistant') && m.content?.length > 10
    ).map(m => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');

    if (recentMsgs.length < 50) return { flushed: 0, facts: [] };

    try {
      const flushPrompt = `This conversation is about to be compressed. Before it's gone, extract 1-3 key facts worth remembering long-term. Focus on: user preferences, decisions made, important facts learned, corrections given. Return JSON array: [{"type":"preference|fact|decision|correction","content":"brief fact"}]. Only return truly important facts. If nothing notable, return [].`;

      const response = await llmCall(flushPrompt, recentMsgs);
      const text = typeof response === 'string' ? response : (response?.content || '');
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

      let facts = [];
      try { facts = JSON.parse(cleaned); } catch (e) { console.warn('[memory-manager] LLM 事实解析失败:', e.message); }
      if (!Array.isArray(facts)) facts = [];

      const gated = facts.filter(f => memoryExtractionService._gateCheck({
        content: f.content, confidence: 0.5, type: f.type, source: 'flush'
      }));

      const stored = [];
      for (const fact of gated) {
        const mem = await this.addMemory(
          fact.type || 'fact',
          fact.content.slice(0, 80),
          fact.content,
          ['flush', fact.type || 'general'],
          'private'
        );
        stored.push(mem);
      }

      if (stored.length > 0) {
        console.log(`[memory] Flush: 从压缩前的对话中抢救了 ${stored.length} 条重要记忆`);
      }
      return { flushed: stored.length, facts: stored, mode: 'llm' };
    } catch (e) {
      return { flushed: 0, error: e.message };
    }
  }

  _scheduleExtraction(session) {
    const now = Date.now();
    if (now - this._lastExtractionRun < 30000) return;

    const existingIdx = this._extractionQueue.findIndex(e => e.sessionId === session.sessionId);
    if (existingIdx >= 0) this._extractionQueue.splice(existingIdx, 1);
    this._extractionQueue.push({ sessionId: session.sessionId, messages: session.messages.slice(-30) });
    if (this._extractionQueue.length > 10) this._extractionQueue.shift();

    setTimeout(() => this._runExtraction(), 2000);
  }

  async _runExtraction() {
    if (this._extractionQueue.length === 0) return;
    this._lastExtractionRun = Date.now();

    const queueEntry = this._extractionQueue.shift();
    if (!queueEntry || !queueEntry.messages || queueEntry.messages.length === 0) return;
    const messages = queueEntry.messages;

    try {
      if (!memoryExtractionService._initialized) {
        await memoryExtractionService.initialize({ memoryDir: MEMORY_DIR });
      }

      const extracted = await memoryExtractionService.extract(messages, {
        llmCall: resolveLLMCall(),
      });

      if (extracted.length === 0) return;

      for (const item of extracted) {
        if (item.confidence < 0.3) continue;

        const newMemory = await this.addMemory(
          item.type || 'fact',
          item.content.slice(0, 80),
          item.content,
          [item.topic || 'general'],
          'private'
        );

        const existingMemories = await this.getAllMemories();
        const relations = this._relations.analyze(
          { id: newMemory.id || newMemory, type: item.type, content: item.content, topic: item.topic },
          existingMemories
        );

        if (relations.contradictions.length > 0) {
          this._pendingFlags.push({
            type: 'contradiction',
            memory: item.content.slice(0, 100),
            contradictions: relations.contradictions,
            timestamp: Date.now(),
          });
        }
        if (relations.updates.length > 0) {
          this._pendingFlags.push({
            type: 'update',
            memory: item.content.slice(0, 100),
            updates: relations.updates,
            timestamp: Date.now(),
          });
        }
      }

      if (extracted.length > 0) {
        console.log(`[memory] 从对话中提取 ${extracted.length} 条记忆`);
      }
    } catch (e) {
      console.debug('[memory] extraction skipped:', e.message);
    }
  }

  getPendingFlags(clear = true) {
    const flags = [...this._pendingFlags];
    if (clear) this._pendingFlags = [];
    return flags;
  }

  async getFullContext(sessionId, query) {
    const context = {
      sessionMemory: null,
      notebook: [],
      insights: [],
      enhancedContext: null,
    };

    const session = this.getSession(sessionId);
    context.sessionMemory = {
      messages: session.getRecentMessages(20),
      sections: session.sections
    };

    if (query) {
      context.notebook = this.autoMemory.search(query, 5);
    } else {
      context.notebook = this.autoMemory.getRecent(5);
    }

    if (this.autoDream.dreamResults) {
      context.insights = this.autoDream.dreamResults.insights
        .filter(i => {
          if (!query) return true;
          return i.topics.some(t => query.toLowerCase().includes(t.toLowerCase()));
        })
        .slice(0, 3);
    }

    if (query && this.contextIntegrator) {
      try {
        const enhancedCtx = await this.contextIntegrator.prepareContext(query, {
          sessionId,
        });
        context.enhancedContext = enhancedCtx;
        context.contextBlock = this.contextIntegrator.formatContextBlock(enhancedCtx);
      } catch (e) {
        console.warn('[memory-manager] contextIntegrator 上下文准备失败:', e.message);
      }
    }

    return context;
  }

  /**
   * S4: 归一化记忆文本用于查重——去口语前缀(用户/我)、去标点空白、小写。
   * 使"用户偏好HTML格式的报告输出"与"偏好HTML格式的报告"判为同一条。
   */
  _normalizeMemoryText(text) {
    return String(text || '')
      .replace(/^用户(?:说|表示|认为|希望|需要|要求|想要|决定|选择|偏好|习惯|喜欢)/, '')
      .replace(/^(我|我们|用户)\s*/, '')
      .replace(/[，。！？、,.!?；;：:"“”'‘’\s]+/g, '')
      .toLowerCase();
  }

  /** S4: 从偏好内容提取短 key(截前 24 字符)用于 facets 查重键 */
  _facetKeyFromMemory(content) {
    return String(content || '').trim().slice(0, 24);
  }

  async addMemory(type, title, content, tags = [], scope = 'private') {
    // S4: 内容级查重——归一化后扫描已存记忆,命中则仅 touch(更新时间戳/计数)不新增。
    // 旧实现每次提取都新增独立 mem_ id + SQLite 行,同一偏好重复 8 条(实测)。
    const normalized = this._normalizeMemoryText(content);
    if (normalized) {
      for (const m of this.autoMemory.memories.values()) {
        if (m && m.content && this._normalizeMemoryText(m.content) === normalized) {
          try {
            if (this._unifiedStore && typeof this._unifiedStore.touchMemory === 'function') {
              await this._unifiedStore.touchMemory(m.id);
            }
          } catch (e) { console.warn('[memory] touchMemory 失败:', e.message); }
          console.log(`[memory] 去重: 命中已存记忆 ${m.id}(${m.title || title}),跳过新增`);
          return m.id;
        }
      }
    }

    // S4: 偏好画像写入 facets(StabilityDetector 状态机,含幂等查重 + 稳定性分级)
    if (type === 'preference' && this._stabilityDetector && content) {
      try {
        this._stabilityDetector.addEvidence(
          FACET_CLASSES.STYLE,
          this._facetKeyFromMemory(content),
          String(content).slice(0, 120),
          { cueFamily: CUE_FAMILIES.EXPLICIT, explicit: true, namespace: 'global' }
        );
      } catch (e) { console.warn('[memory] facets 写入失败:', e.message); }
    }

    const section = SECTION_DEFAULTS[type] || MEMORY_SECTIONS.FACTS;

    const result = await this.autoMemory.addMemory({
      type, title, content, tags, scope, section,
    });

    // SP1 守卫: 门控拒绝/近重复跳过——直通返回, 不进入 fts/unified-store/embedding fan-out。
    // (result 为 {rejected:true,reason} 或 {skip:true,matchedId} 对象而非字符串 id,
    //  旧实现以其当 id 继续 ftsSearch/unified-store/embedding, 全部带脏值执行)
    if (!result || result.rejected || result.skip) {
      return result;
    }

    if (this.enhancedMemory) {
      try {
        await this.enhancedMemory.addFact(content, {
          category: type,
          tags,
          confidence: 0.7,
        });
      } catch (e) {
        console.warn('[memory-manager] enhancedMemory.addFact 失败:', e.message);
      }
    }

    if (this.ftsSearch && typeof this.ftsSearch.indexMemory === 'function') {
      try {
        await this.ftsSearch.indexMemory(result.id || result, {
          type,
          title,
          content,
          tags,
        });
      } catch (e) {
        console.warn('[memory-manager] ftsSearch.indexMemory 失败:', e.message);
      }
    }

    // 写入 unified-store（SQLite 主库），供 HybridRetrievalEngine 检索。
    // 提取后的事实归入 global 命名空间（跨用户共享记忆），
    // hybrid 检索对个人命名空间查询会补 global 兜底，两路均可命中。
    try {
      const store = this.unifiedStore;
      if (store && typeof store.addMemory === 'function') {
        await store.addMemory({
          id: typeof result === 'string' ? result : result?.id,
          type,
          title,
          content,
          tags,
          scope: scope || 'private',
          namespace: 'global',
          importance: 0.5,
          trust_score: 0.5,
          source: 'memory-manager',
        });
      }
    } catch (e) {
      console.warn('[memory-system] unified-store write failed:', e.message);
    }

    // 向量化（失败降级不阻塞写入）
    try {
      const { globalEmbeddingPipeline } = require('../embedding-pipeline');
      const memoryId = typeof result === 'string' ? result : result?.id;
      globalEmbeddingPipeline.embedMemory({ id: memoryId, text: content }).catch(e2 =>
        console.warn('[memory-manager] embedding async 失败:', e2?.message || e2)
      );
    } catch (e) {
      console.warn('[memory-manager] embedding 接线失败:', e.message || e);
    }

    // 异步接入 IngestionPipeline：分块 + 实体提取 + entity_index 入库
    // （图谱检索通道的数据源），embedding 在 Ollama 可用时自动生成，
    // 失败降级不影响主流程。
    try {
      const { getIngestionPipeline } = require('./ingestion-pipeline');
      const pipeline = getIngestionPipeline();
      if (pipeline && typeof pipeline.ingestNow === 'function') {
        pipeline.ingestNow({
          type: 'memory',
          content,
          namespace: 'global',
          metadata: { id: typeof result === 'string' ? result : result?.id, type, title, tags },
        }).catch(e => console.debug('[memory-system] ingestion pipeline failed:', e?.message));
      }
    } catch (e) {
      console.warn('[memory-system] ingestion pipeline unavailable:', e.message);
    }

    return result;
  }

  async searchMemories(query, limit = 10, options = {}) {
    const RRF_K = 60, memMap = new Map();
    const add = (items, src) => { for (const x of items) {
      const id = x.id; if (!memMap.has(id)) memMap.set(id, { best: x, c: [], s: new Set() });
      const e = memMap.get(id); e.c.push(1/(RRF_K+(x._rank||1))); e.s.add(src);
      if ((x.trustScore||x.score||0) > (e.best.trustScore||e.best.score||0)) e.best = x;
    }};
    const p = [];
    if (options.useEnhanced !== false && this.enhancedMemory) p.push((async()=>{try{
      add((await this.enhancedMemory.search(query,{limit:limit*2,category:options.category,agentName:options.agentName})).map((x,i)=>({...x,_rank:i+1})),"enhanced");
    }catch(e){console.warn('[memory-system] enhanced search failed:', e.message);}})());
    if (this.ftsSearch?.search) p.push((async()=>{try{
      add((await this.ftsSearch.search(query,limit*2)).map((x,i)=>({...x,_rank:i+1})),"fts");
    }catch(e){console.warn('[memory-system] fts search failed:', e.message);}})());
    p.push((async()=>{add(this.autoMemory.search(query,limit*2,{sector:options.sector}).map((x,i)=>({...x,_rank:i+1})),"auto");})());
    await Promise.allSettled(p);
    let fused = [...memMap.entries()].map(([id,e])=>({id,title:e.best.title||e.best.content?.slice(0,80)||"",content:e.best.content||"",type:e.best.type||e.best.category||"general",tags:e.best.tags||[],score:e.c.reduce((a,b)=>a+b,0),trustScore:e.best.trustScore||e.best.score||0,source:[...e.s].join("+"),updated:e.best.updated||e.best.updatedAt||Date.now()}));
    fused.sort((a,b)=>b.score-a.score);
    const maxScore = fused.length > 0 ? fused[0].score : 1;
    const now = Date.now();
    for (const m of fused) {
      const sim = maxScore > 0 ? m.score / maxScore : 0;
      const imp = typeof m.trustScore === 'number' ? Math.min(m.trustScore / 10, 1) : 0.5;
      const ageDays = (now - (m.updated || now)) / 86400000;
      const rec = Math.exp(-ageDays * 0.2);
      m.compositeScore = 0.6 * sim + 0.2 * imp + 0.2 * rec;
    }
    fused.sort((a, b) => (b.compositeScore || b.score) - (a.compositeScore || a.score));
    const final = fused.slice(0, limit);
    if (final.length >= 2 && options.skipHebbian !== true) {
      this._applyHebbianAssociation(final, query).catch(e => console.debug('[memory] Operation failed:', e?.message));
    }
    return final;
  }

  async _applyHebbianAssociation(results, query) {
    try {
      const { HebbianGraphStore } = require('./hebbian-graph-store');
      const store = new HebbianGraphStore();
      await store.associate(results, query);
    } catch (e) { console.warn('[memory-manager] Hebbian 关联失败:', e.message); }
  }

  async getRelatedMemories(memoryId, limit = 5) {
    try {
      const { HebbianGraphStore } = require('./hebbian-graph-store');
      const store = new HebbianGraphStore();
      return store.getRelated(memoryId, limit);
    } catch (e) {
      return [];
    }
  }

  async getHebbianStats() {
    try {
      const { HebbianGraphStore } = require('./hebbian-graph-store');
      const store = new HebbianGraphStore();
      const stats = store.getStats();
      return { nodes: stats.entities || 0, edges: stats.relations || 0 };
    } catch (e) {
      return { nodes: 0, edges: 0 };
    }
  }

  async getAllMemories() {
    return Array.from(this.autoMemory.memories.values());
  }

  async triggerDream() {
    return await this.autoDream.dream();
  }

  async runArchiveCycle() {
    const archiver = this.memoryArchiver;
    if (archiver && typeof archiver.runArchiveCycle === 'function') {
      return await archiver.runArchiveCycle();
    }
    return { status: 'skipped', reason: 'no_archiver_available' };
  }

  async cleanLowTrust(threshold = 0.3) {
    const result = {
      success: true,
      threshold,
      deleted: 0,
      details: {},
    };

    try {
      const memIds = [];
      for (const [id, memory] of this.autoMemory.memories) {
        const trust = memory.trustScore ?? memory.trust_score ?? 0.5;
        if (trust < threshold) {
          memIds.push(id);
        }
      }
      for (const id of memIds) {
        this.autoMemory.memories.delete(id);
      }
      if (memIds.length > 0) {
        this.autoMemory.index = this.autoMemory.index.filter(e => !memIds.includes(e.file?.replace('.md', '')));
        await this.autoMemory.save();
        result.deleted += memIds.length;
        result.details.autoMemory = memIds.length;

        // P1: 全后端清理——FTS 索引 / unified-store memories 表残留会导致僵尸记忆复活
        if (this.ftsSearch && typeof this.ftsSearch.removeIndex === 'function') {
          let ftsDeleted = 0;
          for (const id of memIds) {
            try {
              await this.ftsSearch.removeIndex(id);
              ftsDeleted++;
            } catch (err) {
              console.warn('[memory-manager] fts removeIndex 失败:', err.message);
            }
          }
          result.details.fts = ftsDeleted;
        }
        try {
          const store = this.unifiedStore;
          if (store && typeof store.deleteMemory === 'function') {
            let sqliteDeleted = 0;
            for (const id of memIds) {
              try {
                await store.deleteMemory(id);
                sqliteDeleted++;
              } catch (err) {
                console.warn('[memory-manager] unified-store deleteMemory 失败:', err.message);
              }
            }
            result.details.unifiedStore = sqliteDeleted;
          }
        } catch (e) {
          result.details.unifiedStoreError = e.message;
        }
      }
    } catch (e) {
      result.details.autoMemoryError = e.message;
    }

    if (this._enhancedMemory) {
      try {
        const emStats = await this._enhancedMemory.getStats();
        if (emStats && emStats.agents) {
          let emDeleted = 0;
          for (const agentName of Object.keys(emStats.agents)) {
            try {
              const memory = await this._enhancedMemory.hybridManager.getMemory(agentName);
              const facts = memory.facts || [];
              const lowTrustFacts = facts.filter(f => (f.trustScore || 0) < threshold);
              for (const fact of lowTrustFacts) {
                try {
                  await this._enhancedMemory.deleteFact(fact.id, { agentName });
                  emDeleted++;
                } catch (err) {
                  console.warn('[memory-manager] deleteFact 失败:', err.message);
                }
              }
            } catch (err) {
              console.warn('[memory-manager] hybridManager.getMemory 失败:', err.message);
            }
          }
          if (emDeleted > 0) {
            result.deleted += emDeleted;
            result.details.enhancedMemory = emDeleted;
          }
        }
      } catch (e) {
        result.details.enhancedMemoryError = e.message;
      }
    }

    return result;
  }

  async getStats() {
    let totalMessages = 0;
    let totalTokens = 0;

    for (const session of this.sessions.values()) {
      // eslint-disable-next-line no-unused-vars
      totalMessages += session.messages?.length || 0;
      // eslint-disable-next-line no-unused-vars
      totalTokens += session.tokenCount || 0;
    }

    const sessionFiles = [];
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const filePath = path.join(SESSIONS_DIR, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            sessionFiles.push({
              id: file.replace('.json', ''),
              messageCount: data.messages?.length || 0,
              tokenCount: data.tokenCount || 0,
              createdAt: data.createdAt || 0
            });
          } catch (e) {
            console.warn('[memory-manager] 会话文件解析失败:', e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[memory-manager] 会话目录扫描失败:', e.message);
    }

    const totalSessionMessages = sessionFiles.reduce((sum, s) => sum + s.messageCount, 0);
    const totalSessionTokens = sessionFiles.reduce((sum, s) => sum + s.tokenCount, 0);

    const autoMemoryStats = this.autoMemory.getStats();

    const notesList = Array.from(this.autoMemory.memories.values())
      .filter(m => ['note', 'general', 'user', 'feedback', 'project', 'reference'].includes(m.type));

    let sessionHighlightCount = 0;
    try {
      if (fs.existsSync(SESSIONS_DIR)) {
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const filePath = path.join(SESSIONS_DIR, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const userMsgs = (data.messages || []).filter(m => m.role === 'user' && m.content && m.content.length > 10);
            sessionHighlightCount += Math.min(userMsgs.length, 5);
          } catch (e) {
            console.warn('[memory-manager] 会话文件解析失败:', e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[memory-manager] 会话目录扫描失败:', e.message);
    }

    let enhancedFactCount = 0;
    let enhancedEntityCount = 0;
    try {
      if (this._enhancedMemory) {
        // 2026-08-21: await 缺失修复——EnhancedMemorySystem.getStats() 是 async,
        // 未 await 时 emStats 为 Promise, .totalFacts 恒 undefined → 左栏 Knowledge 恒 0。
        // 对照: decay 清理路径(896 行)早已 await, 此处系漏写。
        const emStats = await this._enhancedMemory.getStats();
        enhancedFactCount = emStats.totalFacts || 0;
        // 字段路径修复: getStats 返回 { entities: { totalEntities } }, 顶层无 totalEntities
        enhancedEntityCount = emStats.entities?.totalEntities || 0;
      }
    } catch (e) {
      console.warn('[memory-manager] enhancedMemory.getStats 失败:', e.message);
    }

    const notebookStats = {
      ...autoMemoryStats,
      totalMemories: notesList.length + sessionHighlightCount,
      noteCount: notesList.length + sessionHighlightCount,
      pureNoteCount: notesList.length,
      sessionHighlightCount,
      enhancedFactCount,
      enhancedEntityCount,
      byType: {
        ...autoMemoryStats.byType,
        session: sessionHighlightCount,
      },
    };

    // 2026-08-15: 左栏 Decayed 指标真实数据源——记忆衰减引擎累计衰减数
    // (此前前端硬编码 '—'; memoryDecay 为懒加载 getter, 首次访问即启动引擎)
    let decayedCount = 0;
    try {
      if (this.memoryDecay && typeof this.memoryDecay.getStats === 'function') {
        const ds = this.memoryDecay.getStats();
        decayedCount = ds.totalDecayed != null ? ds.totalDecayed : (ds.decayed || 0);
      }
    } catch (e) {
      console.warn('[memory-manager] 衰减引擎统计不可用:', e.message);
    }

    const temporalStats = this.temporalGraph ? this.temporalGraph.getStats() : { facts: 0, openFacts: 0 };

    const baseStats = {
      sessions: {
        active: this.sessions.size,
        total: sessionFiles.length,
        totalMessages: totalSessionMessages,
        totalTokens: totalSessionTokens
      },
      storage: this.storageType,
      notebook: notebookStats,
      decayedCount,
      dream: this.autoDream.getStats(),
      temporal: temporalStats,
      sessionFiles
    };

    return baseStats;
  }

  getNotes() {
    const notes = Array.from(this.autoMemory.memories.values())
      .filter(m => ['note', 'general', 'user', 'feedback', 'project', 'reference'].includes(m.type))
      .sort((a, b) => b.updated - a.updated);

    if (!this._sessionHighlightsCache || Date.now() - (this._sessionHighlightsCacheTime || 0) > 60000) {
      const sessionHighlights = [];
      try {
        if (fs.existsSync(SESSIONS_DIR)) {
          const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
          for (const file of files.slice(0, 50)) {
            try {
              const filePath = path.join(SESSIONS_DIR, file);
              const stat = fs.statSync(filePath);
              if (stat.size > 1024 * 1024) continue;
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

              const userMessages = (data.messages || [])
                .filter(m => m.role === 'user')
                .slice(-5);

              for (const msg of userMessages) {
                if (msg.content && msg.content.length > 10) {
                  sessionHighlights.push({
                    id: `session_${file.replace('.json', '')}_${msg.uuid}`,
                    title: msg.content.slice(0, 50) + (msg.content.length > 50 ? '...' : ''),
                    content: msg.content,
                    type: 'session',
                    tags: ['session'],
                    created: msg.timestamp || data.createdAt,
                    updated: msg.timestamp || data.createdAt
                  });
                }
              }
            } catch (e) {
              console.warn('[memory-manager] 会话文件解析失败:', e.message);
            }
          }
        }
      } catch (e) {
        console.warn('[memory-manager] 会话目录扫描失败:', e.message);
      }
      this._sessionHighlightsCache = sessionHighlights;
      this._sessionHighlightsCacheTime = Date.now();
    }

    return [...notes, ...this._sessionHighlightsCache].sort((a, b) => b.updated - a.updated);
  }

  async addNote(data) {
    return await this.addMemory(
      'note',
      data.title || 'Untitled',
      data.content || '',
      data.tags || [],
      'private'
    );
  }

  async deleteNote(id) {
    const memory = this.autoMemory.memories.get(id);
    if (!memory) {
      return { success: false, error: "Not found" };
    }

    this.autoMemory.memories.delete(id);
    this.autoMemory.index = this.autoMemory.index.filter(e => !e.file.includes(id));
    await this.autoMemory.save();

    return { success: true };
  }

  async updateNote(id, data) {
    const memory = this.autoMemory.memories.get(id);
    if (!memory) {
      return { success: false, error: "Not found" };
    }

    if (data.title !== undefined) memory.title = data.title;
    if (data.content !== undefined) memory.content = data.content;
    if (data.tags !== undefined) memory.tags = data.tags;
    memory.updated = Date.now();

    await this.autoMemory.save();
    return { success: true };
  }

  getDreams() {
    if (this.autoDream.dreamResults) {
      return this.autoDream.dreamResults;
    }
    return null;
  }
}

module.exports = { MemoryManager, MEMORY_SECTIONS, SECTION_DEFAULTS };
