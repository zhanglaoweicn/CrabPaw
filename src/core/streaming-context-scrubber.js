const { EventEmitter } = require('events');

const FENCE_OPEN = '<memory-context>';
const FENCE_CLOSE = '</memory-context>';

const SCRUB_PATTERNS = [
  { re: /sk-[a-zA-Z0-9]{20,}/g, replacement: 'sk-[REDACTED]' },
  { re: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, replacement: 'Bearer [REDACTED]' },
  { re: /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{16,}/gi, replacement: 'api_key=[REDACTED]' },
  { re: /password\s*[:=]\s*["']?[^\s"']{8,}/gi, replacement: 'password=[REDACTED]' },
  { re: /token\s*[:=]\s*["']?[a-zA-Z0-9._-]{20,}/gi, replacement: 'token=[REDACTED]' },
  { re: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: '[PRIVATE KEY REDACTED]' },
];

const INSTRUCTION_LEAK_PATTERNS = [
  { re: /system\s+prompt\s*:/gi, replacement: '[REDACTED]' },
  { re: /your\s+instructions\s*(?:are|include)\s*:/gi, replacement: '[REDACTED]' },
  { re: /you\s+must\s+(?:always|never)\s+/gi, replacement: '[REDACTED]' },
];

class StreamingContextScrubber extends EventEmitter {
  constructor(config = {}) {
    super();
    this.scrubMemoryContent = config.scrubMemoryContent !== false;
    this.scrubInstructionLeaks = config.scrubInstructionLeaks !== false;
    this.scrubSensitiveData = config.scrubSensitiveData !== false;
    this._buffer = '';
    this._inFence = false;
    this._inDSML = false; // 是否在 DSML 标签内
  }

  process(chunk) {
    if (!chunk || typeof chunk !== 'string') return chunk;

    let result = '';
    this._buffer += chunk;

    // 先处理 DSML 标签（可能跨 chunk）
    // 同时匹配全角 ｜(U+FF5C) 和半角 |(U+007C)，LLM 可能输出任意一种
    const dsmlCharClass = '[｜|]';
    if (this._inDSML || this._buffer.includes('<｜') || this._buffer.includes('<|') || this._buffer.includes('<\uff7c')) {
      // 尝试匹配完整的 DSML 标签块并移除（使用动态构建的正则，兼容全角/半角竖线）
      const dsmlCleaned = this._buffer
        .replace(new RegExp(`<${dsmlCharClass}+DSML${dsmlCharClass}+tool_calls>[\\s\\S]*?</${dsmlCharClass}+DSML${dsmlCharClass}+tool_calls>`, 'g'), '')
        .replace(new RegExp(`<${dsmlCharClass}+DSML${dsmlCharClass}+invoke[^>]*>[\\s\\S]*?</${dsmlCharClass}+DSML${dsmlCharClass}+invoke>`, 'g'), '')
        .replace(new RegExp(`<${dsmlCharClass}+DSML${dsmlCharClass}+parameter[^>]*>[\\s\\S]*?</${dsmlCharClass}+DSML${dsmlCharClass}+parameter>`, 'g'), '')
        .replace(new RegExp(`</?${dsmlCharClass}+DSML${dsmlCharClass}+[^>]*>`, 'g'), '')
        .replace(new RegExp(`<${dsmlCharClass}[^${dsmlCharClass}]*${dsmlCharClass}[^>]*>`, 'g'), '');

      // 检查是否有未闭合的 DSML 标签
      const hasOpenDSML = new RegExp(`<${dsmlCharClass}+DSML`).test(this._buffer);
      const hasCloseDSML = new RegExp(`</${dsmlCharClass}+DSML${dsmlCharClass}+(tool_calls|invoke|parameter)>`).test(this._buffer);

      if (hasOpenDSML && !hasCloseDSML) {
        // DSML 标签未闭合，缓冲等待更多数据
        this._inDSML = true;
        // 输出 DSML 标签之前的内容
        const dsmlStartIdx = this._buffer.search(new RegExp(`<${dsmlCharClass}+DSML`));
        if (dsmlStartIdx > 0) {
          const beforeDSML = this._buffer.slice(0, dsmlStartIdx);
          this._buffer = this._buffer.slice(dsmlStartIdx);
          result += this._scrubOutsideFence(beforeDSML);
        }
        return result;
      }

      // DSML 标签已闭合或没有 DSML 标签
      this._inDSML = false;
      this._buffer = dsmlCleaned;
    }

    let searchFrom = 0;
    while (searchFrom < this._buffer.length) {
      if (!this._inFence) {
        const fenceStart = this._buffer.indexOf(FENCE_OPEN, searchFrom);
        if (fenceStart === -1) {
          const remaining = this._buffer.slice(searchFrom);
          result += this._scrubOutsideFence(remaining);
          this._buffer = '';
          break;
        }

        const before = this._buffer.slice(searchFrom, fenceStart);
        result += this._scrubOutsideFence(before);
        this._inFence = true;
        searchFrom = fenceStart + FENCE_OPEN.length;
      } else {
        const fenceEnd = this._buffer.indexOf(FENCE_CLOSE, searchFrom);
        if (fenceEnd === -1) {
          this._buffer = this._buffer.slice(searchFrom);
          return result;
        }

        if (!this.scrubMemoryContent) {
          const fenced = this._buffer.slice(searchFrom, fenceEnd);
          result += FENCE_OPEN + fenced + FENCE_CLOSE;
        }
        this._inFence = false;
        searchFrom = fenceEnd + FENCE_CLOSE.length;
      }
    }

    return result;
  }

  flush() {
    const remaining = this._buffer;
    this._buffer = '';
    this._inFence = false;
    if (!remaining) return '';
    // 如果还在 DSML 标签内，说明流结束时标签未闭合，丢弃残留标签
    if (this._inDSML) {
      this._inDSML = false;
      // 尝试提取标签前的正常内容
      const dsmlStartIdx = remaining.search(new RegExp('[｜|]+DSML'));
      if (dsmlStartIdx > 0) {
        return this._scrubOutsideFence(remaining.slice(0, dsmlStartIdx));
      }
      return '';
    }
    return this._scrubOutsideFence(remaining);
  }

  reset() {
    this._buffer = '';
    this._inFence = false;
    this._inDSML = false;
  }

  _scrubOutsideFence(text) {
    let result = text;
    if (this.scrubSensitiveData) {
      for (const { re, replacement } of SCRUB_PATTERNS) {
        re.lastIndex = 0;
        result = result.replace(re, replacement);
      }
    }
    if (this.scrubInstructionLeaks) {
      for (const { re, replacement } of INSTRUCTION_LEAK_PATTERNS) {
        re.lastIndex = 0;
        result = result.replace(re, replacement);
      }
    }
    // 清理 DSML 工具调用标签（AI 偶尔在文本中输出而非使用 function calling）
    // 兼容全角 ｜(U+FF5C) 和半角 |(U+007C) 竖线
    result = result.replace(/<[｜|]+DSML[｜|]+tool_calls>[\s\S]*?<\/[｜|]+DSML[｜|]+tool_calls>/g, '');
    result = result.replace(/<[｜|]+DSML[｜|]+invoke[^>]*>[\s\S]*?<\/[｜|]+DSML[｜|]+invoke>/g, '');
    result = result.replace(/<[｜|]+DSML[｜|]+parameter[^>]*>[\s\S]*?<\/[｜|]+DSML[｜|]+parameter>/g, '');
    result = result.replace(/<\/?[｜|]+DSML[｜|]+[^>]*>/g, '');
    result = result.replace(/<[｜|][^｜|]*[｜|][^>]*>/g, '');
    return result;
  }

  _scrubFencedContent(text) {
    let result = text;
    if (this.scrubSensitiveData) {
      for (const { re, replacement } of SCRUB_PATTERNS) {
        re.lastIndex = 0;
        result = result.replace(re, replacement);
      }
    }
    return result;
  }
}

function scrubFullText(text, config = {}) {
  if (!text || typeof text !== 'string') return text;

  const scrubber = new StreamingContextScrubber(config);
  return scrubber.process(text) + scrubber.flush();
}

module.exports = { StreamingContextScrubber, scrubFullText, FENCE_OPEN, FENCE_CLOSE };
