/**
 * Memory Relations — 记忆关系引擎
 *
 * 让记忆从"独立条目"变成"关联网络"。
 *
 * 检测能力:
 *   1. 矛盾检测 — "用户说预算是10万" vs "用户说预算是20万"
 *   2. 更新检测 — "预算从10万变成20万" → 标记旧记忆为 superseded
 *   3. 关联发现 — "项目A的预算" 和 "项目A的进度" 通过话题关联
 */



class MemoryRelations {
  constructor(config = {}) {
    this._relations = new Map(); // id → { contradictions: [], updates: [], associations: [] }
    this._contradictionThreshold = config.contradictionThreshold || 0.6;
    this._updateThreshold = config.updateThreshold || 0.7;
    this._enabled = config.enabled !== false;
  }

  /**
   * 检查新记忆与已有记忆的关系
   * @param {Object} newMemory — { id, type, content, topic, tags }
   * @param {Array} existingMemories — [{ id, type, content, topic, tags }, ...]
   * @returns {Object} { contradictions, updates, associations }
   */
  analyze(newMemory, existingMemories = []) {
    if (!this._enabled || !newMemory.content) return { contradictions: [], updates: [], associations: [] };

    const result = {
      contradictions: [],
      updates: [],
      associations: [],
    };

    for (const existing of existingMemories) {
      if (existing.id === newMemory.id) continue;

      // 同话题才有比较意义
      const sameTopic = this._sameTopic(newMemory, existing);
      const sameType = newMemory.type === existing.type;

      if (!sameTopic && !sameType) continue;

      const similarity = this._textSimilarity(newMemory.content, existing.content);

      // 矛盾检测：高相似度但内容相反
      if (similarity > this._contradictionThreshold) {
        const isContradiction = this._detectContradiction(newMemory.content, existing.content);
        if (isContradiction) {
          result.contradictions.push({
            newId: newMemory.id,
            existingId: existing.id,
            existingContent: existing.content.slice(0, 100),
            newContent: newMemory.content.slice(0, 100),
            confidence: similarity,
            type: 'contradiction',
          });
        }
      }

      // 更新检测：同一话题 + 更新词 = 直接判定（中文 bigram 相似度不可靠）
      if (sameTopic) {
        const isUpdate = this._detectUpdate(newMemory.content, existing.content);
        if (isUpdate) {
          result.updates.push({
            newId: newMemory.id,
            supersedesId: existing.id,
            newContent: newMemory.content.slice(0, 100),
            oldContent: existing.content.slice(0, 100),
            confidence: similarity,
            type: 'update',
          });
        }
      }

      // 关联检测：相同话题标签或内容重叠
      if (sameTopic && similarity > 0.3) {
        result.associations.push({
          sourceId: newMemory.id,
          targetId: existing.id,
          topic: newMemory.topic || existing.topic,
          strength: similarity,
          type: 'association',
        });
      }
    }

    return result;
  }

  /**
   * 判断两条内容是否矛盾
   * 简单规则：包含否定词 + 相似话题
   */
  _detectContradiction(newContent, oldContent) {
    const newLower = newContent.toLowerCase();
    const oldLower = oldContent.toLowerCase();

    // 规则1: 数值类矛盾（预算/时间/数量）
    const numPattern = /(\d+)\s*(万|千|元|天|个|人|次|年|月)/;
    const newNum = newLower.match(numPattern);
    const oldNum = oldLower.match(numPattern);
    if (newNum && oldNum) {
      const nv = parseInt(newNum[1]);
      const ov = parseInt(oldNum[1]);
      if (nv !== ov && newNum[2] === oldNum[2]) {
        return true; // 数值不同且单位相同 = 矛盾
      }
    }

    // 规则2: 否定词（中英文混合，不用\b）
    const cnNeg = /(不是|不对|没有|不可以|不允许|禁止|停止|取消)/;
    const enNeg = /\b(no|not|don'?t|can'?t)\b/i;
    const hasNeg = (s) => cnNeg.test(s) || enNeg.test(s);
    if (hasNeg(newLower) && !hasNeg(oldLower)) return true;
    if (!hasNeg(newLower) && hasNeg(oldLower)) return true;

    // 规则3: 对立词
    const opposites = [
      ['喜欢', '讨厌'], ['可以', '不行'], ['好', '坏'], ['大', '小'],
      ['多', '少'], ['高', '低'], ['快', '慢'], ['新', '旧'],
    ];
    for (const [a, b] of opposites) {
      if (newLower.includes(a) && oldLower.includes(b)) return true;
      if (newLower.includes(b) && oldLower.includes(a)) return true;
    }

    return false;
  }

  /**
   * 判断新内容是否是旧内容的更新
   */
  _detectUpdate(newContent, _oldContent) {
    // 更新词检测（中英文混合，不用\b——中文不支持词边界）
    const updateWords = /(现在|目前|最新|更新|改成|改为|现在变成|现在已经是|提高到|降低到|增加到|减少到|调整到|变为|变更为)/;
    return updateWords.test(newContent.toLowerCase());
  }

  /**
   * 判断两条记忆是否属于同一话题
   */
  _sameTopic(a, b) {
    const aTopic = a.topic || a.type || '';
    const bTopic = b.topic || b.type || '';
    if (aTopic === bTopic && aTopic !== '') return true;

    // 检查标签重叠
    const aTags = new Set((a.tags || []).map(t => t.toLowerCase()));
    const bTags = (b.tags || []).map(t => t.toLowerCase());
    if (bTags.some(t => aTags.has(t))) return true;

    return false;
  }

  /**
   * 简单的 Jaccard 相似度（基于字符 bigram）
   */
  _textSimilarity(a, b) {
    if (!a || !b) return 0;
    const getBigrams = (s) => {
      const chars = s.slice(0, 200).split('');
      const bigrams = new Set();
      for (let i = 0; i < chars.length - 1; i++) {
        bigrams.add(chars[i] + chars[i + 1]);
      }
      return bigrams;
    };

    const aSet = getBigrams(a);
    const bSet = getBigrams(b);
    if (aSet.size === 0 || bSet.size === 0) return 0;

    const intersection = new Set([...aSet].filter(x => bSet.has(x)));
    const union = new Set([...aSet, ...bSet]);
    return intersection.size / union.size;
  }

  getStats() {
    let totalContradictions = 0;
    let totalUpdates = 0;
    let totalAssociations = 0;
    for (const [, rel] of this._relations) {
      totalContradictions += rel.contradictions.length;
      totalUpdates += rel.updates.length;
      totalAssociations += rel.associations.length;
    }
    return {
      relationsTracked: this._relations.size,
      totalContradictions,
      totalUpdates,
      totalAssociations,
    };
  }
}

module.exports = { MemoryRelations };
