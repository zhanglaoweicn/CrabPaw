/**
 * Channel Registry Pattern - 渠道注册模式
 */

class PlatformEntry {
  constructor(opts) {
    this.name = opts.name || '';
    this.label = opts.label || '';
    this.adapterFactory = opts.adapterFactory || null;
    this.checkFn = opts.checkFn || null;
    this.validateConfig = opts.validateConfig || null;
    this.isConnected = opts.isConnected || null;
    this.requiredEnv = opts.requiredEnv || [];
    this.installHint = opts.installHint || '';
    this.setupFn = opts.setupFn || null;
    this.source = opts.source || 'builtin';
  }
}

class ChannelRegistry {
  constructor() {
    this.channels = new Map();
    this.aliases = new Map();
    this.metadata = new Map();
    this._platformEntries = new Map();
  }

  register(channel) {
    if (!channel.id) {
      throw new Error('Channel must have an id');
    }

    const normalizedId = channel.id.toLowerCase().trim();
    
    this.channels.set(normalizedId, {
      id: normalizedId,
      label: channel.label || normalizedId,
      description: channel.description || '',
      markdownCapable: channel.markdownCapable ?? false,
      quickstartAllowFrom: channel.quickstartAllowFrom ?? false,
      ...channel,
    });

    if (channel.aliases && Array.isArray(channel.aliases)) {
      for (const alias of channel.aliases) {
        const normalizedAlias = alias.toLowerCase().trim();
        if (normalizedAlias) {
          this.aliases.set(normalizedAlias, normalizedId);
        }
      }
    }

    if (channel.meta) {
      this.metadata.set(normalizedId, channel.meta);
    }

    return this;
  }

  registerPlatform(entry) {
    if (!(entry instanceof PlatformEntry)) {
      entry = new PlatformEntry(entry);
    }
    this._platformEntries.set(entry.name, entry);
    return this;
  }

  getPlatformEntry(name) {
    return this._platformEntries.get(name) || null;
  }

  getConnectedPlatforms() {
    const connected = [];
    for (const [name, entry] of this._platformEntries) {
      let isConn = false;
      if (entry.isConnected) {
        isConn = entry.isConnected();
      } else if (entry.validateConfig) {
        isConn = entry.validateConfig();
      } else if (entry.checkFn) {
        isConn = entry.checkFn();
      }
      if (isConn) {
        connected.push({ name, label: entry.label, source: entry.source });
      }
    }
    return connected;
  }

  getPlatformStatus() {
    const status = [];
    for (const [name, entry] of this._platformEntries) {
      const depsOk = entry.checkFn ? entry.checkFn() : true;
      const configOk = entry.validateConfig ? entry.validateConfig() : null;
      const connected = entry.isConnected ? entry.isConnected() : (depsOk && configOk !== false);
      status.push({
        name,
        label: entry.label,
        source: entry.source,
        dependenciesOk: depsOk,
        configOk,
        connected,
        requiredEnv: entry.requiredEnv,
        installHint: entry.installHint,
      });
    }
    return status;
  }

  resolve(idOrAlias) {
    if (!idOrAlias) return null;
    
    const normalized = idOrAlias.toLowerCase().trim();
    
    if (this.channels.has(normalized)) {
      return this.channels.get(normalized);
    }
    
    const channelId = this.aliases.get(normalized);
    if (channelId) {
      return this.channels.get(channelId);
    }
    
    return null;
  }

  get(id) {
    return this.channels.get(id.toLowerCase().trim());
  }

  has(id) {
    return this.channels.has(id.toLowerCase().trim()) || this.aliases.has(id.toLowerCase().trim());
  }

  list() {
    return [...this.channels.values()];
  }

  listIds() {
    return [...this.channels.keys()];
  }

  listAliases() {
    return [...this.aliases.keys()];
  }

  getMeta(id) {
    const channel = this.resolve(id);
    if (!channel) return null;
    return this.metadata.get(channel.id) || null;
  }

  normalizeChannelId(raw) {
    const channel = this.resolve(raw);
    return channel ? channel.id : null;
  }

  formatChannelPrimerLine(channel) {
    return `${channel.label}: ${channel.description}`;
  }

  formatChannelSelectionLine(channel, docsLink) {
    const docs = channel.docsPath ? docsLink(channel.docsPath, channel.label) : '';
    return `${channel.label} — ${channel.description} ${docs}`.trim();
  }

  /**
   * 启用通道（默认即启用：仅从禁用集合中移除）
   */
  enable(id) {
    const channel = this.resolve(id);
    if (!channel) return { success: false, error: `通道不存在: ${id}` };
    if (this._disabled) this._disabled.delete(channel.id);
    return { success: true, message: '已启用通道: ' + channel.label };
  }

