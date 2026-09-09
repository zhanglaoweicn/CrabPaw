/**
 * Memory Extraction Service v2
 *
 * LLM 驱动：从每轮对话中自动提取结构化信息。
 * 替代 v1 的正则匹配（漏掉 80% 的自然语言表达）。
 *
 * 提取内容:
 *   1. 用户偏好 (喜欢/不喜欢/习惯)
 *   2. 事实信息 (姓名/职业/项目/预算/时间线)
 *   3. 修正反馈 (用户纠正了 Agent 的错误)
 *   4. 意图信号 (用户暗示了未来的需求)
 *
 * 设计原则:
 *   - 异步非阻塞 — 不增加对话延迟
 *   - 轻量 prompt — ~150 tokens，低成本
 *   - 置信度标记 — 低置信度的不自动存储，等 confirm 后提升
 */

const EXTRACTION_PROMPT = `Extract key info from this conversation turn. Return JSON array. Each item: {"type":"preference|fact|correction|intent","content":"brief summary","confidence":0.0-1.0,"topic":"single word topic"}. Include ONLY clearly stated info. Return empty array [] if nothing notable. Do NOT extract greetings, thanks, or small talk. Do NOT extract one-off queries (asking time, weather, date, or other single-use questions). Do NOT describe the conversation itself (e.g. "user asks about X") — extract the underlying fact only, and only when it is a lasting statement about the user's preferences, corrections, or project facts.`;

class MemoryExtractionService {
  constructor() {
    this._initialized = false;
    this._extractionCount = 0;
    this._lastExtractionTime = 0;
    this._stats = { extracted: 0, skipped: 0, errors: 0, gatedOut: 0 };
  }

  async initialize({ memoryDir } = {}) {
    this._memoryDir = memoryDir;
    this._initialized = true;
  }

  /**
   * 从对话中提取结构化记忆
   * @param {Array} conversation — 消息数组 [{role, content}, ...]
   * @param {Object} [options]
   * @param {Function} [options.llmCall] — LLM 调用函数 (prompt, messages) => response
   * @returns {Array} 提取的记忆条目
   */
  async extract(conversation, options = {}) {
    if (!this._initialized) return [];

    // 只取最近 3 轮用户消息（不重复分析整个对话）
    const recentTurns = this._getRecentUserTurns(conversation, 3);
    if (recentTurns.length === 0) return [];

    // 快速过滤：跳过纯问候/确认
    const hasSubstance = recentTurns.some(t =>
      t.length > 15 &&
      !/^(好的|嗯|哦|哈|嗨|谢谢|再见|拜拜|ok|yes|no|hi|hello|bye)\b/i.test(t.trim())
    );
    if (!hasSubstance) {
      this._stats.skipped++;
      return [];
    }

    // 检查是否已提取过（避免重复）
    const dedupKey = recentTurns.join('|').slice(0, 200);
    if (this._lastDedupKey === dedupKey) return [];
    this._lastDedupKey = dedupKey;

    try {
      const llmCall = options.llmCall || this._defaultLLMCall;
      if (!llmCall) {
        // 没有 LLM 可用时，回退到基础正则
        return this._regexFallback(recentTurns);
      }

      const response = await llmCall(EXTRACTION_PROMPT, recentTurns.join('\n'));
      const extracted = this._parseResponse(response);

      // ── Write-time gating (claw-mem 启发): 存前过滤 ────────
      const gated = extracted.filter(item => this._gateCheck(item));
      this._stats.gatedOut += extracted.length - gated.length;

      if (gated.length > 0) {
        this._extractionCount += gated.length;
        this._stats.extracted += gated.length;
        this._lastExtractionTime = Date.now();
      } else {
        this._stats.skipped++;
      }

      return gated;
    } catch (e) {
      this._stats.errors++;
      return this._regexFallback(recentTurns);
    }
  }

