const { EventEmitter } = require('events');

const SCRUB_TAGS = [
  { open: '<memory-context>', close: '</memory-context>' },
  { open: '<context-block>', close: '</context-block>' },
  { open: '<system-hint>', close: '</system-hint>' },
  { open: '<internal-note>', close: '</internal-note>' },
  { open: '<memory-context-block', close: '</memory-context-block>' },
  { open: '<!-- memory-context', close: '-->' },
  { open: '<!-- system-instruction', close: '-->' },
  { open: '[MEMORY_CONTEXT]', close: '[/MEMORY_CONTEXT]' },
  { open: '[SYSTEM_HINT]', close: '[/SYSTEM_HINT]' },
  { open: '[INTERNAL]', close: '[/INTERNAL]' },
];

const REPLACEMENT = '[REDACTED]';

const STATES = {
  PLAIN: 'PLAIN',
  TAG_OPEN_MATCH: 'TAG_OPEN_MATCH',
  INSIDE_TAG: 'INSIDE_TAG',
  TAG_CLOSE_MATCH: 'TAG_CLOSE_MATCH',
};

class StreamingContextScrubber extends EventEmitter {
  constructor(config = {}) {
    super();
    this._customTags = config.customTags || [];
    this._replacement = config.replacement || REPLACEMENT;
    this._allTags = [...SCRUB_TAGS, ...this._customTags];
    this._stats = {
      chunksProcessed: 0,
      tagsScrubbed: 0,
      bytesProcessed: 0,
    };
  }

  _buildMatcher() {
    const openers = this._allTags.map(t => t.open);
    const closers = this._allTags.map(t => t.close);
    return { openers, closers };
  }

  scrub(text) {
    if (!text || typeof text !== 'string') return text;

    this._stats.chunksProcessed++;
    this._stats.bytesProcessed += text.length;

    let result = text;

    for (const tag of this._allTags) {
      result = this._scrubTagPair(result, tag);
    }

    return result;
  }

  _scrubTagPair(text, tag) {
    let result = text;
    let startIdx;

    while ((startIdx = result.indexOf(tag.open)) !== -1) {
      const endIdx = result.indexOf(tag.close, startIdx + tag.open.length);

      if (endIdx !== -1) {
        const content = result.substring(startIdx, endIdx + tag.close.length);
        result = result.substring(0, startIdx) + this._replacement + result.substring(endIdx + tag.close.length);
        this._stats.tagsScrubbed++;
        this.emit('scrubbed', { tag: tag.open, contentLength: content.length });
      } else {
        result = result.substring(0, startIdx) + this._replacement;
        this._stats.tagsScrubbed++;
        this.emit('scrubbed:partial', { tag: tag.open });
        break;
      }
    }

    return result;
  }

  createStreamScrubber() {
    return new StreamScrubberSession(this);
  }

  getStats() {
    return { ...this._stats };
  }
}

class StreamScrubberSession {
  constructor(scrubber) {
    this._scrubber = scrubber;
    this._buffer = '';
    this._state = STATES.PLAIN;
    this._matchedTag = null;
    this._matchPos = 0;
    this._output = '';
    this._insideScrub = false;
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'string') return '';

    this._buffer += chunk;
    let emitted = '';

    while (this._buffer.length > 0) {
      let consumed = false;

      switch (this._state) {
        case STATES.PLAIN: {
          const matchResult = this._findOpeningTag();
          if (matchResult.found) {
            emitted += this._buffer.substring(0, matchResult.index);
            this._buffer = this._buffer.substring(matchResult.index);
            this._matchedTag = matchResult.tag;
            this._matchPos = this._matchedTag.open.length;
            this._state = STATES.TAG_OPEN_MATCH;
            this._insideScrub = true;
            consumed = true;
          } else {
            const safeLength = this._buffer.length - this._maxOpenTagLength() + 1;
            if (safeLength > 0) {
              emitted += this._buffer.substring(0, safeLength);
              this._buffer = this._buffer.substring(safeLength);
            } else {
              consumed = false;
            }
          }
          break;
        }

        case STATES.TAG_OPEN_MATCH: {
          const remaining = this._matchedTag.open.substring(this._matchPos);
          if (this._buffer.startsWith(remaining) || remaining.startsWith(this._buffer)) {
            if (this._buffer.length >= remaining.length) {
              this._buffer = this._buffer.substring(remaining.length);
              this._state = STATES.INSIDE_TAG;
              this._matchPos = 0;
              consumed = true;
            } else {
              this._matchPos += this._buffer.length;
              this._buffer = '';
              consumed = true;
            }
          } else {
            this._state = STATES.PLAIN;
            this._insideScrub = false;
            this._matchedTag = null;
          }
          break;
        }

        case STATES.INSIDE_TAG: {
          const closeTag = this._matchedTag.close;
          const closeIdx = this._buffer.indexOf(closeTag);

          if (closeIdx !== -1) {
            this._buffer = this._buffer.substring(closeIdx + closeTag.length);
            emitted += this._scrubber._replacement;
            this._scrubber._stats.tagsScrubbed++;
            this._state = STATES.PLAIN;
            this._insideScrub = false;
            this._matchedTag = null;
            consumed = true;
          } else {
            const safeLength = this._buffer.length - closeTag.length + 1;
            if (safeLength > 0) {
              this._buffer = this._buffer.substring(safeLength);
            } else {
              consumed = false;
            }
          }
          break;
        }

        default:
          this._state = STATES.PLAIN;
          break;
      }

      if (!consumed) break;
    }

    this._scrubber._stats.chunksProcessed++;
    this._scrubber._stats.bytesProcessed += chunk.length;
    this._output += emitted;
    return emitted;
  }

  flush() {
    let remaining = '';
    if (this._insideScrub && this._matchedTag) {
      remaining = this._scrubber._replacement;
      this._scrubber._stats.tagsScrubbed++;
    } else {
      remaining = this._buffer;
    }
    this._buffer = '';
    this._state = STATES.PLAIN;
    this._insideScrub = false;
    this._matchedTag = null;
    this._output += remaining;
    return remaining;
  }

  _findOpeningTag() {
    let bestIndex = Infinity;
    let bestTag = null;

    for (const tag of this._scrubber._allTags) {
      const idx = this._buffer.indexOf(tag.open);
      if (idx !== -1 && idx < bestIndex) {
        bestIndex = idx;
        bestTag = tag;
      }
    }

    if (bestTag) {
      return { found: true, index: bestIndex, tag: bestTag };
    }
    return { found: false };
  }

  _maxOpenTagLength() {
    return Math.max(...this._scrubber._allTags.map(t => t.open.length));
  }
}

module.exports = { StreamingContextScrubber, StreamScrubberSession, SCRUB_TAGS, REPLACEMENT };
