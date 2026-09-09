const PROMPT_AUTHORITIES = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  PROJECTION: 'projection',
};

class AssembleResult {
  constructor(options = {}) {
    this.messages = options.messages || [];
    this.promptAuthority = options.promptAuthority || null;
    this.projection = options.projection || null;
    this.tokenBudget = options.tokenBudget || 0;
    this.usedTokens = options.usedTokens || 0;
    this.messageCount = options.messageCount || 0;
    this.totalAvailable = options.totalAvailable || 0;
    this.truncated = options.truncated || false;
    this.metadata = options.metadata || {};
  }

  hasProjection() {
    return this.projection !== null;
  }

  hasPromptAuthority() {
    return this.promptAuthority !== null;
  }

  isTruncated() {
    return this.truncated;
  }

  getUtilization() {
    if (this.tokenBudget === 0) return 0;
    return this.usedTokens / this.tokenBudget;
  }

  toJSON() {
    return {
      messages: this.messages,
      promptAuthority: this.promptAuthority,
      projection: this.projection,
      tokenBudget: this.tokenBudget,
      usedTokens: this.usedTokens,
      messageCount: this.messageCount,
      totalAvailable: this.totalAvailable,
      truncated: this.truncated,
      metadata: this.metadata,
    };
  }

  static fromJSON(json) {
    return new AssembleResult(json);
  }
}

AssembleResult.PROMPT_AUTHORITIES = PROMPT_AUTHORITIES;

module.exports = { AssembleResult, PROMPT_AUTHORITIES };
