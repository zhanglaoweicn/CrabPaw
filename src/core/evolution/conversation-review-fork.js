/**
 * Conversation Review Fork — 对话回顾引擎
 *
 * 每轮对话结束后，fork 一个轻量 Agent 回放对话快照，由 LLM 自主判断：
 *   1. 本对话中出现了哪些学习信号？
 *   2. 应该更新/创建哪个技能？
 *   3. 应该保存哪些用户偏好？
 *
 * 核心理念（来自 Hermes-Agent background_review.py）：
 *   - 语义信号 > 统计指标。用户说"不对"比指标恶化更有价值。
 *   - 逐轮触发 > 阈值触发。每次对话后都有学习机会。
 *   - 渐进式积累 > 一次性大改。每次 Review 做一个小改动。
 *   - 独立 fork > 污染主 session。使用 aux client，不触碰 prompt cache。
 *
 * 安全约束：
 *   - 仅使用 skill_manage 和 memory 工具（白名单）
 *   - 最大迭代数 ≤ 10（轻量审查）
 *   - 5 分钟内不重复 review
 *   - 失败不影响主对话
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');
const {
  SKILL_REVIEW_PROMPT,
  MEMORY_REVIEW_PROMPT,
  COMBINED_REVIEW_PROMPT,
  detectLearningSignals,
} = require('./review-prompts');

// ============================================================
// 配置常量
// ============================================================

/** 最大迭代数：review fork 只做轻量审查，不需要多轮 */
const MAX_REVIEW_ITERATIONS = 10;

/** 冷却期：同一 session 内两次 review 的最小间隔（ms） */
const REVIEW_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

/** 最大消息数：review fork 只回放最近的 N 条消息 */
const MAX_REVIEW_MESSAGES = 50;

/** Review fork 工具白名单：只允许 skill_manage 和 memory 操作
 * 2026-08-15 T7: 注册主名已收敛 PascalCase——新旧名均在白名单（registry 别名双向解析）。 */
const REVIEW_TOOL_WHITELIST = new Set([
  'skill_manage', 'SkillManage',
  'skill_view', 'SkillView',
  'skills_list', 'SkillsList',
  'memory_save', 'MemorySave',
  'memory_search', 'MemorySearch',
]);

// ============================================================
// ReviewResult
// ============================================================

