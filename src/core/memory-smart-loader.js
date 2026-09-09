/**
 * Smart Memory Loader - 按需加载记忆，减少上下文长度
 * 
 * 策略：
 * 1. 关键词匹配：只加载与查询相关的记忆
 * 2. 长度限制：每个记忆片段限制最大长度
 * 3. 分级加载：简单查询跳过深层记忆
 * 4. 跨会话检索：从 user-sessions-index.json 检索历史会话
 */

const fs = require('fs');
const path = require('path');
const { memoryManager } = require('./memory-system');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('./config');
const SESSIONS_DIR = path.join(DATA_DIR, 'memory', 'sessions');
const SESSION_INDEX_FILE = path.join(SESSIONS_DIR, 'user-sessions-index.json');

const KEYWORD_CATEGORIES = {
  code: ['代码', '函数', '类', 'bug', '错误', '修复', '实现', 'function', 'class', 'code', 'fix', '编程', '开发', '测试'],
  design: ['设计', 'UI', '界面', '样式', '颜色', '布局', 'design', 'ui', 'style', 'layout', '海报', '图标', '页面'],
  task: ['任务', '待办', '计划', '进度', '完成', 'task', 'todo', 'plan', 'progress', '安排', '日程'],
  user: ['我', '用户', '偏好', '习惯', 'user', 'preference', 'habit', '个人', '设置', '配置'],
  project: ['项目', '架构', '模块', '依赖', 'project', 'architecture', 'module', 'dependency'],
  data: ['数据', '数据库', 'API', '接口', 'data', 'database', 'api', 'endpoint', '存储'],
  business: ['一人公司', 'opc', '创业', '商业', '商业模式', '公司', '营销', '客户', '产品', '市场'],
  ai: ['ai', '人工智能', '模型', '智能体', 'gpt', 'deepseek', 'minimax', 'openai', '大模型', 'agent', '机器人'],
  communication: ['微信', '企微', '飞书', '邮件', '消息', '通知', '通讯', '聊天', 'im'],
  finance: ['股票', '行情', '投资', '基金', '财务', '交易', '证券', '股市', '金融'],
};

const MAX_MEMORY_CONTENT = 500;
const MAX_NOTEBOOK_ENTRIES = 3;
const MAX_CROSS_SESSION_ENTRIES = 3;
const MAX_INSIGHTS = 2;

// 会话索引缓存
let _sessionIndexCache = null;
let _sessionIndexCacheTime = 0;
const SESSION_INDEX_CACHE_TTL = 60000; // 1分钟

// 记忆检索结果缓存（慢路径：notebook / cross-session / insights）
const _memoryResultCache = new Map();
const MEMORY_RESULT_CACHE_TTL = 30000; // 30秒

function classifyQuery(query) {
  const queryLower = query.toLowerCase();
  const categories = [];
  
  for (const [category, keywords] of Object.entries(KEYWORD_CATEGORIES)) {
    for (const keyword of keywords) {
      if (queryLower.includes(keyword)) {
        categories.push(category);
        break;
      }
    }
  }
  
  return categories.length > 0 ? categories : ['general'];
}

// 中文分词：提取有意义的子串
function tokenizeChinese(text) {
  const tokens = new Set();
  // 按常见标点分割
  const segments = text.split(/[,，。.；;！!？?\s\n\r\t]+/).filter(s => s.length >= 2);
  for (const seg of segments) {
    tokens.add(seg);
    // 再拆成 2-4 字词组
    for (let len = 2; len <= 4; len++) {
      for (let i = 0; i <= seg.length - len; i++) {
        tokens.add(seg.slice(i, i + len));
      }
    }
  }
  return [...tokens];
}

function truncateContent(content, maxChars = MAX_MEMORY_CONTENT) {
  if (!content) return '';
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '...';
}