  /**
   * 禁用通道
   */
  disable(id) {
    const channel = this.resolve(id);
    if (!channel) return { success: false, error: `通道不存在: ${id}` };
    this._disabled = this._disabled || new Set();
    this._disabled.add(channel.id);
    return { success: true, message: '已禁用通道: ' + channel.label };
  }

  isEnabled(id) {
    const channel = this.resolve(id);
    if (!channel) return false;
    return !this._disabled || !this._disabled.has(channel.id);
  }

  /**
   * 连通性探测（最简实现）：通道注册校验 + 可选 isConnected 探针
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async test(id) {
    const channel = this.resolve(id);
    if (!channel) return { success: false, error: `通道不存在: ${id}` };
    if (typeof channel.isConnected === 'function') {
      try {
        const connected = await channel.isConnected();
        return connected
          ? { success: true, message: channel.label + ' 连接正常' }
          : { success: false, error: channel.label + ' 未连接（isConnected 返回 false）' };
      } catch (e) {
        return { success: false, error: channel.label + ' 探测失败: ' + e.message };
      }
    }
    return { success: true, message: channel.label + ' 注册正常（无连接探针，仅验证注册表）' };
  }

  clear() {
    this.channels.clear();
    this.aliases.clear();
    this.metadata.clear();
  }
}

class ChannelBuilder {
  constructor(registry) {
    this.registry = registry;
    this.channel = {};
  }

  setId(id) {
    this.channel.id = id;
    return this;
  }

  setLabel(label) {
    this.channel.label = label;
    return this;
  }

  setDescription(description) {
    this.channel.description = description;
    return this;
  }

  setMarkdownCapable(capable) {
    this.channel.markdownCapable = capable;
    return this;
  }

  addAlias(alias) {
    if (!this.channel.aliases) {
      this.channel.aliases = [];
    }
    this.channel.aliases.push(alias);
    return this;
  }

  setMeta(meta) {
    this.channel.meta = meta;
    return this;
  }

  setDocsPath(path) {
    this.channel.docsPath = path;
    return this;
  }

  setQuickstartAllowFrom(allow) {
    this.channel.quickstartAllowFrom = allow;
    return this;
  }

  register() {
    this.registry.register(this.channel);
    return this.channel;
  }
}

const channelRegistry = new ChannelRegistry();

function registerBuiltinChannels() {
  channelRegistry.register({
    id: 'telegram',
    label: 'Telegram',
    description: 'Telegram Bot API',
    aliases: ['tg', 'tele'],
    markdownCapable: true,
    quickstartAllowFrom: true,
  });

  channelRegistry.register({
    id: 'discord',
    label: 'Discord',
    description: 'Discord Bot API',
    aliases: ['dc', 'dis'],
    markdownCapable: true,
    quickstartAllowFrom: true,
  });

  channelRegistry.register({
    id: 'slack',
    label: 'Slack',
    description: 'Slack Bot API',
    aliases: ['sl'],
    markdownCapable: true,
    quickstartAllowFrom: true,
  });

  channelRegistry.register({
    id: 'lark',
    label: 'Feishu (Lark)',
    description: 'Feishu/Lark Bot API',
    aliases: ['feishu', 'fs'],
    markdownCapable: true,
    quickstartAllowFrom: true,
  });

  channelRegistry.register({
    id: 'email',
    label: 'Email',
    description: 'IMAP/SMTP Email Channel',
    aliases: ['mail', 'smtp', 'imap'],
    markdownCapable: true,
    quickstartAllowFrom: false,
  });

  channelRegistry.register({
    id: 'qq',
    label: 'QQ Bot',
    description: 'QQ Bot API',
    aliases: ['qqbot'],
    markdownCapable: true,
    quickstartAllowFrom: false,
  });

  channelRegistry.register({
    id: 'web',
    label: 'Web Chat',
    description: 'Web-based chat interface',
    aliases: ['webchat', 'http'],
    markdownCapable: true,
    quickstartAllowFrom: true,
  });

  channelRegistry.register({
    id: 'cli',
    label: 'CLI',
    description: 'Command-line interface',
    aliases: ['terminal', 'console'],
    markdownCapable: true,
    quickstartAllowFrom: true,
  });
}

registerBuiltinChannels();

module.exports = {
  ChannelRegistry,
  ChannelBuilder,
  PlatformEntry,
  channelRegistry,
  registerBuiltinChannels,
};
