const crypto = require('crypto');
const { EventEmitter } = require('events');

const SESSION_MEMORY_CONFIG = {
  minimumMessageTokensToInit: 10000,
  minimumTokensBetweenUpdate: 5000,
  toolCallsBetweenUpdates: 3
};

const DEFAULT_SESSION_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

const MAX_SECTION_LENGTH = 2000;

class SessionMemory extends EventEmitter {
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    this.sections = this._parseTemplate(DEFAULT_SESSION_TEMPLATE);
    this.messages = [];
    this.context = {};
    this.createdAt = Date.now();
    this.lastAccessed = Date.now();
    this.maxAge = 4 * 60 * 60 * 1000;
    this.tokenCount = 0;
    this.toolCallCount = 0;
    this.lastExtractedUuid = null;
    this.lastExtractedTokenCount = 0;
    this.initialized = false;
  }

  _parseTemplate(template) {
    const sections = {};
    const lines = template.split('\n');
    let currentSection = null;
    let currentContent = [];

    for (const line of lines) {
      if (line.startsWith('# ')) {
        if (currentSection) {
          sections[currentSection].content = currentContent.join('\n').trim();
        }
        currentSection = line.slice(2).trim();
        sections[currentSection] = {
          title: currentSection,
          description: '',
          content: ''
        };
        currentContent = [];
      } else if (line.startsWith('_') && line.endsWith('_') && currentSection) {
        sections[currentSection].description = line.slice(1, -1);
      } else if (currentSection) {
        currentContent.push(line);
      }
    }

    if (currentSection) {
      sections[currentSection].content = currentContent.join('\n').trim();
    }

    return sections;
  }

  addMessage(role, content) {
    this.lastAccessed = Date.now();
    const message = {
      uuid: `msg_${Date.now()}_${crypto.randomBytes(5).toString("hex").slice(0, 9)}`,
      role,
      content,
      timestamp: Date.now()
    };
    this.messages.push(message);
    
    if (this.messages.length > 100) {
      this.messages = this.messages.slice(-100);
    }
    
    this.tokenCount += this._estimateTokens(content);
    return message;
  }

  _estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
  }

  updateSection(sectionName, content) {
    if (this.sections[sectionName]) {
      this.sections[sectionName].content = content;
      this.lastAccessed = Date.now();
      this.emit('section:updated', { section: sectionName, content });
    }
  }

  setContext(key, value) {
    this.context[key] = value;
    this.lastAccessed = Date.now();
  }

  getContext(key) {
    return this.context[key];
  }

  getRecentMessages(limit = 20) {
    return this.messages.slice(-limit);
  }

  shouldExtract() {
    if (!this.initialized) {
      if (this.tokenCount >= SESSION_MEMORY_CONFIG.minimumMessageTokensToInit) {
        this.initialized = true;
        return true;
      }
      return false;
    }

    const tokensSinceLast = this.tokenCount - this.lastExtractedTokenCount;
    const hasMetTokenThreshold = tokensSinceLast >= SESSION_MEMORY_CONFIG.minimumTokensBetweenUpdate;
    const hasMetToolCallThreshold = this.toolCallCount >= SESSION_MEMORY_CONFIG.toolCallsBetweenUpdates;
    
    const hasToolCallsInLastTurn = this.messages.length > 0 && 
      this.messages[this.messages.length - 1].role === 'assistant';

    return (hasMetTokenThreshold && hasMetToolCallThreshold) ||
           (hasMetTokenThreshold && !hasToolCallsInLastTurn);
  }

  markExtracted() {
    this.lastExtractedUuid = this.messages[this.messages.length - 1]?.uuid;
    this.lastExtractedTokenCount = this.tokenCount;
    this.toolCallCount = 0;
  }

  isExpired() {
    return Date.now() - this.lastAccessed > this.maxAge;
  }

  toMarkdown() {
    const lines = [];
    
    // eslint-disable-next-line no-unused-vars
    for (const [name, section] of Object.entries(this.sections)) {
      lines.push(`# ${section.title}`);
      if (section.description) {
        lines.push(`_${section.description}_`);
      }
      lines.push('');
      if (section.content) {
        lines.push(section.content);
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }

  truncateForCompact() {
    const lines = this.toMarkdown().split('\n');
    const maxCharsPerSection = MAX_SECTION_LENGTH * 4;
    const outputLines = [];
    let currentSectionLines = [];
    let currentSectionHeader = '';
    let wasTruncated = false;

    for (const line of lines) {
      if (line.startsWith('# ')) {
        if (currentSectionHeader) {
          const result = this._flushSection(currentSectionHeader, currentSectionLines, maxCharsPerSection);
          outputLines.push(...result.lines);
          wasTruncated = wasTruncated || result.wasTruncated;
        }
        currentSectionHeader = line;
        currentSectionLines = [];
      } else {
        currentSectionLines.push(line);
      }
    }

    if (currentSectionHeader) {
      const result = this._flushSection(currentSectionHeader, currentSectionLines, maxCharsPerSection);
      outputLines.push(...result.lines);
      wasTruncated = wasTruncated || result.wasTruncated;
    }

    return {
      content: outputLines.join('\n'),
      wasTruncated
    };
  }

  _flushSection(sectionHeader, sectionLines, maxChars) {
    if (!sectionHeader) {
      return { lines: sectionLines, wasTruncated: false };
    }

    const sectionContent = sectionLines.join('\n');
    if (sectionContent.length <= maxChars) {
      return { lines: [sectionHeader, ...sectionLines], wasTruncated: false };
    }

    let charCount = 0;
    const keptLines = [sectionHeader];
    for (const line of sectionLines) {
      if (charCount + line.length + 1 > maxChars) break;
      keptLines.push(line);
      charCount += line.length + 1;
    }
    keptLines.push('\n[... section truncated for length ...]');
    return { lines: keptLines, wasTruncated: true };
  }

  export() {
    return {
      sessionId: this.sessionId,
      sections: this.sections,
      messages: this.messages,
      context: this.context,
      createdAt: this.createdAt,
      tokenCount: this.tokenCount,
      messageCount: this.messages.length
    };
  }
}

module.exports = { SessionMemory, DEFAULT_SESSION_TEMPLATE, SESSION_MEMORY_CONFIG, MAX_SECTION_LENGTH };
