/**
 * TopicIndex — 跨会话话题聚类索引
 *
 * v1 确定性实现：1-2 字 n-gram 中文分词 + 停用词预滤 + 余弦共现聚类。
 * 目标：老板说"上次那个供应链分析"时，SmartLoader 能先解析话题意图再精确匹配。
 */

const NGRAM_MIN = 1;
const NGRAM_MAX = 2;
const STOPWORDS = new Set(['的', '了', '是', '在', '有', '和', '与', '我', '你', '他', '这个', '那个', '上次', '之前', '什么', '怎么', '多少', '一下']);

const CLUSTER_THRESHOLD = 0.12;
const SEARCH_THRESHOLD = 0.20;

function tokenize(content) {
  const tokens = new Set();
  // 预滤停用词：直接从原文中移除，避免停用词干扰 n-gram 生成
  let s = String(content || '');
  for (const sw of STOPWORDS) {
    s = s.split(sw).join('');
  }
  s = s.replace(/[^一-龥A-Za-z0-9]/g, '');
  for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
    for (let i = 0; i + n <= s.length; i++) {
      const t = s.slice(i, i + n);
      if (t.length >= 1 && !STOPWORDS.has(t)) tokens.add(t);
    }
  }
  return [...tokens];
}

function cosine(a, b) {
  const setA = new Set(a); const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / Math.sqrt(setA.size * setB.size);
}

class TopicIndex {
  constructor() {
    this._topics = [];
    this._memories = new Map(); // memoryId → { content, topicId }
  }

  indexMemories(memories) {
    this._topics = [];
    this._memories.clear();
    const list = Array.isArray(memories) ? memories : [];
    const tokenized = list.map((m) => ({ id: m.id, content: m.content || '', tokens: tokenize(m.content) }));
    for (const item of tokenized) {
      let bestTopic = null; let bestScore = CLUSTER_THRESHOLD;
      for (const t of this._topics) {
        const score = cosine(item.tokens, t.tokens);
        if (score > bestScore) { bestTopic = t; bestScore = score; }
      }
      if (bestTopic) {
        bestTopic.memoryIds.push(item.id);
        bestTopic.tokens = new Set([...bestTopic.tokens, ...item.tokens]);
      } else {
        const topic = {
          id: `topic_${this._topics.length + 1}`,
          title: this._pickTitle(item.tokens) || item.content.slice(0, 12),
          memoryIds: [item.id],
          tokens: new Set(item.tokens),
        };
        this._topics.push(topic);
      }
      this._memories.set(item.id, { content: item.content, topicId: bestTopic ? bestTopic.id : this._topics[this._topics.length - 1].id });
    }
    // 只返回 2+ 记忆的聚类话题；单条记忆不构成话题
    return { topics: this._topics.filter((t) => t.memoryIds.length >= 2).map((t) => ({ id: t.id, title: t.title, memoryIds: t.memoryIds })) };
  }

  _pickTitle(tokens) {
    // 取最长的 token 作为话题标题（名词倾向）
    return [...tokens].sort((a, b) => b.length - a.length)[0] || '';
  }

  searchTopics(query) {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    // 搜索所有话题（包括单条记忆的 solo 话题——"上次那个X"可能匹配到单条记忆）
    return this._topics
      .map((t) => ({ title: t.title, id: t.id, score: cosine(qTokens, t.tokens) }))
      .filter((h) => h.score >= SEARCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  getMemoriesForTopic(topicId) {
    const t = this._topics.find((x) => x.id === topicId);
    if (!t) return [];
    return t.memoryIds.map((id) => {
      const mem = this._memories.get(id);
      return mem ? { id, content: mem.content } : null;
    }).filter(Boolean);
  }
}

module.exports = { TopicIndex, tokenize };
