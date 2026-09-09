/**
 * 通道适配器集合 — 每个通道一个轻量适配器
 *
 * 设计原则:
 *   - 每个适配器只做两件事: parse（输入→统一消息）和 format（统一回复→输出）
 *   - 不替代现有通道代码，只提供统一接口封装
 *   - 现有代码完全不受影响
 */

class LarkAdapter {
  /**
   * @param {Object} rawInput — 飞书事件服务器解析的事件 { fromUserId, fromUserName, content, chatId, chatType, msgId }
   */
  parse(rawInput) {
    if (!rawInput) return null;
    return {
      userId: rawInput.fromUserId || rawInput.openId || 'lark-user',
      content: rawInput.content || '',
      meta: {
        chatId: rawInput.chatId || null,
        chatType: rawInput.chatType || 'p2p',
        msgId: rawInput.msgId || null,
        fromUserName: rawInput.fromUserName || null,
      },
    };
  }

  format(reply) {
    return {
      content: reply.content || reply,
      larkCard: reply.larkCard || null,
      // 飞书 Markdown 支持，CRABPAW 自动转为飞书 MD 回调
    };
  }
}

class CLIAdapter {
  /**
   * @param {Object} rawInput — { userId, content }
   */
  parse(rawInput) {
    if (!rawInput) return null;
    return {
      userId: rawInput.userId || rawInput.senderId || 'cli-user',
      content: rawInput.content || rawInput.message || '',
      meta: {
        sessionId: rawInput.sessionId || null,
        channel: rawInput.channel || 'cli',
      },
    };
  }

  format(reply) {
    return { content: reply.content || reply };
  }
}

class GUIAdapter {
  /**
   * @param {Object} rawInput — { userId, content, sessionId }
   */
  parse(rawInput) {
    if (!rawInput) return null;
    return {
      userId: rawInput.userId || 'gui-user',
      content: rawInput.content || rawInput.message || '',
      meta: {
        sessionId: rawInput.sessionId || null,
        model: rawInput.model || null,
        attachments: rawInput.attachments || [],
      },
    };
  }

  format(reply) {
    return {
      content: reply.content || reply,
      larkCard: reply.larkCard || null,
      attachments: reply.attachments || [],
    };
  }
}

// ============================================================
// 自动注册所有适配器
// ============================================================

function registerAllAdapters(registry) {
  registry.register('lark', new LarkAdapter());
  registry.register('cli', new CLIAdapter());
  registry.register('gui', new GUIAdapter());
  console.log('[ChannelAdapter] 3 个通道适配器已注册: lark, cli, gui');
}

module.exports = {
  LarkAdapter,
  CLIAdapter,
  GUIAdapter,
  registerAllAdapters,
};