function estimateQueryComplexity(query) {
  const simplePatterns = /^(你好|hi|hello|thanks|谢谢|bye|再见|好的|ok|yes|no|嗯|好|行|知道|继续|然后|哦)/i;
  const hasQuestionMark = /[?？]/.test(query);
  const chineseCharCount = (query.match(/[\u4e00-\u9fff]/g) || []).length;

  // 简短问候 / 无实际内容的应答 → simple
  if (simplePatterns.test(query) && chineseCharCount < 6) return 'simple';
  // 很短的陈述（< 10 个中文字）无问号 → simple
  if (chineseCharCount > 0 && chineseCharCount < 10 && !hasQuestionMark) return 'simple';
  // 有问号且不太长 → moderate
  if (hasQuestionMark && chineseCharCount < 30) return 'moderate';
  // 很长或有技术深度 → complex
  return 'complex';
}

// 加载会话索引（带缓存）
function loadSessionIndex() {
  const now = Date.now();
  if (_sessionIndexCache && (now - _sessionIndexCacheTime) < SESSION_INDEX_CACHE_TTL) {
    return _sessionIndexCache;
  }
  
  try {
    if (fs.existsSync(SESSION_INDEX_FILE)) {
      const raw = fs.readFileSync(SESSION_INDEX_FILE, "utf-8");
      const data = JSON.parse(raw);
      // 合并所有用户的会话到统一数组
      let allSessions = [];
      if (Array.isArray(data)) {
        allSessions = data;
      } else {
        for (const sessions of Object.values(data)) {
          if (Array.isArray(sessions)) {
            allSessions = allSessions.concat(sessions);
          }
        }
      }
      _sessionIndexCache = allSessions;
      _sessionIndexCacheTime = now;
      return _sessionIndexCache;
    }
  } catch (e) {

    // 索引文件损坏或不存在

    console.warn('[memory-smart-loader.js] 空 catch 补日志:', e && e.message);
  }

  
  _sessionIndexCache = [];
  _sessionIndexCacheTime = now;
  return _sessionIndexCache;
}

// 跨会话搜索：在历史会话索引中查找相关会话
function searchSessionIndex(query) {
  const sessions = loadSessionIndex();
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  
  const queryTokens = tokenizeChinese(query);
  const queryLower = query.toLowerCase();
  const scored = [];
  
  for (const session of sessions) {
    let score = 0;
    // 适配 user-sessions-index.json 的数据结构
    const firstMsg = (session.firstMessage || session.summary?.firstMessage || "").toLowerCase();
    const lastMsg = (session.lastMessage || session.summary?.lastMessage || "").toLowerCase();
    const combined = firstMsg + " " + lastMsg;
    
    // 双向匹配
    if (combined.includes(queryLower)) {
      score += 10;
    } else {
      // 中文分词匹配
      for (const token of queryTokens) {
        if (token.length < 2) continue;
        if (combined.includes(token.toLowerCase())) score += 3;
      }
      // n-gram 匹配 (2-4字)
      if (queryLower.length >= 2) {
        for (let len = 2; len <= Math.min(4, queryLower.length); len++) {
          for (let i = 0; i <= queryLower.length - len; i++) {
            const gram = queryLower.slice(i, i + len);
            if (combined.includes(gram)) score += 1;
          }
        }
      }
    }
    
    if (score > 0) {
      scored.push({ ...session, score });
    }
  }
  
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CROSS_SESSION_ENTRIES);
}

// 加载单个会话中的用户消息
function loadSessionUserMessages(sessionId) {
  const messages = [];
  try {
    const sessionPath = path.join(SESSIONS_DIR, sessionId + '.json');
    if (fs.existsSync(sessionPath)) {
      const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      if (data.messages) {
        for (const msg of data.messages) {
          if (msg.role === 'user' && msg.content && msg.content.length > 10) {
            messages.push(msg.content);
          }
        }
      }
    }
  } catch (e) {

    // 跳过损坏的会话文件

    console.warn('[memory-smart-loader.js] 空 catch 补日志:', e && e.message);
  }

  return messages;
}

