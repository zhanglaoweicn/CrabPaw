const { EventEmitter } = require('events');

const GLOBAL_NAMESPACE = 'global';

const NAMESPACE_CONFIGS = {
  global: { priority: 0, description: '全局共享命名空间', isolation: 'shared' },
  personal: { priority: 10, description: '用户个人命名空间', isolation: 'strict' },
  project: { priority: 20, description: '项目工作区命名空间', isolation: 'strict' },
  session: { priority: 30, description: '会话级临时命名空间', isolation: 'ephemeral' },
  agent: { priority: 40, description: 'Agent专属命名空间', isolation: 'strict' },
  channel: { priority: 50, description: '通道专属命名空间', isolation: 'strict' },
  skill: { priority: 60, description: '技能专属命名空间', isolation: 'sandboxed' },
  system: { priority: 100, description: '系统内部命名空间', isolation: 'internal' },
};

const ISOLATION_LEVELS = {
  shared: { crossRead: true, crossWrite: false, inheritFrom: ['global'] },
  strict: { crossRead: true, crossWrite: false, inheritFrom: ['global'] },
  ephemeral: { crossRead: true, crossWrite: false, inheritFrom: ['global'], ttl: 3600 },
  sandboxed: { crossRead: false, crossWrite: false, inheritFrom: [] },
  internal: { crossRead: false, crossWrite: false, inheritFrom: [] },
};

class NamespaceManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._namespaces = new Map();
    this._aliases = new Map();
    this._accessLog = [];
    this._maxAccessLog = 1000;
    this._store = config.store || null;

    for (const [name, cfg] of Object.entries(NAMESPACE_CONFIGS)) {
      this._namespaces.set(name, {
        name,
        ...cfg,
        isolation: ISOLATION_LEVELS[cfg.isolation] || ISOLATION_LEVELS.strict,
        createdAt: Date.now(),
        stats: { reads: 0, writes: 0, queries: 0 },
      });
    }
  }

  resolve(namespace) {
    if (!namespace || namespace.trim() === '') return GLOBAL_NAMESPACE;
    if (this._aliases.has(namespace)) return this._aliases.get(namespace);
    if (this._namespaces.has(namespace)) return namespace;
    return namespace;
  }

  create(namespace, config = {}) {
    if (this._namespaces.has(namespace)) {
      return this._namespaces.get(namespace);
    }

    const isolationLevel = config.isolation || 'strict';
    const ns = {
      name: namespace,
      priority: config.priority || 50,
      description: config.description || `自定义命名空间: ${namespace}`,
      isolation: ISOLATION_LEVELS[isolationLevel] || ISOLATION_LEVELS.strict,
      isolationName: isolationLevel,
      parent: config.parent || null,
      inheritFrom: config.inheritFrom || ['global'],
      createdAt: Date.now(),
      stats: { reads: 0, writes: 0, queries: 0 },
    };

    this._namespaces.set(namespace, ns);
    this.emit('namespace:created', { namespace, config: ns });
    return ns;
  }

  createAlias(alias, target) {
    if (!this._namespaces.has(target)) {
      throw new Error(`Target namespace "${target}" does not exist`);
    }
    this._aliases.set(alias, target);
    this.emit('namespace:alias_created', { alias, target });
  }

  delete(namespace) {
    if (namespace === GLOBAL_NAMESPACE) {
      throw new Error('Cannot delete the global namespace');
    }
    const ns = this._namespaces.get(namespace);
    if (!ns) return false;

    this._namespaces.delete(namespace);
    for (const [alias, target] of this._aliases) {
      if (target === namespace) this._aliases.delete(alias);
    }

    this.emit('namespace:deleted', { namespace });
    return true;
  }

  canRead(namespace, fromNamespace) {
    const ns = this._namespaces.get(namespace);
    if (!ns) return true;

    if (namespace === fromNamespace) return true;
    if (ns.isolation.crossRead) return true;
    if (ns.inheritFrom && ns.inheritFrom.includes(fromNamespace)) return true;

    return false;
  }

  canWrite(namespace, fromNamespace) {
    const ns = this._namespaces.get(namespace);
    if (!ns) return namespace === fromNamespace;

    if (namespace === fromNamespace) return true;
    if (ns.isolation.crossWrite) return true;

    return false;
  }

  getReadableNamespaces(fromNamespace) {
    const result = new Set();

    // eslint-disable-next-line no-unused-vars
    for (const [name, ns] of this._namespaces) {
      if (this.canRead(name, fromNamespace)) {
        result.add(name);
      }
    }

    if (ns_inherits(fromNamespace)) {
      const fromNs = this._namespaces.get(fromNamespace);
      if (fromNs && fromNs.inheritFrom) {
        for (const parent of fromNs.inheritFrom) {
          result.add(parent);
        }
      }
    }

    return [...result];
  }

  getInheritanceChain(namespace) {
    const chain = [namespace];
    const ns = this._namespaces.get(namespace);
    if (ns && ns.inheritFrom) {
      for (const parent of ns.inheritFrom) {
        if (!chain.includes(parent)) {
          chain.push(parent);
          const parentChain = this.getInheritanceChain(parent);
          for (const p of parentChain) {
            if (!chain.includes(p)) chain.push(p);
          }
        }
      }
    }
    return chain;
  }

  recordAccess(namespace, operation) {
    const ns = this._namespaces.get(namespace);
    if (ns) {
      if (operation === 'read') ns.stats.reads++;
      else if (operation === 'write') ns.stats.writes++;
      else if (operation === 'query') ns.stats.queries++;
    }

    this._accessLog.push({
      namespace,
      operation,
      timestamp: Date.now(),
    });
    if (this._accessLog.length > this._maxAccessLog) {
      this._accessLog = this._accessLog.slice(-this._maxAccessLog);
    }
  }

  getStats() {
    const stats = {};
    for (const [name, ns] of this._namespaces) {
      stats[name] = { ...ns.stats, isolation: ns.isolationName || ns.isolation };
    }
    return stats;
  }

  list() {
    return [...this._namespaces.entries()].map(([name, ns]) => ({
      name,
      priority: ns.priority,
      description: ns.description,
      isolation: ns.isolationName || ns.isolation,
      parent: ns.parent,
      inheritFrom: ns.inheritFrom,
    }));
  }

  get(namespace) {
    return this._namespaces.get(namespace) || null;
  }

  exists(namespace) {
    return this._namespaces.has(namespace) || this._aliases.has(namespace);
  }
}

function ns_inherits(namespace) {
  return namespace && namespace !== GLOBAL_NAMESPACE;
}

function buildNamespaceKey(namespace, key) {
  return `${namespace}:${key}`;
}

function parseNamespaceKey(combined) {
  const idx = combined.indexOf(':');
  if (idx === -1) return { namespace: GLOBAL_NAMESPACE, key: combined };
  return { namespace: combined.slice(0, idx), key: combined.slice(idx + 1) };
}

module.exports = {
  NamespaceManager,
  GLOBAL_NAMESPACE,
  NAMESPACE_CONFIGS,
  ISOLATION_LEVELS,
  buildNamespaceKey,
  parseNamespaceKey,
};
