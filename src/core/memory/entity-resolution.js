const crypto = require('crypto');
/**
 * Entity Resolution System
 * 
 * 实体解析 — 将对话中的模糊指代解析为已知实体。
 * 自动提取文本中的实体并关联记忆
 * 
 * 支持的实体类型：
 * - person: 人名
 * - project: 项目名
 * - technology: 技术名
 * - organization: 组织/公司名
 * - location: 地点
 * - date: 日期
 * - concept: 概念/关键词
 */

const EventEmitter = require('events');

const ENTITY_PATTERNS = {
  person: [
    /(?:called|named|by|author|developer|user|manager|lead)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:said|mentioned|told|wrote|created|built|fixed)/g,
    /@([a-zA-Z0-9_-]+)/g,
  ],
  
  project: [
    /(?:project|repo|repository|app|application)\s+["']?([a-zA-Z0-9_-]+)["']?/gi,
    /([a-zA-Z][a-zA-Z0-9_-]*)\s+(?:project|repo|repository|app)/gi,
    /(?:in|on|for)\s+([a-zA-Z][a-zA-Z0-9_-]{2,})\s+(?:project|repo|codebase)/gi,
  ],
  
  technology: [
    /\b(React|Vue|Angular|Svelte|Next\.js|Nuxt|Gatsby|Express|Fastify|NestJS|Django|Flask|FastAPI|Spring|Rails|Laravel)\b/g,
    /\b(TypeScript|JavaScript|Python|Java|Go|Rust|C\+\+|C#|Ruby|PHP|Kotlin|Swift)\b/g,
    /\b(PostgreSQL|MySQL|MongoDB|Redis|SQLite|DynamoDB|Cassandra)\b/g,
    /\b(Docker|Kubernetes|AWS|GCP|Azure|Terraform|Ansible)\b/g,
    /\b(GitHub|GitLab|Bitbucket|Jenkins|CircleCI|Travis)\b/g,
  ],
  
  organization: [
    /(?:at|from|by|work(?:ing)?\s+(?:at|for))\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g,
    /([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+(?:team|company|org|organization)/g,
  ],
  
  location: [
    /(?:in|at|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)(?:\s+(?:office|branch|location))?/g,
    /(?:remote|onsite|hybrid)\s+(?:in|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
  ],
  
  date: [
    /\b(\d{4}-\d{2}-\d{2})\b/g,
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g,
    /\b((?:next|this|last)\s+(?:week|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/gi,
    /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/g,
  ],
  
  concept: [
    /(?:about|regarding|concerning|on the topic of)\s+([a-z]+(?:\s+[a-z]+)?)/gi,
    /(?:key|important|critical|main|primary)\s+(?:concept|idea|point|topic):\s*([^.]+)/gi,
  ],
};

const AKA_PATTERNS = [
  /(\w+(?:\s+\w+)*)\s+(?:aka|also known as|a\.k\.a\.|AKA)\s+(\w+(?:\s+\w+)*)/gi,
  /(\w+(?:\s+\w+)*)\s+\(([^)]+)\)/g,
];

class EntityExtractor extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      minEntityLength: config.minEntityLength || 2,
      maxEntityLength: config.maxEntityLength || 100,
      deduplicate: config.deduplicate !== false,
      ...config,
    };
    this._entityCache = new Map();
  }

  extract(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const entities = [];

    for (const [type, patterns] of Object.entries(ENTITY_PATTERNS)) {
      for (const pattern of patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;

        while ((match = regex.exec(text)) !== null) {
          const name = (match[1] || match[0]).trim();
          
          if (this._isValidEntity(name, type)) {
            entities.push({
              name,
              type,
              matched: match[0],
              startIndex: match.index,
              endIndex: match.index + match[0].length,
            });
          }
        }
      }
    }

    const aliases = this._extractAliases(text);
    for (const alias of aliases) {
      entities.push({
        name: alias.primary,
        type: 'alias',
        aliases: alias.aliases,
        matched: alias.matched,
      });
    }

    return this._deduplicate(entities);
  }

  _isValidEntity(name, _type) {
    if (!name || name.length < this.config.minEntityLength) {
      return false;
    }
    if (name.length > this.config.maxEntityLength) {
      return false;
    }
    if (/^\d+$/.test(name)) {
      return false;
    }
    const stopWords = ['the', 'a', 'an', 'this', 'that', 'it', 'is', 'are', 'was', 'were'];
    if (stopWords.includes(name.toLowerCase())) {
      return false;
    }

    return true;
  }

  _extractAliases(text) {
    const aliases = [];

    for (const pattern of AKA_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;

      while ((match = regex.exec(text)) !== null) {
        const primary = match[1].trim();
        const secondary = match[2].trim();

        if (primary && secondary) {
          aliases.push({
            primary,
            aliases: [secondary],
            matched: match[0],
          });
        }
      }
    }

    return aliases;
  }

  _deduplicate(entities) {
    if (!this.config.deduplicate) {
      return entities;
    }

    const seen = new Map();

    for (const entity of entities) {
      const key = `${entity.type}:${entity.name.toLowerCase()}`;
      
      if (!seen.has(key)) {
        seen.set(key, entity);
      } else {
        const existing = seen.get(key);
        if (entity.aliases) {
          existing.aliases = [
            ...(existing.aliases || []),
            ...entity.aliases,
          ];
        }
      }
    }

    return Array.from(seen.values());
  }

  extractWithConfidence(text) {
    const entities = this.extract(text);
    
    return entities.map(entity => ({
      ...entity,
      confidence: this._calculateConfidence(entity, text),
    }));
  }

  _calculateConfidence(entity, text) {
    let confidence = 0.5;

    if (entity.matched) {
      const contextStart = Math.max(0, entity.startIndex - 50);
      const contextEnd = Math.min(text.length, entity.endIndex + 50);
      const context = text.slice(contextStart, contextEnd).toLowerCase();

      const strongIndicators = ['named', 'called', 'by', 'author', 'project', 'team'];
      for (const indicator of strongIndicators) {
        if (context.includes(indicator)) {
          confidence += 0.1;
        }
      }
    }

    if (entity.type === 'technology') {
      confidence += 0.2;
    }

    if (entity.aliases && entity.aliases.length > 0) {
      confidence += 0.1;
    }

    return Math.min(1.0, confidence);
  }
}

class EntityResolver extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      similarityThreshold: config.similarityThreshold || 0.8,
      ...config,
    };
    this._entities = new Map();
    this._aliases = new Map();
    this._factEntities = new Map();
  }

  registerEntity(entity) {
    const key = this._normalizeEntityName(entity.name);
    
    if (!this._entities.has(key)) {
      this._entities.set(key, {
        id: `ent_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
        name: entity.name,
        type: entity.type,
        aliases: entity.aliases || [],
        factCount: 0,
        createdAt: Date.now(),
      });
    }

    const existing = this._entities.get(key);
    
    if (entity.aliases) {
      for (const alias of entity.aliases) {
        const aliasKey = this._normalizeEntityName(alias);
        this._aliases.set(aliasKey, existing.id);
      }
    }

    return existing;
  }

  _normalizeEntityName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
      .trim();
  }

  resolve(name) {
    const key = this._normalizeEntityName(name);
    
    if (this._entities.has(key)) {
      return this._entities.get(key);
    }

    if (this._aliases.has(key)) {
      const entityId = this._aliases.get(key);
      return this._entities.get(entityId);
    }

    return null;
  }

  linkFactToEntity(factId, entityId) {
    if (!entityId) return false;
    if (!this._factEntities.has(factId)) {
      this._factEntities.set(factId, new Set());
    }
    this._factEntities.get(factId).add(entityId);

    const entity = this._entities.get(entityId);
    if (entity) {
      entity.factCount++;
    }
    return true;
  }

  unlinkFactFromEntity(factId, entityId) {
    if (!entityId) return false;
    if (this._factEntities.has(factId)) {
      this._factEntities.get(factId).delete(entityId);
    }

    const entity = this._entities.get(entityId);
    if (entity) {
      entity.factCount = Math.max(0, entity.factCount - 1);
    }
    return true;
  }

  getFactsForEntity(entityId) {
    const factIds = [];
    for (const [factId, entities] of this._factEntities) {
      if (entities.has(entityId)) {
        factIds.push(factId);
      }
    }
    return factIds;
  }

  getEntitiesForFact(factId) {
    const entityIds = this._factEntities.get(factId);
    return entityIds ? Array.from(entityIds) : [];
  }

  findRelatedEntities(entityId, maxDepth = 2) {
    const related = new Map();
    const visited = new Set();
    const queue = [{ id: entityId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift();

      if (visited.has(id) || depth > maxDepth) {
        continue;
      }
      visited.add(id);

      const factIds = this.getFactsForEntity(id);
      
      for (const factId of factIds) {
        const connectedEntities = this.getEntitiesForFact(factId);
        
        for (const connectedId of connectedEntities) {
          if (connectedId !== entityId && !visited.has(connectedId)) {
            related.set(connectedId, (related.get(connectedId) || 0) + 1);
            queue.push({ id: connectedId, depth: depth + 1 });
          }
        }
      }
    }

    return Array.from(related.entries())
      .map(([id, strength]) => ({
        entity: this._entities.get(id),
        strength,
      }))
      .filter(item => item.entity)
      .sort((a, b) => b.strength - a.strength);
  }

  getStats() {
    return {
      totalEntities: this._entities.size,
      totalAliases: this._aliases.size,
      totalLinks: this._factEntities.size,
      entitiesByType: this._getEntitiesByType(),
    };
  }

  _getEntitiesByType() {
    const counts = {};
    for (const entity of this._entities.values()) {
      counts[entity.type] = (counts[entity.type] || 0) + 1;
    }
    return counts;
  }

  export() {
    return {
      entities: Array.from(this._entities.values()),
      aliases: Array.from(this._aliases.entries()),
      factEntities: Array.from(this._factEntities.entries()).map(([factId, entities]) => ({
        factId,
        entities: Array.from(entities),
      })),
    };
  }

  import(data) {
    if (data.entities) {
      for (const entity of data.entities) {
        this._entities.set(this._normalizeEntityName(entity.name), entity);
      }
    }

    if (data.aliases) {
      for (const [alias, entityId] of data.aliases) {
        this._aliases.set(alias, entityId);
      }
    }

    if (data.factEntities) {
      for (const { factId, entities } of data.factEntities) {
        this._factEntities.set(factId, new Set(entities));
      }
    }
  }
}

class EntityAwareMemoryStore extends EventEmitter {
  constructor(config = {}) {
    super();
    this.extractor = new EntityExtractor(config.extractor);
    this.resolver = new EntityResolver(config.resolver);
    this.config = config;
  }

  processFact(fact) {
    const entities = this.extractor.extractWithConfidence(fact.content);

    const resolvedEntities = entities.map(entity => {
      const resolved = this.resolver.resolve(entity.name);
      
      if (resolved) {
        return resolved;
      }
      
      return this.resolver.registerEntity(entity);
    });

    for (const entity of resolvedEntities) {
      this.resolver.linkFactToEntity(fact.id, entity.id);
    }

    return {
      ...fact,
      entities: resolvedEntities,
      entityIds: resolvedEntities.map(e => e.id),
    };
  }

  // eslint-disable-next-line no-unused-vars
  queryByEntity(entityName, options = {}) {
    const entity = this.resolver.resolve(entityName);
    if (!entity) {
      return [];
    }

    const factIds = this.resolver.getFactsForEntity(entity.id);
    return factIds;
  }

  queryRelatedEntities(entityName, options = {}) {
    const entity = this.resolver.resolve(entityName);
    if (!entity) {
      return [];
    }

    return this.resolver.findRelatedEntities(entity.id, options.maxDepth);
  }

  queryMultipleEntities(entityNames, options = {}) {
    const factCounts = new Map();

    for (const name of entityNames) {
      const entity = this.resolver.resolve(name);
      if (!entity) continue;

      const factIds = this.resolver.getFactsForEntity(entity.id);
      for (const factId of factIds) {
        factCounts.set(factId, (factCounts.get(factId) || 0) + 1);
      }
    }

    return Array.from(factCounts.entries())
      .filter(([_, count]) => count >= (options.minEntityMatch || 2))
      .sort((a, b) => b[1] - a[1])
      .map(([factId, count]) => ({ factId, entityMatchCount: count }));
  }

  getStats() {
    return {
      extractor: {
        patternsCount: Object.values(ENTITY_PATTERNS).flat().length,
      },
      resolver: this.resolver.getStats(),
    };
  }
}

module.exports = {
  EntityExtractor,
  EntityResolver,
  EntityAwareMemoryStore,
  ENTITY_PATTERNS,
};
