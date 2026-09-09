const OPEN_TAG_NAMES = ['think', 'thinking', 'reasoning', 'thought', 'REASONING_SCRATCHPAD'];
const OPEN_TAGS = OPEN_TAG_NAMES.map(n => `<${n}>`);
const CLOSE_TAGS = OPEN_TAG_NAMES.map(n => `</${n}>`);
const MAX_TAG_LEN = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map(t => t.length));

class StreamingThinkScrubber {
  constructor(opts = {}) {
    this._inBlock = false;
    this._buf = '';
    this._lastEmittedEndedNewline = true;
    this.onThinking = opts.onThinking || null;
  }

  reset() {
    this._inBlock = false;
    this._buf = '';
    this._lastEmittedEndedNewline = true;
  }

  feed(text) {
    if (!text) return '';
    let buf = this._buf + text;
    this._buf = '';
    const out = [];

    while (buf) {
      if (this._inBlock) {
        const { idx: closeIdx, len: closeLen } = this._findFirstTag(buf, CLOSE_TAGS);
        if (closeIdx === -1) {
          const held = this._maxPartialSuffix(buf, CLOSE_TAGS);
          const thinkingContent = held ? buf.slice(0, -held) : buf;
          if (thinkingContent && this.onThinking) this.onThinking(thinkingContent);
          this._buf = held ? buf.slice(-held) : '';
          return out.join('');
        }
        const thinkingContent = buf.slice(0, closeIdx);
        if (thinkingContent && this.onThinking) this.onThinking(thinkingContent);
        buf = buf.slice(closeIdx + closeLen);
        this._inBlock = false;
      } else {
        const pair = this._findEarliestClosedPair(buf);
        const { idx: openIdx, len: openLen } = this._findOpenAtBoundary(buf, out);

        if (pair !== null && (openIdx === -1 || pair[0] <= openIdx)) {
          const [startIdx, endIdx] = pair;
          const preceding = buf.slice(0, startIdx);
          if (preceding) {
            const stripped = this._stripOrphanCloseTags(preceding);
            if (stripped) {
              out.push(stripped);
              this._lastEmittedEndedNewline = stripped.endsWith('\n');
            }
          }
          // 提取完整 thinking 块内的内容
          const openTagEnd = buf.indexOf('>', startIdx) + 1;
          const closeTagStart = buf.lastIndexOf('<', endIdx);
          const thinkingContent = buf.slice(openTagEnd, closeTagStart);
          if (thinkingContent && this.onThinking) this.onThinking(thinkingContent);
          buf = buf.slice(endIdx);
          continue;
        }

        if (openIdx !== -1) {
          const preceding = buf.slice(0, openIdx);
          if (preceding) {
            const stripped = this._stripOrphanCloseTags(preceding);
            if (stripped) {
              out.push(stripped);
              this._lastEmittedEndedNewline = stripped.endsWith('\n');
            }
          }
          this._inBlock = true;
          buf = buf.slice(openIdx + openLen);
          continue;
        }

        let held = this._maxPartialSuffix(buf, OPEN_TAGS);
        const heldClose = this._maxPartialSuffix(buf, CLOSE_TAGS);
        held = Math.max(held, heldClose);
        let emitText;
        if (held) {
          emitText = buf.slice(0, -held);
          this._buf = buf.slice(-held);
        } else {
          emitText = buf;
          this._buf = '';
        }
        if (emitText) {
          emitText = this._stripOrphanCloseTags(emitText);
          if (emitText) {
            out.push(emitText);
            this._lastEmittedEndedNewline = emitText.endsWith('\n');
          }
        }
        return out.join('');
      }
    }

    return out.join('');
  }

  flush() {
    if (this._inBlock) {
      this._buf = '';
      this._inBlock = false;
      return '';
    }
    const tail = this._buf;
    this._buf = '';
    if (!tail) return '';
    const stripped = this._stripOrphanCloseTags(tail);
    if (stripped) {
      this._lastEmittedEndedNewline = stripped.endsWith('\n');
    }
    return stripped;
  }