async function loadSmartContext(userId, query, options = {}) {
  const complexity = options.complexity || estimateQueryComplexity(query);
  const categories = classifyQuery(query);
  
  const context = {
    sessionMemory: null,
    notebook: [],
    crossSession: [],
    insights: []
  };
  
  const session = memoryManager.getSession(userId);
  if (session) {
    const messageLimit = complexity === 'simple' ? 5 : complexity === 'moderate' ? 10 : 20;
    context.sessionMemory = {
      messages: session.getRecentMessages(messageLimit).map(m => ({
        role: m.role,
        content: truncateContent(m.content, complexity === 'simple' ? 200 : 800),
        timestamp: m.timestamp
      })),
      sections: complexity === 'complex' ? session.sections : null
    };
  }
  
  // 尝试从缓存读取慢路径结果（notebook / cross-session / insights）
  const cachedKey = userId || 'default';
  const cached = _memoryResultCache.get(cachedKey);
  if (cached && (Date.now() - cached.ts) < MEMORY_RESULT_CACHE_TTL) {
    context.notebook = cached.notebook;
    context.crossSession = cached.crossSession;
    context.insights = cached.insights;
    return context;
  }
  
  if (complexity !== 'simple') {
    const searchLimit = complexity === 'moderate' ? 2 : MAX_NOTEBOOK_ENTRIES;
    const searchQuery = categories.includes('general') ? query : categories.join(' ');
    const memories = memoryManager.autoMemory.search(searchQuery, searchLimit);
    
    context.notebook = memories.slice(0, searchLimit).map(m => ({
      title: m.title,
      type: m.type,
      content: truncateContent(m.content, MAX_MEMORY_CONTENT),
      tags: m.tags
    }));

    // 从 System 3 (unified-store SQLite) 补充检索，利用 FTS5 全文搜索
    try {
      const { getUnifiedStore } = require('./memory/unified-store');
      const store = await getUnifiedStore();
      if (store) {
        const docs = store.queryDocuments({
          namespace: userId || 'default',
          titleContains: searchQuery,
        });
        if (docs && docs.length > 0) {
          const existingTitles = new Set(context.notebook.map(m => m.title));
          for (const doc of docs.slice(0, 2)) {
            if (!existingTitles.has(doc.title)) {
              context.notebook.push({
                title: doc.title,
                type: 'enhanced',
                content: truncateContent(doc.content, MAX_MEMORY_CONTENT),
                tags: ['unified-store'],
              });
            }
          }
        }
      }
    } catch (e) {

      // unified-store 检索失败不影响主流程

      console.warn('[memory-smart-loader.js] 空 catch 补日志:', e && e.message);
    }



    // ★ 话题意图优先检索（"上次那个X" → 话题聚类索引）
    try {
      const topicsFile = path.join(DATA_DIR, "topics.json");
      if (fs.existsSync(topicsFile)) {
        const { TopicIndex, tokenize: topicTokenize } = require("./memory/topic-index");
        const idx = new TopicIndex();
        const topicsData = JSON.parse(fs.readFileSync(topicsFile, "utf8"));
        // 从持久化数据重建 TopicIndex（含 tokens 重建）
        for (const t of topicsData) {
          const topicTokens = new Set();
          const tmemories = t.memories || [];
          for (const m of tmemories) {
            const toks = topicTokenize(m.content);
            for (const tok of toks) topicTokens.add(tok);
            idx._memories.set(m.id, { content: m.content, topicId: t.id });
          }
          idx._topics.push({
            id: t.id,
            title: t.title,
            memoryIds: t.memoryIds || [],
            tokens: topicTokens,
          });
        }
        const topicHits = idx.searchTopics(query);
        if (topicHits.length > 0) {
          const topicMemories = idx.getMemoriesForTopic(topicHits[0].id);
          // 注入到跨会话记忆列表（去重后）
          const existingContents = new Set([
            ...context.notebook.map(m => m.content),
            ...context.crossSession.flatMap(cs => cs.messages || []),
          ]);
          const newMessages = topicMemories
            .map(m => truncateContent(m.content, 400))
            .filter(m => !existingContents.has(m));
          if (newMessages.length > 0) {
            context.crossSession.unshift({
              sessionId: "topic_" + topicHits[0].id,
              title: "[话题] " + topicHits[0].title,
              messages: newMessages.slice(0, MAX_CROSS_SESSION_ENTRIES),
              score: topicHits[0].score,
            });
          }
        }
      }
    } catch (e) {
      console.warn("[memory-smart-loader] 话题检索失败:", e.message || e);
    }
    // ★ 跨会话检索：从 user-sessions-index.json 搜索历史会话
    if (context.notebook.length < searchLimit) {
      try {
        const matchedSessions = searchSessionIndex(query);
        for (const match of matchedSessions) {
          const userMessages = loadSessionUserMessages(match.sessionId || match.id);
          if (userMessages.length > 0) {
            context.crossSession.push({
              sessionId: match.sessionId || match.id,
              title: match.title || '历史会话',
              messages: userMessages.slice(-5).map(m => truncateContent(m, 400)),
              score: match.score,
            });
          }
        }
        
        if (context.crossSession.length > 0) {
          console.log('\u{1F50D} SmartLoader: \u4ECE\u5386\u53F2\u4F1A\u8BDD\u4E2D\u627E\u5230 ' + context.crossSession.length + ' \u4E2A\u76F8\u5173\u4F1A\u8BDD');
        }
      } catch (e) {

        // 跨会话检索失败不影响主流程

        console.warn('[memory-smart-loader.js] 空 catch 补日志:', e && e.message);
      }

    }
  }
  
  if (complexity === 'complex' && memoryManager.autoDream.dreamResults) {
    // 2026-08-05 fix: dreamResults.insights 数据契约不保证每条含 topics——
    // i.topics 为 undefined 时 `.some` 抛 "Cannot read properties of undefined
    // (reading 'some')"，导致整条流式对话在 SmartLoader 阶段崩溃（日志实锤 3 次）。
    const dreamInsights = Array.isArray(memoryManager.autoDream.dreamResults.insights)
      ? memoryManager.autoDream.dreamResults.insights
      : [];
    const insights = dreamInsights
      .filter(i => {
        return Array.isArray(i && i.topics) && i.topics.some(t => query.toLowerCase().includes(String(t).toLowerCase()));
      })
      .slice(0, MAX_INSIGHTS);

    context.insights = insights.map(i => ({
      content: truncateContent(i.content, 300),
      importance: i.importance
    }));
  }

  // 写入缓存（仅缓存非 simple 的慢路径结果）
  if (complexity !== 'simple') {
    _memoryResultCache.set(cachedKey, {
      notebook: context.notebook,
      crossSession: context.crossSession,
      insights: context.insights,
      ts: Date.now(),
    });
    // 控制缓存大小，避免内存泄漏
    if (_memoryResultCache.size > 100) {
      const keys = [..._memoryResultCache.keys()].slice(0, 50);
      for (const k of keys) _memoryResultCache.delete(k);
    }
  }

  // P1-4(2026-08-25) 记忆注入总预算：单条限额已有（per-entry），无总预算时
  // 最坏组合 ≈ 2.3 万字符（部分轮次挤爆上下文）。超标时按优先级裁剪：
  // crossSession（可由 SessionSearch/MemoryRecall 检索）→ notebook → 会话记忆最旧消息。
  _enforceMemoryBudget(context);

  return context;
}