class ReviewResult {
  constructor() {
    this.id = `review_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.timestamp = new Date().toISOString();
    this.signals = [];
    this.actions = [];         // [{ type: 'patch'|'create'|'memory', skill: '...', detail: '...' }]
    this.skillsAffected = [];
    this.memorySaved = false;
    this.summary = '';
    this.error = null;
    this.durationMs = 0;
  }
}

// ============================================================
// ConversationReviewFork
// ============================================================

class ConversationReviewFork extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      enabled: config.enabled !== false,
      maxIterations: config.maxIterations || MAX_REVIEW_ITERATIONS,
      cooldownMs: config.cooldownMs || REVIEW_COOLDOWN_MS,
      maxMessages: config.maxMessages || MAX_REVIEW_MESSAGES,
      reviewMode: config.reviewMode || 'combined', // 'skill' | 'memory' | 'combined'
      prefilter: config.prefilter !== false, // 是否启用预筛选
      ...config,
    };

    /** @type {Map<string, number>} sessionId → lastReviewTimestamp */
    this._lastReviews = new Map();

    /** @type {Map<string, ReviewResult[]>} sessionId → results */
    this._reviewHistory = new Map();

    /** @type {object|null} LLM 客户端引用 */
    this._llmClient = null;

    /** 是否正在运行 review */
    this._isRunning = false;

    /** @type {Map<string, {pattern: string, count: number, lastSeen: string, examples: string[]}>} */
    this._unhandledPatterns = new Map();

    /** Path to skill suggestions store */
    this._suggestionsPath = path.join(
      process.cwd(), "data", ".crabpaw", "curator", "skill-suggestions.json"
    );

    this._initialized = false;
  }

  /**
   * 初始化并注入 LLM 客户端
   * @param {object} llmClient - 可用于 chat completion 的客户端
   */
  initialize(llmClient = null) {
    if (this._initialized) return;
    this._llmClient = llmClient;
    this._initialized = true;
    this.emit('initialized');
    console.log('[ConversationReviewFork] 初始化完成');
  }

  /**
   * 注入 LLM 客户端（延迟绑定）
   */
  setLLMClient(client) {
    this._llmClient = client;
  }

  // ============================================================
  // 核心入口：审查一次对话
  // ============================================================

  /**
   * 审查一轮对话 — 由 ConversationLoop 在每轮结束后调用
   *
   * @param {object} context - 会话上下文
   * @param {string} context.sessionId - 会话 ID
   * @param {Array<object>} context.messages - 本对话的消息快照
   * @param {string[]} [context.loadedSkills] - 本轮加载的技能名称列表
   * @returns {Promise<ReviewResult|null>} 审查结果，或无信号时返回 null
   */
  async reviewAfterTurn(context) {
    if (!this._initialized) this.initialize();

    const { sessionId, messages, loadedSkills } = context;

    // 0. 检查冷却期
    if (this._isInCooldown(sessionId)) {
      return null;
    }

    // 1. 快速预筛选（检查用户消息中是否有学习信号）
    const userMessages = this._extractUserMessages(messages);
    // Memory-Keeper: 自动检测重要学习内容并写入持久化记忆
    this._memoryKeeperAutoReview(messages);
    if (this.config.prefilter) {
      const prefilter = detectLearningSignals(userMessages);
      if (!prefilter.hasSignal) {
        this._detectUnhandledRequests(messages);
        this._checkSkillSuggestions();
        return null;
      }
    }

    this._detectUnhandledRequests(messages);
    this._checkSkillSuggestions();

    // 2. 标记运行中，记录时间
    this._isRunning = true;
    this._lastReviews.set(sessionId, Date.now());
    const startTime = Date.now();

    const result = new ReviewResult();

    try {
      // 3. 构建审查消息
      const snapshot = this._buildSnapshot(messages);
      const reviewPrompt = this._buildReviewPrompt(loadedSkills);

      // 4. 构建审查 Agent 的 system prompt（受限的 agent 角色）
      const systemPrompt = this._buildReviewSystemPrompt();

      // 5. 执行审查（迭代式 tool calling）
      const reviewMessages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: reviewPrompt + '\n\n' + snapshot },
      ];

      // 使用轻量迭代循环
      let iteration = 0;
      let finalResponse = '';

      while (iteration < this.config.maxIterations) {
        iteration++;
        const response = await this._callLLM(reviewMessages);

        if (!response) {
          result.summary = 'LLM call failed';
          break;
        }

        // 检查是否有 tool_call
        const toolCalls = this._extractToolCalls(response);

        if (toolCalls.length === 0) {
          // 无 tool call = final response
          finalResponse = this._extractTextContent(response);
          break;
        }

        // 执行 tool calls（白名单过滤）
        for (const tc of toolCalls) {
          if (REVIEW_TOOL_WHITELIST.has(tc.name)) {
            const toolResult = await this._executeToolCall(tc);
            reviewMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: toolResult,
            });
            result.actions.push({
              type: tc.name,
              skill: tc.arguments?.name || tc.arguments?.skillName || '',
              detail: tc.arguments?.oldString?.substring(0, 80) || tc.arguments?.description?.substring(0, 80) || '',
            });
          }
        }
      }

      result.durationMs = Date.now() - startTime;
      result.summary = finalResponse || 'Review completed';

      // 6. 记录历史
      this._recordResult(sessionId, result);

      this.emit('review:complete', result);
      console.log(`[ConversationReviewFork] 审查完成: ${result.summary.substring(0, 80)} (${result.durationMs}ms)`);

      return result;

    } catch (err) {
      result.error = err.message;
      result.durationMs = Date.now() - startTime;
      this.emit('review:error', err);
      console.error('[ConversationReviewFork] 审查失败:', err.message);
      return result;

    } finally {
      this._isRunning = false;
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * Detect unhandled requests: cases where the agent couldn"t directly
   * handle the user"s request and needed clarification or a workaround.
   * Patterns are tracked across conversations for skill suggestion.
   * @param {Array<object>} messages
   */
  _detectUnhandledRequests(messages) {
    if (!messages || messages.length < 2) return;

    // Keywords that indicate the agent couldn"t handle a request directly
    const unhandledIndicators = [
      /I don"t have a skill for/i,
      /I cannot (directly )?help with/i,
      /I"m unable to/i,
      /not (currently )?available/i,
      /no (direct |built-in )?tool for/i,
      /requires?( a)? (custom )?(skill|tool|plugin)/i,
      /you"ll need to/i,
      /as a workaround/i,
      /here"s an alternative/i,
      /I can"t (directly )?do that/i,
      /outside my (current )?capabilities/i,
      /not supported yet/i,
    ];

    // Also look for user frustration about missing capabilities
    const userFrustrationIndicators = [
      /why can"t you/i,
      /you should be able to/i,
      /can you (just |simply )?do/i,
      /is there a (way|tool|skill) (to|for)/i,
      /how (do|can) I (get|make) you to/i,
      /add (a |this )?feature/i,
      /support for/i,
    ];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const text = typeof msg.content === "string" ? msg.content : "";

      if (!text) continue;

      // Check agent messages for unhandled indicators
      if (msg.role === "assistant") {
        for (const indicator of unhandledIndicators) {
          if (indicator.test(text)) {
            // Extract a short pattern from surrounding conversation
            const pattern = this._extractPattern(messages, i);
            this._trackPattern(pattern, text.substring(0, 200));
            break;
          }
        }
      }

      // Check user messages for frustration about missing capabilities
      if (msg.role === "user") {
        for (const indicator of userFrustrationIndicators) {
          if (indicator.test(text)) {
            const pattern = this._extractPattern(messages, i);
            this._trackPattern(pattern, text.substring(0, 200));
            break;
          }
        }
      }
    }
  }

  /**
   * Extract a concise pattern description from the conversation context.
   * @param {Array<object>} messages
   * @param {number} index - index of the trigger message
   * @returns {string} normalized pattern key
   */
  _extractPattern(messages, index) {
    // Use the user message before or at this index
    for (let j = index; j >= 0; j--) {
      if (messages[j].role === "user") {
        const text = typeof messages[j].content === "string" ? messages[j].content : "";
        // Normalize: lowercase, strip punctuation, take first 80 chars
        return text
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 80);
      }
    }
    return "unknown pattern";
  }

  /**
   * Track an unhandled pattern, merging similar ones.
   * @param {string} pattern - normalized pattern text
   * @param {string} example - example message content
   */
  _trackPattern(pattern, example) {
    // Check for similarity with existing patterns
    let matchedKey = null;
    // eslint-disable-next-line no-unused-vars
    for (const [key, entry] of this._unhandledPatterns) {
      if (this._computeSimilarity(key, pattern) > 0.4) {
        matchedKey = key;
        break;
      }
    }

    if (matchedKey) {
      const entry = this._unhandledPatterns.get(matchedKey);
      entry.count++;
      entry.lastSeen = new Date().toISOString();
      if (entry.examples.length < 5) {
        entry.examples.push(example);
      }
    } else {
      this._unhandledPatterns.set(pattern, {
        pattern,
        count: 1,
        lastSeen: new Date().toISOString(),
        examples: [example],
      });
    }
  }

  /**
   * Compute keyword-based similarity between two pattern strings.
   * Simple Jaccard-like overlap on significant words (length > 3).
   * @param {string} a
   * @param {string} b
   * @returns {number} similarity score 0-1
   */
  _computeSimilarity(a, b) {
    const getWords = (s) => {
      return new Set(
        s.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
      );
    };
    const wordsA = getWords(a);
    const wordsB = getWords(b);

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = wordsA.size + wordsB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  // ============================================================
  // Memory-Keeper 自动审查（参考 OpenHuman memory-keeper.md）
  // ============================================================

  /**
   * 自动检测本轮对话中是否有值得持久化的重要学习内容。
   * 扫描模式：修复方案、非显而易见的陷阱、架构决策、用户强调的规则
   *
   * 检测到后自动通过 Memory 工具写入 unified-memory.db。
   * 轻量操作——纯字符串模式匹配，不调用 LLM。
   */
  _memoryKeeperAutoReview(messages) {
    if (!messages || messages.length < 3) return;

    // 需要检测的内容模式 — 这些往往包含值得记忆的内容
    const SIGNAL_PATTERNS = [
      { re: /(?:修复|解决|fix|fixed|solved|workaround)(?:[^。\n]*?)(?:问题|bug|issue|error)/gi, type: 'fix' },
      { re: /(?:注意|警告|注意|陷阱|gotcha|caveat|注意点)[：:][^。\n]*/gi, type: 'gotcha' },
      { re: /(?:决策|决定|choose|chose|decided|选[了用])(?:[^。\n]*?)(?:因为|because|reason)/gi, type: 'decision' },
      { re: /(?:[我用户])(?:强调|要求|必须|must|always|never|不能|不要)[^。\n]*/gi, type: 'rule' },
      { re: /(?:记住|记得|请记住|remember|keep in mind)[：:][^。\n]*/gi, type: 'reminder' },
      { re: /(?:发现|learned|learning|学到|发现了一个)(?:[^。\n]*?)(?:模式|pattern|方式|method|技巧)/gi, type: 'pattern' },
    ];

    const captured = { fix: '', gotcha: '', decision: '', rule: '', reminder: '', pattern: '' };

    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (!text) continue;

      for (const signal of SIGNAL_PATTERNS) {
        signal.re.lastIndex = 0;
        if (!captured[signal.type]) {
          const match = signal.re.exec(text);
          if (match) {
            const snippet = text.substring(Math.max(0, match.index - 20), match.index + match[0].length + 60).replace(/\n/g, ' ').trim();
            if (snippet.length > 15 && snippet.length < 500) {
              captured[signal.type] = snippet;
            }
          }
        }
      }
    }

    const entries = Object.entries(captured).filter(([_, v]) => v);
    if (entries.length === 0) return;

    console.log(`[MemoryKeeper] 本轮检测到 ${entries.length} 条值得记录的内容`);

    // 写入记忆系统（静默，不影响主对话）
    this._saveToMemory(entries).catch(e => console.debug('[MemoryKeeper] 写入记忆失败:', e.message));
  }

  /**
   * 将检测到的学习内容写入 unified-memory.db
   */
  async _saveToMemory(entries) {
    try {
      const Database = require('better-sqlite3');
      const path = require('path');
      const crypto = require('crypto');
      const dbPath = path.join(DATA_DIR, 'unified-memory.db');
      if (!require('fs').existsSync(dbPath)) return;

      const db = new Database(dbPath);
      const now = Date.now();

      const typeLabels = { fix: '修复方案', gotcha: '陷阱提示', decision: '架构决策', rule: '规范规则', reminder: '提醒', pattern: '模式技巧' };

      for (const [type, content] of entries) {
        const id = `mem_auto_${now}_${crypto.randomBytes(4).toString('hex').slice(0, 8)}`;
        const label = typeLabels[type] || '学习记录';

        // 先查重：避免重复写入相同内容
        const existing = db.prepare('SELECT id FROM memories WHERE content LIKE ? AND type = ? LIMIT 1').get(`%${content.substring(0, 40)}%`, `learned_${type}`);
        if (existing) continue;

        db.prepare(`
          INSERT INTO memories (id, type, title, content, scope, tags, importance, trust_score, source, namespace, access_count, last_accessed, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, `learned_${type}`, `[MemoryKeeper] ${label}: ${content.substring(0, 60)}`, content,
          'personal', 'auto_learned', 0.6, 0.8,
          'memory_keeper', 'default', 0, now, now, now,
        );
      }

