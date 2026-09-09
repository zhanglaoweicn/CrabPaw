const { getProviderRegistry } = require('./provider-registry');

const CATEGORIES = [
  'chat', 'reasoning', 'vision', 'imageGen', 'videoGen',
  'tts', 'asr', 'embedding', 'codingPlan',
];

const DOMESTIC_PROVIDERS = ['deepseek', 'qwen', 'glm', 'doubao', 'minimax', 'ollama', 'custom'];

class CategoryRouter {
  constructor(config = {}) {
    this._config = config;
    this._routing = this._buildRouting(config);
  }

  _buildRouting(config) {
    const models = config.models || {};
    if (models.routing && Object.keys(models.routing).length > 0) {
      return this._normalizeRouting(models.routing);
    }
    return this._autoRouting(config);
  }

  _normalizeRouting(routing) {
    const result = {};
    for (const cat of CATEGORIES) {
      const entry = routing[cat];
      if (entry && entry.provider) {
        result[cat] = {
          provider: entry.provider,
          model: entry.model || '',
          fallback: entry.fallback || [],
        };
      }
    }
    return result;
  }

  _autoRouting(config) {
    const models = config.models || {};
    const mainProvider = models.currentProvider || 'deepseek';
    const mainModel = models.defaultModel || 'deepseek-chat';
    const routing = {};

    routing.chat = { provider: mainProvider, model: mainModel, fallback: [] };

    if (models.auxiliary?.vision?.provider && models.auxiliary.vision.provider !== 'auto') {
      routing.vision = {
        provider: models.auxiliary.vision.provider,
        model: models.auxiliary.vision.model || '',
        fallback: [],
      };
    }

    const imgGen = config.imageGeneration;
    if (imgGen?.provider) {
      routing.imageGen = { provider: imgGen.provider, model: imgGen.model || '', fallback: [] };
    }

    const vidGen = config.videoGeneration;
    if (vidGen?.provider) {
      routing.videoGen = { provider: vidGen.provider, model: vidGen.model || '', fallback: [] };
    }

    return routing;
  }

  resolve(category, options = {}) {
    const assignment = this._routing[category];
    if (!assignment) {
      const defaultModel = this._config.models?.defaultModel || 'deepseek-chat';
      const defaultProvider = this._config.models?.currentProvider || 'deepseek';
      return { provider: defaultProvider, model: defaultModel };
    }

    const modelHint = options.modelHint;
    const providerOverride = options.provider;

    return {
      provider: providerOverride || assignment.provider,
      model: modelHint || assignment.model,
      fallback: assignment.fallback || [],
    };
  }

  async execute(category, params = {}, options = {}) {
    const resolved = this.resolve(category, options);
    const registry = getProviderRegistry();
    const adapter = registry.getAdapter(resolved.provider);
    if (!adapter) {
      if (resolved.fallback && resolved.fallback.length > 0) {
        for (const fbProvider of resolved.fallback) {
          const fbAdapter = registry.getAdapter(fbProvider);
          if (fbAdapter) {
            return fbAdapter.chat({
              ...params,
              model: params.model || resolved.model,
            });
          }
        }
      }
      throw new Error(`CategoryRouter: 分类 "${category}" 无可用适配器 (provider: ${resolved.provider})`);
    }

    return adapter.chat({
      ...params,
      model: params.model || resolved.model,
    });
  }

  getRoutingTable() {
    return { ...this._routing };
  }

  getCategories() {
    return [...CATEGORIES];
  }

  static get CATEGORIES() { return CATEGORIES; }
  static get DOMESTIC_PROVIDERS() { return DOMESTIC_PROVIDERS; }
}

let _defaultRouter = null;

function getCategoryRouter(config) {
  if (!_defaultRouter) {
    _defaultRouter = new CategoryRouter(config || {});
  }
  return _defaultRouter;
}

function resetCategoryRouter() {
  _defaultRouter = null;
}

module.exports = {
  CategoryRouter,
  getCategoryRouter,
  resetCategoryRouter,
  CATEGORIES,
  DOMESTIC_PROVIDERS,
};
