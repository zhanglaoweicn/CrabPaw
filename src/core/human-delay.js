const CHANNEL_DELAY_PROFILES = {
  feishu: { minMs: 800, maxMs: 2500, typingIndicator: true },
  wecom: { minMs: 800, maxMs: 2500, typingIndicator: true },
  qq: { minMs: 600, maxMs: 2000, typingIndicator: false },
  sms: { minMs: 200, maxMs: 500, typingIndicator: false },
  email: { minMs: 0, maxMs: 0, typingIndicator: false },
  cli: { minMs: 0, maxMs: 0, typingIndicator: false },
  api: { minMs: 0, maxMs: 0, typingIndicator: false },
};

const CONTENT_LENGTH_DELAY = {
  short: { maxChars: 50, extraMs: 0 },
  medium: { maxChars: 200, extraMs: 500 },
  long: { maxChars: 500, extraMs: 1000 },
  veryLong: { maxChars: Infinity, extraMs: 1500 },
};

class HumanDelaySimulator {
  constructor() {
    this._enabled = true;
    this._channelOverrides = new Map();
    this._stats = { totalDelays: 0, totalDelayMs: 0 };
  }

  setEnabled(enabled) {
    this._enabled = enabled;
  }

  setChannelOverride(channel, profile) {
    this._channelOverrides.set(channel, profile);
  }

  removeChannelOverride(channel) {
    this._channelOverrides.delete(channel);
  }

  calculateDelay(params) {
    const { channel, contentLength, isToolCall, isFollowUp } = params;

    if (!this._enabled) return 0;

    const profile = this._channelOverrides.get(channel) || CHANNEL_DELAY_PROFILES[channel];
    if (!profile || profile.minMs === 0 && profile.maxMs === 0) return 0;

    let delay = profile.minMs + Math.random() * (profile.maxMs - profile.minMs);

    if (contentLength !== undefined) {
      for (const [, tier] of Object.entries(CONTENT_LENGTH_DELAY)) {
        if (contentLength <= tier.maxChars) {
          delay += tier.extraMs * (0.5 + Math.random() * 0.5);
          break;
        }
      }
    }

    if (isToolCall) {
      delay *= 0.5;
    }

    if (isFollowUp) {
      delay *= 0.7;
    }

    return Math.round(delay);
  }

  async wait(params) {
    const delay = this.calculateDelay(params);
    if (delay <= 0) return 0;

    this._stats.totalDelays++;
    this._stats.totalDelayMs += delay;

    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(delay), delay);
      if (timer.unref) timer.unref();
    });
  }

  getStats() {
    return {
      ...this._stats,
      avgDelayMs: this._stats.totalDelays > 0
        ? Math.round(this._stats.totalDelayMs / this._stats.totalDelays)
        : 0,
    };
  }
}

const globalHumanDelay = new HumanDelaySimulator();

module.exports = {
  HumanDelaySimulator,
  globalHumanDelay,
  CHANNEL_DELAY_PROFILES,
  CONTENT_LENGTH_DELAY,
};
