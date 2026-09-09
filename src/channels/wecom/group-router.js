const { EventEmitter } = require('events');

const GROUP_MESSAGE_POLICIES = {
  MENTION_ONLY: 'mention_only',
  ALL: 'all',
  MENTION_AND_REPLY: 'mention_and_reply',
  OFF: 'off',
};

const DEFAULT_GROUP_POLICY = GROUP_MESSAGE_POLICIES.MENTION_ONLY;

class GroupRouter extends EventEmitter {
  constructor(config = {}) {
    super();
    this._policy = config.groupPolicy || DEFAULT_GROUP_POLICY;
    this._botUserId = config.botUserId || '';
    this._botName = config.botName || '';
    this._groupConfigs = new Map();
    this._stats = {
      totalGroupMessages: 0,
      filteredOut: 0,
      passedThrough: 0,
    };
  }

  setBotIdentity(userId, name) {
    this._botUserId = userId;
    this._botName = name;
  }

  setGroupPolicy(policy) {
    if (!Object.values(GROUP_MESSAGE_POLICIES).includes(policy)) {
      console.warn(`⚠️ 无效的群聊策略: ${policy}, 使用默认: ${DEFAULT_GROUP_POLICY}`);
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

    const chatType = event.chatType || event.chat_type || 'single';

    if (chatType === 'single' || chatType === 'direct') {
      this._stats.passedThrough++;
      return {
        shouldProcess: true,
        reason: 'direct_message',
        extractedContent: event.content,
        chatType: 'single',
      };
    }

    if (chatType !== 'group') {
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
    const mentionList = rawBody.mention_list || rawBody.mentioned_list || [];

    if (Array.isArray(mentionList) && mentionList.length > 0) {
      result.mentionedUsers = mentionList;
      if (this._botUserId && mentionList.includes(this._botUserId)) {
        result.isMentioned = true;
      }
      if (!this._botUserId && mentionList.length > 0) {
        result.isMentioned = true;
      }
    }

    if (rawBody.reply_to || rawBody.reply_msgid) {
      result.isReply = true;
    }

    if (result.isMentioned) {
      result.cleanContent = this._stripMentionTags(event.content, mentionList);
    }

    return result;
  }

  _stripMentionTags(content, mentionList) {
    if (!content) return content;
    // 2026-09-06 修复: 原实现只要机器人被提及就把所有 @某人 前缀一并剥掉
    // （mentionList.includes(botUserId) 对每个 match 恒真）——改为只剥
    // 机器人自己的 @<botName>
    let cleaned = content;
    if (this._botName) {
      const escaped = String(this._botName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(`@${escaped}\\s?`, 'g'), '');
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

GroupRouter.GROUP_MESSAGE_POLICIES = GROUP_MESSAGE_POLICIES;
GroupRouter.DEFAULT_GROUP_POLICY = DEFAULT_GROUP_POLICY;

module.exports = { GroupRouter, GROUP_MESSAGE_POLICIES };
