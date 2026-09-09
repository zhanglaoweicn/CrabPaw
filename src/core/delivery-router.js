const MAX_PLATFORM_OUTPUT = 4000;
const TRUNCATED_VISIBLE = 3800;

const PLATFORMS = {
  FEISHU: 'feishu',
  WECOM: 'wecom',
  QQ: 'qq',
  SMS: 'sms',
  EMAIL: 'email',
  CLI: 'cli',
  LOCAL: 'local',
};

class DeliveryTarget {
  constructor({ platform, chatId, threadId, isOrigin, isExplicit }) {
    this.platform = platform || PLATFORMS.LOCAL;
    this.chatId = chatId || null;
    this.threadId = threadId || null;
    this.isOrigin = isOrigin || false;
    this.isExplicit = isExplicit || false;
  }

  static parse(target, origin) {
    const stripped = (target || '').trim();
    const lower = stripped.toLowerCase();
    if (lower === 'origin') {
      if (origin) {
        return new DeliveryTarget({
          platform: origin.platform,
          chatId: origin.chatId,
          threadId: origin.threadId,
          isOrigin: true,
        });
      }
      return new DeliveryTarget({ platform: PLATFORMS.LOCAL, isOrigin: true });
    }
    if (lower === 'local') {
      return new DeliveryTarget({ platform: PLATFORMS.LOCAL });
    }
    if (stripped.includes(':')) {
      const parts = stripped.split(':');
      const platformStr = parts[0].toLowerCase();
      const chatId = parts[1] || null;
      const threadId = parts[2] || null;
      return new DeliveryTarget({
        platform: platformStr,
        chatId,
        threadId,
        isExplicit: true,
      });
    }
    if (Object.values(PLATFORMS).includes(lower)) {
      return new DeliveryTarget({ platform: lower });
    }
    return new DeliveryTarget({ platform: PLATFORMS.LOCAL });
  }
}

class DeliveryRouter {
  constructor(config) {
    this.config = config || {};
    this._homeChannels = this._buildHomeChannels();
  }

  _buildHomeChannels() {
    const channels = {};
    const pushTargets = this.config.pushTargets || [];
    for (const target of pushTargets) {
      const parsed = DeliveryTarget.parse(target);
      if (parsed.platform && parsed.chatId) {
        channels[parsed.platform] = { chatId: parsed.chatId, threadId: parsed.threadId };
      }
    }
    return channels;
  }

  resolveTargets({ targets, origin }) {
    if (!targets || targets.length === 0) {
      if (origin) {
        return [new DeliveryTarget({
          platform: origin.platform,
          chatId: origin.chatId,
          threadId: origin.threadId,
          isOrigin: true,
        })];
      }
      return [new DeliveryTarget({ platform: PLATFORMS.LOCAL })];
    }
    return targets.map(t => DeliveryTarget.parse(t, origin));
  }

  truncateForPlatform(text, platform) {
    if (!text) return text;
    if (platform === PLATFORMS.SMS) {
      return text.length > 1600 ? text.substring(0, 1500) + '...' : text;
    }
    if (text.length > MAX_PLATFORM_OUTPUT) {
      return text.substring(0, TRUNCATED_VISIBLE) + '\n\n... (输出已截断)';
    }
    return text;
  }

  getHomeChannel(platform) {
    return this._homeChannels[platform] || null;
  }
}

module.exports = {
  DeliveryTarget,
  DeliveryRouter,
  PLATFORMS,
  MAX_PLATFORM_OUTPUT,
};