      db.close();
      console.log(`[MemoryKeeper] 已持久化 ${entries.length} 条自动学习内容`);
    } catch (e) {
      // 静默失败——MemoryKeeper 不应影响主流程
      console.debug('[MemoryKeeper] 写入失败:', e.message);
    }
  }

  /**
   * Check if any tracked patterns have reached the threshold (3+ occurrences)
   * and emit skill_suggestion signals.
   */
  _checkSkillSuggestions() {
    const THRESHOLD = 3;
    const suggestions = [];

    // eslint-disable-next-line no-unused-vars
    for (const [key, entry] of this._unhandledPatterns) {
      if (entry.count >= THRESHOLD) {
        const suggestion = {
          type: "suggest_skill",
          pattern: entry.pattern,
          frequency: entry.count,
          suggestedName: this._generateSuggestedName(entry.pattern),
          suggestedDescription: `Auto-detected from ${entry.count} unhandled requests: ${entry.pattern}`,
          examples: entry.examples.slice(0, 3),
          detectedAt: new Date().toISOString(),
        };
        suggestions.push(suggestion);

        // Reset counter after emitting to avoid spam
        entry.count = 0;
        entry.examples = [];

        this.emit("skill_suggestion", suggestion);
        console.log(
          `[ConversationReviewFork] Skill suggestion: ${suggestion.suggestedName} (${suggestion.frequency}x)`
        );
      }
    }

    if (suggestions.length > 0) {
      this._saveSkillSuggestions(suggestions);
    }
  }

  /**
   * Generate a kebab-case skill name from a pattern string.
   * @param {string} pattern
   * @returns {string}
   */
  _generateSuggestedName(pattern) {
    return pattern
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 5)
      .join("-")
      .substring(0, 50);
  }

  /**
   * Save skill suggestions to the persistent store.
   * @param {Array<object>} newSuggestions
   */
  _saveSkillSuggestions(newSuggestions) {
    try {
      const dir = path.dirname(this._suggestionsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let existing = [];
      if (fs.existsSync(this._suggestionsPath)) {
        try {
          existing = JSON.parse(
            fs.readFileSync(this._suggestionsPath, "utf-8")
          );
        } catch (_) {
          existing = [];
        }
      }

      // Deduplicate by pattern similarity
      for (const suggestion of newSuggestions) {
        const isDuplicate = existing.some(
          (e) => this._computeSimilarity(e.pattern, suggestion.pattern) > 0.7
        );
        if (!isDuplicate) {
          existing.push(suggestion);
        }
      }

      // Keep only the last 100 suggestions
      if (existing.length > 100) {
        existing = existing.slice(-100);
      }

      fs.writeFileSync(
        this._suggestionsPath,
        JSON.stringify(existing, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.warn(
        "[ConversationReviewFork] Failed to save suggestions:",
        err.message
      );
    }
  }

  /** 检查是否在冷却期内 */
  _isInCooldown(sessionId) {
    const last = this._lastReviews.get(sessionId);
    if (!last) return false;
    return (Date.now() - last) < this.config.cooldownMs;
  }

  /** 从消息列表中提取用户消息文本 */
  _extractUserMessages(messages) {
    if (!messages) return [];
    return messages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : '');
  }

  /** 构建对话快照（截断到 maxMessages 条） */
  _buildSnapshot(messages) {
    if (!messages) return '';

    const recent = messages.slice(-this.config.maxMessages);

    return recent.map(m => {
      const role = m.role || 'unknown';
      let content = '';
      if (typeof m.content === 'string') {
        content = m.content.substring(0, 2000); // 每条消息最多 2000 字符
      } else if (Array.isArray(m.content)) {
        content = m.content.map(c => c.text || '').join(' ').substring(0, 2000);
      }
      return `[${role}]: ${content}`;
    }).join('\n\n');
  }

  /** 构建审查 prompt */
  _buildReviewPrompt(loadedSkills) {
    let prompt = '';

    if (this.config.reviewMode === 'combined') {
      prompt = COMBINED_REVIEW_PROMPT;
    } else if (this.config.reviewMode === 'memory') {
      prompt = MEMORY_REVIEW_PROMPT;
    } else {
      prompt = SKILL_REVIEW_PROMPT;
    }

    if (loadedSkills && loadedSkills.length > 0) {
      prompt += `\n\nSkills loaded this session: ${loadedSkills.join(', ')}`;
    }

    return prompt;
  }

  /** 构建审查 Agent 的 system prompt */
  _buildReviewSystemPrompt() {
    return `You are a background review agent. Your role is to review conversations
and update skills and memory based on what you learn. You are NOT the
main agent — you work silently in the background.

Available tools:
- SkillManage: create, patch, edit, or delete skills
- SkillView: read a skill's content
- SkillsList: list all available skills
- MemorySave: save user preferences and facts
- MemorySearch: search existing memories

Rules:
- Only update skills when you find a clear learning signal.
- Prefer patching existing skills over creating new ones.
- Do NOT create skills for one-off tasks.
- Do NOT capture environment-dependent failures as permanent rules.
- If nothing is worth saving, say "Nothing to save." and stop.
- Mark all skills you create as agent-created (provenance: background_review).`;
  }

  /** 调用 LLM */
  async _callLLM(messages) {
    if (!this._llmClient) {
      // No client configured — this is normal when evolution has no LLM binding.
      // Review is skipped silently; the system degrades gracefully.
      return null;
    }

    try {
      // 如果 llmClient 有 chat 方法
      if (typeof this._llmClient.chat === 'function') {
        return await this._llmClient.chat({
          messages,
          temperature: 0.3,
          max_tokens: 2000,
          tools: this._getReviewTools(),
        });
      }

      // 如果是 fetch-based client
      if (typeof this._llmClient.fetchCompletion === 'function') {
        return await this._llmClient.fetchCompletion({
          messages,
          temperature: 0.3,
          max_tokens: 2000,
        });
      }

      // Client exists but has no known interface — warn
      console.warn('[ConversationReviewFork] LLM client 存在但未实现 chat/fetchCompletion 接口');
      return null;
    } catch (err) {
      console.warn('[ConversationReviewFork] LLM 调用失败 (有 client):', err.message,
        err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : '');
      return null;
    }
  }

  /** 获取 review 可用的工具定义 */
  _getReviewTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'SkillManage',
          description: 'Create, patch, edit, or delete a skill.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'patch', 'edit', 'delete'] },
              name: { type: 'string' },
              description: { type: 'string' },
              content: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
            },
            required: ['action', 'name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'SkillView',
          description: 'View a skill content.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              file: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'MemorySave',
          description: 'Save a fact or preference to memory.',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              value: { type: 'string' },
              category: { type: 'string' },
            },
            required: ['key', 'value'],
          },
        },
      },
    ];
  }

  /** 从 LLM 响应中提取 tool calls */
  _extractToolCalls(response) {
    if (!response) return [];
    // 标准 OpenAI 格式
    if (response.choices?.[0]?.message?.tool_calls) {
      return response.choices[0].message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function?.name || '',
        arguments: this._parseJSON(tc.function?.arguments),
      }));
    }
    // 直接 tool_calls 字段
    if (response.tool_calls) {
      return response.tool_calls.map(tc => ({
        id: tc.id || crypto.randomBytes(4).toString('hex'),
        name: tc.function?.name || tc.name || '',
        arguments: this._parseJSON(tc.function?.arguments || tc.arguments),
      }));
    }
    return [];
  }

  /** 从 LLM 响应中提取文本 */
  _extractTextContent(response) {
    if (!response) return '';
    if (response.choices?.[0]?.message?.content) {
      return response.choices[0].message.content;
    }
    if (response.content) return response.content;
    return '';
  }

  /** 安全地解析 JSON */
  _parseJSON(str) {
    if (!str) return {};
    try {
      return typeof str === 'string' ? JSON.parse(str) : str;
    } catch {
      return {};
    }
  }

  /** 执行 tool call（委托给 tool registry） */
  async _executeToolCall(toolCall) {
    try {
      const registry = require('../../tools/registry');
      const tool = registry.getTool(toolCall.name);
      if (!tool) return JSON.stringify({ error: `Tool not found: ${toolCall.name}` });

      // 注入 provenance: background_review
      const args = { ...toolCall.arguments, _provenance: 'background_review' };

      const result = await tool.execute(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  }

  /** 记录审查结果 */
  _recordResult(sessionId, result) {
    if (!this._reviewHistory.has(sessionId)) {
      this._reviewHistory.set(sessionId, []);
    }
    const history = this._reviewHistory.get(sessionId);
    history.push(result);

    // 最多保留 50 条
    if (history.length > 50) {
      history.splice(0, history.length - 50);
    }
  }

  // ============================================================
  // 状态查询
  // ============================================================

  /** 获取指定 session 的审查历史 */
  getHistory(sessionId) {
    return this._reviewHistory.get(sessionId) || [];
  }

  /** 是否正在运行 */
  get isRunning() {
    return this._isRunning;
  }

  /** 获取最后审查时间 */
  getLastReviewTime(sessionId) {
    return this._lastReviews.get(sessionId) || null;
  }
}

// 单例
let _instance = null;

function getReviewFork() {
  if (!_instance) {
    _instance = new ConversationReviewFork();
  }
  return _instance;
}

module.exports = {
  ConversationReviewFork,
  ReviewResult,
  getReviewFork,
};