const MEMORY_PROMPT_CHAR_CAP = 24000; // ≈6-8k token（中文密度）；超限即裁剪

function _enforceMemoryBudget(context) {
  if (!context) return;
  let total = (context.sessionMemory?.messages || []).reduce((s, m) => s + String(m.content || '').length, 0)
    + (context.sessionMemory?.sections ? JSON.stringify(context.sessionMemory.sections).length : 0)
    + context.notebook.reduce((s, m) => s + String(m.title || '').length + String(m.content || '').length, 0)
    + context.crossSession.reduce((s, cs) => s + String(cs.title || '').length + (cs.messages || []).reduce((s2, m) => s2 + String(m).length, 0), 0)
    + context.insights.reduce((s, i) => s + String(i.content || '').length, 0);
  if (total <= MEMORY_PROMPT_CHAR_CAP) return;

  // 1) 先裁跨会话（历史可检索，价值最低）
  while (total > MEMORY_PROMPT_CHAR_CAP && context.crossSession.length > 0) {
    const dropped = context.crossSession.pop();
    total -= String(dropped?.title || '').length + (dropped?.messages || []).reduce((s2, m) => s2 + String(m).length, 0);
  }
  // 2) 再裁 notebook
  while (total > MEMORY_PROMPT_CHAR_CAP && context.notebook.length > 0) {
    const dropped = context.notebook.pop();
    total -= String(dropped?.title || '').length + String(dropped?.content || '').length;
  }
  // 3) 最后从会话记忆最旧消息裁
  if (total > MEMORY_PROMPT_CHAR_CAP && Array.isArray(context.sessionMemory?.messages)) {
    while (total > MEMORY_PROMPT_CHAR_CAP && context.sessionMemory.messages.length > 0) {
      const dropped = context.sessionMemory.messages.shift();
      total -= String(dropped?.content || '').length;
    }
  }
}

