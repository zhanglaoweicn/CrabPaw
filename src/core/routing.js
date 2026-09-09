/**
 * Routing Cache Pattern - 路由缓存模式
 */

class RoutingCache {
  constructor(maxSize = 4000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const value = this.cache.get(key);
    if (value) {
      this.hits++;
      return { ...value };
    }
    this.misses++;
    return null;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }
    this.cache.set(key, { ...value, cachedAt: Date.now() });
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  evictOldest() {
    const keys = [...this.cache.keys()];
    const evictCount = Math.floor(this.maxSize * 0.1);
    for (let i = 0; i < evictCount && i < keys.length; i++) {
      this.cache.delete(keys[i]);
    }
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total * 100).toFixed(2) + '%' : '0%',
    };
  }
}

class RouteResolver {
  constructor() {
    this.cache = new RoutingCache();
    this.bindings = [];
    this.agents = new Map();
  }

  normalizeToken(value) {
    return (value || '').trim().toLowerCase();
  }

  normalizeId(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'bigint') return String(value).trim();
    return '';
  }

  buildRouteKey(params) {
    const parts = [
      this.normalizeToken(params.channel),
      this.normalizeId(params.accountId) || 'default',
      params.peer ? `${params.peer.kind}:${params.peer.id}` : '-',
      params.guildId || '-',
      params.teamId || '-',
    ];
    return parts.join('\t');
  }

  resolveAgentRoute(params) {
    const key = this.buildRouteKey(params);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const route = this.computeRoute(params);
    this.cache.set(key, route);
    return route;
  }

  computeRoute(params) {
    const channel = this.normalizeToken(params.channel);
    const accountId = this.normalizeId(params.accountId) || 'default';
    const peer = params.peer || null;
    const guildId = this.normalizeId(params.guildId) || null;
    const teamId = this.normalizeId(params.teamId) || null;

    const matchedBinding = this.matchBinding({ channel, accountId, peer, guildId, teamId });
    
    if (matchedBinding) {
      return this.buildRouteFromBinding(matchedBinding, channel, accountId, peer);
    }

    return this.buildDefaultRoute(channel, accountId, peer);
  }

  matchBinding(context) {
    for (const binding of this.bindings) {
      if (this.matchesBinding(binding, context)) {
        return binding;
      }
    }
    return null;
  }

  matchesBinding(binding, context) {
    const match = binding.match || {};
    
    if (match.channel && this.normalizeToken(match.channel) !== context.channel) {
      return false;
    }
    
    if (match.accountId && this.normalizeId(match.accountId) !== context.accountId) {
      return false;
    }
    
    if (match.peer && context.peer) {
      const peerMatch = match.peer;
      if (peerMatch.kind && peerMatch.kind !== context.peer.kind) return false;
      if (peerMatch.id && this.normalizeId(peerMatch.id) !== context.peer.id) return false;
    }
    
    if (match.guildId && this.normalizeId(match.guildId) !== context.guildId) {
      return false;
    }
    
    if (match.teamId && this.normalizeId(match.teamId) !== context.teamId) {
      return false;
    }
    
    return true;
  }

  buildRouteFromBinding(binding, channel, accountId, peer) {
    const agentId = binding.agentId || 'default';
    const sessionKey = this.buildSessionKey(agentId, channel, accountId, peer);
    const mainSessionKey = this.buildSessionKey(agentId, 'main', 'default', null);
    
    return {
      agentId,
      channel,
      accountId,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: sessionKey === mainSessionKey ? 'main' : 'session',
      matchedBy: binding.matchedBy || 'binding',
    };
  }

  buildDefaultRoute(channel, accountId, peer) {
    const agentId = 'default';
    const sessionKey = this.buildSessionKey(agentId, channel, accountId, peer);
    const mainSessionKey = this.buildSessionKey(agentId, 'main', 'default', null);
    
    return {
      agentId,
      channel,
      accountId,
      sessionKey,
      mainSessionKey,
      lastRoutePolicy: sessionKey === mainSessionKey ? 'main' : 'session',
      matchedBy: 'default',
    };
  }

  buildSessionKey(agentId, channel, accountId, peer) {
    const parts = [
      'agent',
      agentId.toLowerCase(),
      channel.toLowerCase(),
      accountId.toLowerCase(),
    ];
    
    if (peer) {
      parts.push(`${peer.kind}:${peer.id}`);
    }
    
    return parts.join(':');
  }

  registerBinding(binding) {
    this.bindings.push(binding);
  }

  registerAgent(agentId, agentConfig) {
    this.agents.set(agentId.toLowerCase(), agentConfig);
  }

  clearBindings() {
    this.bindings = [];
  }

  getCacheStats() {
    return this.cache.getStats();
  }
}

class SessionKeyBuilder {
  static build(params) {
    const { agentId, channel, accountId, peer, dmScope = 'main' } = params;
    
    const normalizedAgentId = agentId.toLowerCase().trim();
    const normalizedChannel = channel.toLowerCase().trim();
    const normalizedAccountId = (accountId || 'default').toLowerCase().trim();
    
    if (dmScope === 'main') {
      return `agent:${normalizedAgentId}:main:main`;
    }
    
    if (dmScope === 'per-peer' && peer) {
      return `agent:${normalizedAgentId}:${normalizedChannel}:${peer.kind}:${peer.id}`;
    }
    
    if (dmScope === 'per-channel-peer' && peer) {
      return `agent:${normalizedAgentId}:${normalizedChannel}:${normalizedAccountId}:${peer.kind}:${peer.id}`;
    }
    
    return `agent:${normalizedAgentId}:${normalizedChannel}:${normalizedAccountId}`;
  }

  static parse(sessionKey) {
    const parts = sessionKey.split(':');
    if (parts.length < 4 || parts[0] !== 'agent') {
      return null;
    }
    
    return {
      agentId: parts[1],
      channel: parts[2],
      accountId: parts[3],
      peer: parts.length > 4 ? { kind: parts[4], id: parts[5] } : null,
    };
  }
}

const routeResolver = new RouteResolver();

module.exports = {
  RoutingCache,
  RouteResolver,
  SessionKeyBuilder,
  routeResolver,
};
