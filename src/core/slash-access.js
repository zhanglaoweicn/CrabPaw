const ALWAYS_ALLOWED_COMMANDS = new Set(['help', 'whoami', 'status']);

const DM_CHAT_TYPES = new Set(['dm', 'direct', 'private', '']);

class SlashAccessPolicy {
  constructor({ enabled = false, adminUserIds = new Set(), userAllowedCommands = new Set() } = {}) {
    this.enabled = enabled;
    this.adminUserIds = adminUserIds;
    this.userAllowedCommands = userAllowedCommands;
  }

  isAdmin(userId) {
    if (!this.enabled) return true;
    if (!userId) return false;
    return this.adminUserIds.has(String(userId));
  }

  canRun(userId, commandName) {
    if (!this.enabled) return true;
    if (this.isAdmin(userId)) return true;
    if (!commandName) return false;
    const canonical = commandName.replace(/^\/+/, '').toLowerCase();
    if (ALWAYS_ALLOWED_COMMANDS.has(canonical)) return true;
    return this.userAllowedCommands.has(canonical);
  }

  toJSON() {
    return {
      enabled: this.enabled,
      adminUserIds: [...this.adminUserIds],
      userAllowedCommands: [...this.userAllowedCommands],
    };
  }
}

function coerceIdList(raw) {
  if (!raw) return new Set();
  if (typeof raw === 'string') {
    return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (Array.isArray(raw)) {
    return new Set(raw.map(s => String(s).trim()).filter(Boolean));
  }
  if (raw instanceof Set) return raw;
  return new Set([String(raw).trim()].filter(Boolean));
}

function coerceCommandList(raw) {
  if (!raw) return new Set();
  let items;
  if (typeof raw === 'string') {
    items = raw.split(',').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(raw)) {
    items = raw.map(s => String(s).trim()).filter(Boolean);
  } else if (raw instanceof Set) {
    items = [...raw];
  } else {
    items = [String(raw).trim()].filter(Boolean);
  }
  return new Set(items.map(s => s.replace(/^\/+/, '').toLowerCase()));
}

function scopeForChatType(chatType) {
  if (chatType && DM_CHAT_TYPES.has(chatType.toLowerCase())) return 'dm';
  return 'group';
}

class SlashAccessControl {
  constructor(config = {}) {
    this._policies = new Map();
    this._loadConfig(config);
  }

  _loadConfig(config) {
    if (!config || typeof config !== 'object') return;

    const platforms = config.platforms || config;
    for (const [platName, platConfig] of Object.entries(platforms)) {
      if (!platConfig || typeof platConfig !== 'object') continue;

      for (const scope of ['dm', 'group']) {
        const scopeConfig = platConfig[scope] || {};
        const adminFrom = scopeConfig.allow_admin_from || scopeConfig.adminFrom;
        const userCommands = scopeConfig.user_allowed_commands || scopeConfig.userAllowedCommands;

        if (!adminFrom && !userCommands) continue;

        const policy = new SlashAccessPolicy({
          enabled: true,
          adminUserIds: coerceIdList(adminFrom),
          userAllowedCommands: coerceCommandList(userCommands),
        });

        this._policies.set(`${platName}:${scope}`, policy);
      }
    }
  }

  getPolicy(platform, chatType) {
    const scope = scopeForChatType(chatType);
    const key = `${platform}:${scope}`;
    let policy = this._policies.get(key);
    if (!policy) {
      policy = this._policies.get(`${platform}:*`);
    }
    if (!policy) {
      policy = new SlashAccessPolicy({ enabled: false });
    }
    return policy;
  }

  canRunCommand(userId, commandName, platform, chatType) {
    const policy = this.getPolicy(platform, chatType);
    return policy.canRun(userId, commandName);
  }

  isAdmin(userId, platform, chatType) {
    const policy = this.getPolicy(platform, chatType);
    return policy.isAdmin(userId);
  }

  addPolicy(platform, scope, { adminUserIds, userAllowedCommands } = {}) {
    const policy = new SlashAccessPolicy({
      enabled: true,
      adminUserIds: coerceIdList(adminUserIds),
      userAllowedCommands: coerceCommandList(userAllowedCommands),
    });
    this._policies.set(`${platform}:${scope}`, policy);
    return policy;
  }

  removePolicy(platform, scope) {
    this._policies.delete(`${platform}:${scope}`);
  }

  listPolicies() {
    const result = [];
    for (const [key, policy] of this._policies) {
      const [platform, scope] = key.split(':');
      result.push({ platform, scope, ...policy.toJSON() });
    }
    return result;
  }
}

let _instance = null;

function getSlashAccessControl(config) {
  if (!_instance) {
    _instance = new SlashAccessControl(config);
  }
  return _instance;
}

module.exports = {
  SlashAccessPolicy,
  SlashAccessControl,
  getSlashAccessControl,
  coerceIdList,
  coerceCommandList,
  scopeForChatType,
  ALWAYS_ALLOWED_COMMANDS,
};