let _headroomIntegration = null;
function _getHeadroomIntegration() {
  if (!_headroomIntegration) {
    try { _headroomIntegration = require('./headroom-integration'); } catch { _headroomIntegration = false; }
  }
  return _headroomIntegration;
}

async function buildCompactMemoryPrompt(context) {
  const parts = [];
  
  if (context.sessionMemory?.messages?.length > 0) {
    parts.push('## 会话记忆');
    for (const msg of context.sessionMemory.messages) {
      const prefix = msg.role === 'user' ? '👁' : '🤖';
      parts.push(prefix + ' ' + msg.content);
    }
  }
  
  if (context.sessionMemory?.sections) {
    parts.push('## 会话状态');
    for (const [name, section] of Object.entries(context.sessionMemory.sections)) {
      if (section.content) {
        parts.push('### ' + name);
        parts.push(truncateContent(section.content, 300));
      }
    }
  }
  
  // ★ 跨会话记忆（历史对话）
  if (context.crossSession && context.crossSession.length > 0) {
    parts.push('## 历史相关会话');
    for (const cs of context.crossSession) {
      parts.push('### [历史] ' + (cs.title || '历史会话'));
      for (const msg of cs.messages) {
        parts.push('- ' + msg);
      }
    }
  }
  
  if (context.notebook.length > 0) {
    parts.push('## 相关记忆');
    for (const mem of context.notebook) {
      parts.push('### [' + mem.type + '] ' + mem.title);
      parts.push(mem.content);
    }
  }
  
  if (context.insights.length > 0) {
    parts.push('## 洞察');
    for (const insight of context.insights) {
      parts.push('- ' + insight.content);
    }
  }
  
  const result = parts.join('\n\n');

  // Headroom 可选压缩：减少 token 消耗
  const hr = _getHeadroomIntegration();
  if (hr && hr.isEnabled() && result.length > 500) {
    const compressed = await hr.compressText(result);
    if (compressed.compressionRatio < 1) {
      console.debug(`[memory-smart-loader] headroom compressed memory: ${result.length}→${compressed.text.length} chars (${(compressed.compressionRatio * 100).toFixed(0)}%)`);
      return compressed.text;
    }
  }

  return result;
}

function invalidateMemoryCache(userId) {
  if (userId) {
    _memoryResultCache.delete(userId);
  } else {
    _memoryResultCache.clear();
  }
}

module.exports = {
  loadSmartContext,
  buildCompactMemoryPrompt,
  invalidateMemoryCache,
};