  _findFirstTag(buf, tags) {
    const bufLower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of tags) {
      const idx = bufLower.indexOf(tag.toLowerCase());
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestLen = tag.length;
      }
    }
    return { idx: bestIdx, len: bestLen };
  }

  _findEarliestClosedPair(buf) {
    const bufLower = buf.toLowerCase();
    let best = null;
    for (let i = 0; i < OPEN_TAGS.length; i++) {
      const openLower = OPEN_TAGS[i].toLowerCase();
      const closeLower = CLOSE_TAGS[i].toLowerCase();
      const openIdx = bufLower.indexOf(openLower);
      if (openIdx === -1) continue;
      const closeIdx = bufLower.indexOf(closeLower, openIdx + openLower.length);
      if (closeIdx === -1) continue;
      const endIdx = closeIdx + closeLower.length;
      if (best === null || openIdx < best[0]) {
        best = [openIdx, endIdx];
      }
    }
    return best;
  }

  _findOpenAtBoundary(buf, alreadyEmitted) {
    const bufLower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of OPEN_TAGS) {
      const tagLower = tag.toLowerCase();
      let searchStart = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const idx = bufLower.indexOf(tagLower, searchStart);
        if (idx === -1) break;
        if (this._isBlockBoundary(buf, idx, alreadyEmitted)) {
          if (bestIdx === -1 || idx < bestIdx) {
            bestIdx = idx;
            bestLen = tag.length;
          }
          break;
        }
        searchStart = idx + 1;
      }
    }
    return { idx: bestIdx, len: bestLen };
  }

  _isBlockBoundary(buf, idx, alreadyEmitted) {
    if (idx === 0) {
      if (alreadyEmitted.length > 0) {
        return alreadyEmitted[alreadyEmitted.length - 1].endsWith('\n');
      }
      return this._lastEmittedEndedNewline;
    }
    const preceding = buf.slice(0, idx);
    const lastNl = preceding.lastIndexOf('\n');
    if (lastNl === -1) {
      const priorNewline = alreadyEmitted.length > 0
        ? alreadyEmitted[alreadyEmitted.length - 1].endsWith('\n')
        : this._lastEmittedEndedNewline;
      return priorNewline && preceding.trim() === '';
    }
    return preceding.slice(lastNl + 1).trim() === '';
  }

  _maxPartialSuffix(buf, tags) {
    if (!buf) return 0;
    const bufLower = buf.toLowerCase();
    const maxCheck = Math.min(bufLower.length, MAX_TAG_LEN - 1);
    for (let i = maxCheck; i > 0; i--) {
      const suffix = bufLower.slice(-i);
      for (const tag of tags) {
        const tagLower = tag.toLowerCase();
        if (tagLower.length > i && tagLower.startsWith(suffix)) {
          return i;
        }
      }
    }
    return 0;
  }

  _stripOrphanCloseTags(text) {
    if (!text.includes('</')) return text;
    const textLower = text.toLowerCase();
    const out = [];
    let i = 0;
    while (i < text.length) {
      let matched = false;
      if (textLower.slice(i, i + 2) === '</') {
        for (const tag of CLOSE_TAGS) {
          const tagLower = tag.toLowerCase();
          const tagLen = tagLower.length;
          if (textLower.slice(i, i + tagLen) === tagLower) {
            let j = i + tagLen;
            while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
            i = j;
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        out.push(text[i]);
        i++;
      }
    }
    return out.join('');
  }
}

function stripThinkBlocks(text) {
  if (!text) return text;
  const patterns = [
    /<think>[\s\S]*?<\/think>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<thought>[\s\S]*?<\/thought>/gi,
    /<REASONING_SCRATCHPAD>[\s\S]*?<\/REASONING_SCRATCHPAD>/gi,
  ];
  let result = text;
  for (const p of patterns) {
    result = result.replace(p, '');
  }
  return result.trim();
}

module.exports = { StreamingThinkScrubber, stripThinkBlocks };
