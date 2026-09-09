const { EventEmitter } = require('events');

const LARK_CHAT_TYPES = {
  P2P: 'p2p',
  GROUP: 'group',
  TOPIC: 'topic',
};

const GROUP_MESSAGE_POLICIES = {
  MENTION_ONLY: 'mention_only',
  ALL: 'all',
  MENTION_AND_REPLY: 'mention_and_reply',
  OFF: 'off',
};

const DEFAULT_GROUP_POLICY = GROUP_MESSAGE_POLICIES.MENTION_ONLY;

class LarkGroupRouter extends EventEmitter {
  constructor(config = {}) {
    super();
    this._policy = config.groupPolicy || DEFAULT_GROUP_POLICY;
    this._botOpenId = config.botOpenId || '';
    this._botName = config.botName || '';
    this._groupConfigs = new Map();
    this._stats = {
      totalGroupMessages: 0,
      filteredOut: 0,
      passedThrough: 0,
    };
  }

  setBotIdentity(openId, name) {
    this._botOpenId = openId;
    this._botName = name;
  }

  setGroupPolicy(policy) {
    if (!Object.values(GROUP_MESSAGE_POLICIES).includes(policy)) {
      console.warn(`⚠️ 无效的飞书群聊策略: ${policy}, 使用默认: ${DEFAULT_GROUP_POLICY}`);
      this._policy = DEFAULT_GROUP_POLICY;
      return;
    }
    this._policy = policy;
  }

  setGroupConfig(chatId, config) {
    this._groupConfigs.set(chatId, config);
  }

  removeGroupConfig(chatId) {
    this._groupConfigs.delete(chatId);
  }

  route(event) {
    if (!event) return { shouldProcess: false, reason: 'null_event' };

    const chatType = event.chatType || '';

    if (chatType === LARK_CHAT_TYPES.P2P) {
      this._stats.passedThrough++;
      return {
        shouldProcess: true,
        reason: 'p2p_message',
        extractedContent: event.content,
        chatType: 'p2p',
      };
    }

    if (chatType !== LARK_CHAT_TYPES.GROUP && chatType !== LARK_CHAT_TYPES.TOPIC) {
      this._stats.passedThrough++;
      return {
        shouldProcess: true,
        reason: 'unknown_chat_type',
        extractedContent: event.content,
        chatType,
      };
    }

    this._stats.totalGroupMessages++;

    const groupConfig = this._groupConfigs.get(event.chatId) || {};
    const effectivePolicy = groupConfig.policy || this._policy;

    if (effectivePolicy === GROUP_MESSAGE_POLICIES.OFF) {
      this._stats.filteredOut++;
      return { shouldProcess: false, reason: 'group_policy_off', chatType: 'group' };
    }

    if (effectivePolicy === GROUP_MESSAGE_POLICIES.ALL) {
      this._stats.passedThrough++;
      return {
        shouldProcess: true,
        reason: 'group_policy_all',
        extractedContent: event.content,
        chatType: 'group',
      };
    }

    const mentionInfo = this._extractMentionInfo(event);

    if (effectivePolicy === GROUP_MESSAGE_POLICIES.MENTION_ONLY) {
      if (mentionInfo.isMentioned) {
        this._stats.passedThrough++;
        return {
          shouldProcess: true,
          reason: 'mentioned_in_group',
          extractedContent: mentionInfo.cleanContent,
          chatType: 'group',
          mentionInfo,
        };
      }
      this._stats.filteredOut++;
      return { shouldProcess: false, reason: 'not_mentioned', chatType: 'group' };
    }

    if (effectivePolicy === GROUP_MESSAGE_POLICIES.MENTION_AND_REPLY) {
      if (mentionInfo.isMentioned || mentionInfo.isReply) {
        this._stats.passedThrough++;
        return {
          shouldProcess: true,
          reason: mentionInfo.isMentioned ? 'mentioned_in_group' : 'reply_in_group',
          extractedContent: mentionInfo.cleanContent,
          chatType: 'group',
          mentionInfo,
        };
      }
      this._stats.filteredOut++;
      return { shouldProcess: false, reason: 'not_mentioned_or_reply', chatType: 'group' };
    }

    this._stats.passedThrough++;
    return {
      shouldProcess: true,
      reason: 'default_pass',
      extractedContent: event.content,
      chatType: 'group',
    };
  }

  _extractMentionInfo(event) {
    const result = {
      isMentioned: false,
      isReply: false,
      mentionedUsers: [],
      cleanContent: event.content || '',
    };

    const rawBody = event.rawBody || {};
    const message = rawBody.event?.message || rawBody.message || {};
    const mentions = message.mentions || [];

    if (Array.isArray(mentions) && mentions.length > 0) {
      for (const mention of mentions) {
        const mentionId = mention.id?.open_id || mention.id?.user_id || mention.key || '';
        result.mentionedUsers.push({
          id: mentionId,
          name: mention.name || '',
          key: mention.key || '',
        });

        if (this._botOpenId && mentionId === this._botOpenId) {
          result.isMentioned = true;
        }
      }

      if (!this._botOpenId && mentions.length > 0) {
        result.isMentioned = true;
      }
    }

    const parentMessageId = message.parent_id || rawBody.parent_id;
    if (parentMessageId) {
      result.isReply = true;
    }

    if (result.isMentioned) {
      result.cleanContent = this._stripMentionTags(event.content, mentions);
    }

    return result;
  }

  _stripMentionTags(content, mentions) {
    if (!content) return content;
    let cleaned = content;

    for (const mention of mentions) {
      const mentionKey = mention.key;
      const mentionName = mention.name || '';
      if (mentionKey) {
        cleaned = cleaned.replace(new RegExp(`@_user_${mentionKey}`, 'g'), '');
      }
      if (mentionName && this._botName && mentionName === this._botName) {
        cleaned = cleaned.replace(new RegExp(`@${this._botName}`, 'g'), '');
      }
    }

    return cleaned.trim();
  }

  getStats() {
    return { ...this._stats };
  }

  resetStats() {
    this._stats = {
      totalGroupMessages: 0,
      filteredOut: 0,
      passedThrough: 0,
    };
  }
}

LarkGroupRouter.LARK_CHAT_TYPES = LARK_CHAT_TYPES;
LarkGroupRouter.GROUP_MESSAGE_POLICIES = GROUP_MESSAGE_POLICIES;

module.exports = { LarkGroupRouter, LARK_CHAT_TYPES, LARK_GROUP_MESSAGE_POLICIES: GROUP_MESSAGE_POLICIES };