  /**
   * Write-time gate: 在存储前判断"这条值不值得记"
   * claw-mem 启发 — 在源头过滤噪音，不是存了再删
   */
  _gateCheck(item) {
    if (!item || !item.content) return false;
    const text = item.content.trim();

    // 太短的不记
    if (text.length < 8) return false;

    // 纯问候/确认不记
    if (/^(好的|嗯|哦|哈|嗨|谢谢|再见|拜拜|ok|yes|no|hi|hello|bye|收到|明白|了解)\b/i.test(text)) return false;

    // 纯数字/日期不记
    if (/^[\d\s\-/.：年月日]+$/.test(text)) return false;

    // 一次性查询不记（问时间/日期/星期等无持久价值）
    if (/(?:几点了|现在几点|今天(?:几号|星期几)|现在(?:时间|日期)|查一下?.*(?:天气|汇率|价格))/i.test(text)) return false;

    // 元描述不记：LLM 在描述对话行为（"用户询问/确认了X"）而非实质信息。
    // "用户表示喜欢/偏好"等实质内容不受影响。
    if (/^用户(?:询问|问|问到|确认了|确认|想知道|问了)/.test(text)) return false;

    // 置信度门槛：LLM 提取 ≥ 0.3，正则提取 ≥ 0.4
    const minConfidence = item.source === 'regex_fallback' ? 0.4 : 0.3;
    if ((item.confidence || 0) < minConfidence) return false;

    // 必须有实质关键词（人名、动作、偏好、数字+单位等）
    const hasSubstance = (
      /[一-鿿]{4,}/.test(text) ||  // 至少4个汉字
      /[a-zA-Z]{8,}/.test(text) ||          // 至少8个英文字母
      /\d+[万亿千百个天元年月]/.test(text) || // 数字+单位
      /喜欢|讨厌|偏好|想要|希望|需要|决定|计划|准备|打算/.test(text)  // 意图词
    );
    if (!hasSubstance) return false;

    // 纯 URL 不记
    if (/^https?:\/\/\S+$/.test(text)) return false;

    return true;
  }

  /**
   * 基础正则回退（LLM 不可用时）
   */
  _regexFallback(turns) {
    const results = [];
    const patterns = [
      { regex: /我(?:是|叫|在|住在|工作在|的职位是)\s*(.+?)(?:[，。！\s]|$)/, type: 'fact', confidence: 0.4 },
      { regex: /我(?:喜欢|偏好|爱|想要|希望|想用)\s*(.+?)(?:[，。！\s]|$)/, type: 'preference', confidence: 0.4 },
      { regex: /(?:不对|不是|错了|纠正|改成)\s*(.+)/, type: 'correction', confidence: 0.5 },
      { regex: /(?:下次|以后|将来|改天)\s*(.+)/, type: 'intent', confidence: 0.3 },
    ];

    for (const turn of turns) {
      for (const { regex, type, confidence } of patterns) {
        const match = turn.match(regex);
        if (match) {
          results.push({
            type,
            content: match[1].trim().slice(0, 200),
            confidence,
            topic: type,
            source: 'regex_fallback',
          });
        }
      }
    }

    return results;
  }

  _getRecentUserTurns(conversation, maxTurns) {
    const turns = [];
    for (let i = conversation.length - 1; i >= 0 && turns.length < maxTurns; i--) {
      const msg = conversation[i];
      if (msg.role === 'user' && msg.content && typeof msg.content === 'string') {
        // 2026-08-17: 防自复制——历史里混入的提取指令不得再作为提取输入
        // （否则提取指令 → 被提取 → 新提取指令写入历史 → 指数污染）
        if (msg.content.startsWith('Extract key info from this conversation turn')) continue;
        turns.unshift(msg.content.slice(0, 500));
      }
    }
    return turns;
  }

  _parseResponse(response) {
    if (!response) return [];

    try {
      // 尝试直接 JSON 解析
      let text = typeof response === 'string' ? response : (response.content || response.text || '');
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : (parsed.extractions || parsed.items || []);

      return items
        .filter(item => item.content && item.content.length > 2)
        .map(item => ({
          type: ['preference', 'fact', 'correction', 'intent'].includes(item.type) ? item.type : 'fact',
          content: String(item.content).slice(0, 300),
          confidence: Math.min(1, Math.max(0, parseFloat(item.confidence) || 0.5)),
          topic: item.topic || item.type || 'general',
          source: 'llm',
        }));
    } catch (e) {
      // JSON 解析失败，尝试按行解析
      const lines = (typeof response === 'string' ? response : JSON.stringify(response))
        .split('\n')
        .filter(l => l.trim().length > 5 && !l.startsWith('```'));

      return lines.map(line => ({
        type: 'fact',
        content: line.replace(/^[-*\d.]\s*/, '').trim().slice(0, 200),
        confidence: 0.3,
        topic: 'general',
        source: 'llm_fallback',
      }));
    }
  }

  // eslint-disable-next-line no-unused-vars -- 函数参数 text 未使用（不改签名）
  _defaultLLMCall(_prompt, text) {
    // 无外接 LLM 时返回 null，触发正则回退
    return null;
  }

  getStats() {
    return {
      ...this._stats,
      extractionCount: this._extractionCount,
      lastExtractionTime: this._lastExtractionTime,
    };
  }

  shutdown() { this._initialized = false; }
}

const memoryExtractionService = new MemoryExtractionService();
module.exports = { memoryExtractionService, MemoryExtractionService };
