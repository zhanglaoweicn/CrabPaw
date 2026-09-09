const { CategoryRouter, getCategoryRouter, resetCategoryRouter, CATEGORIES, DOMESTIC_PROVIDERS } = require('../core/llm/category-router')

describe('CategoryRouter', () => {
  beforeEach(() => {
    resetCategoryRouter()
  })

  // ── 构造函数 ──
  describe('constructor', () => {
    test('should init with empty config giving default chat routing', () => {
      const router = new CategoryRouter({})
      const table = router.getRoutingTable()
      expect(table.chat).toBeDefined()
      expect(table.chat.provider).toBe('deepseek')
    })

    test('should build routing from explicit models.routing block', () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'deepseek', model: 'deepseek-chat' },
            vision: { provider: 'doubao', model: 'doubao-seed-vision' },
          },
        },
      })
      const table = router.getRoutingTable()
      expect(table.chat).toEqual({ provider: 'deepseek', model: 'deepseek-chat', fallback: [] })
      expect(table.vision).toEqual({ provider: 'doubao', model: 'doubao-seed-vision', fallback: [] })
    })

    test('should auto-routing from legacy config when no routing block', () => {
      const router = new CategoryRouter({
        models: { currentProvider: 'deepseek', defaultModel: 'deepseek-chat' },
        imageGeneration: { provider: 'doubao', model: 'doubao-seedream' },
      })
      const table = router.getRoutingTable()
      expect(table.chat).toEqual({ provider: 'deepseek', model: 'deepseek-chat', fallback: [] })
      expect(table.imageGen).toEqual({ provider: 'doubao', model: 'doubao-seedream', fallback: [] })
    })

    test('should auto-routing with auxiliary vision config', () => {
      const router = new CategoryRouter({
        models: {
          currentProvider: 'deepseek',
          defaultModel: 'deepseek-chat',
          auxiliary: { vision: { provider: 'doubao', model: 'doubao-vision' } },
        },
      })
      const table = router.getRoutingTable()
      expect(table.vision).toEqual({ provider: 'doubao', model: 'doubao-vision', fallback: [] })
    })

    test('should skip auto vision when auxiliary provider is auto', () => {
      const router = new CategoryRouter({
        models: {
          currentProvider: 'deepseek',
          defaultModel: 'deepseek-chat',
          auxiliary: { vision: { provider: 'auto' } },
        },
      })
      expect(router.getRoutingTable().vision).toBeUndefined()
    })

    test('should skip auto vision when auxiliary provider missing', () => {
      const router = new CategoryRouter({
        models: { currentProvider: 'deepseek', defaultModel: 'deepseek-chat' },
      })
      expect(router.getRoutingTable().vision).toBeUndefined()
    })

    test('should normalize routing with fallback', () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'deepseek', model: 'deepseek-chat', fallback: ['qwen', 'glm'] },
          },
        },
      })
      expect(router.getRoutingTable().chat.fallback).toEqual(['qwen', 'glm'])
    })

    test('should skip incomplete routing entries', () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'deepseek', model: 'deepseek-chat' },
            vision: { noProvider: true },
          },
        },
      })
      expect(router.getRoutingTable().chat).toBeDefined()
      expect(router.getRoutingTable().vision).toBeUndefined()
    })
  })

  // ── resolve() ──
  describe('resolve', () => {
    test('should return assignment for known category', () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      })
      const result = router.resolve('chat')
      expect(result).toEqual({ provider: 'deepseek', model: 'deepseek-chat', fallback: [] })
    })

    test('should return default model for unknown category', () => {
      const router = new CategoryRouter({
        models: { currentProvider: 'deepseek', defaultModel: 'deepseek-chat' },
      })
      const result = router.resolve('nonexistent')
      expect(result).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    })

    test('should resolve with modelHint override', () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      })
      const result = router.resolve('chat', { modelHint: 'deepseek-reasoner' })
      expect(result.model).toBe('deepseek-reasoner')
    })

    test('should resolve with provider override', () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      })
      const result = router.resolve('chat', { provider: 'qwen' })
      expect(result.provider).toBe('qwen')
    })

    test('should preserve modelHint when no matching category', () => {
      const router = new CategoryRouter({})
      const result = router.resolve('chat', { modelHint: 'custom-model' })
      expect(result.model).toBe('custom-model')
    })
  })

  // ── execute() ──
  describe('execute', () => {
    test('should throw when no adapter found and no fallback', async () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'nonexistent', model: 'nonexistent-model' },
          },
        },
      })
      await expect(router.execute('chat', {})).rejects.toThrow('无可用适配器')
    })

    test('should try fallback when primary adapter not found', async () => {
      const { resetProviderRegistry, getProviderRegistry } = require('../core/llm/provider-registry')
      resetProviderRegistry()
      const registry = getProviderRegistry()
      // Inject a mock adapter directly into the internal map
      const mockAdapter = { chat: jest.fn().mockResolvedValue({ content: 'fallback ok' }) }
      registry._adapters.set('qwen', mockAdapter)

      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'nonexistent', model: 'm', fallback: ['qwen'] },
          },
        },
      })
      const result = await router.execute('chat', { messages: ['hi'] })
      expect(result).toEqual({ content: 'fallback ok' })
      expect(mockAdapter.chat).toHaveBeenCalled()
    })

    test('should throw when all fallbacks fail', async () => {
      const router = new CategoryRouter({
        models: {
          routing: {
            chat: { provider: 'nonexistent', model: 'm', fallback: ['also-nonexistent'] },
          },
        },
      })
      await expect(router.execute('chat', {})).rejects.toThrow('无可用适配器')
    })
  })

  // ── getCategories() ──
  describe('getCategories', () => {
    test('should return all categories', () => {
      const router = new CategoryRouter({})
      const cats = router.getCategories()
      expect(cats).toContain('chat')
      expect(cats).toContain('reasoning')
      expect(cats).toContain('vision')
      expect(cats).toContain('imageGen')
      expect(cats).toContain('videoGen')
      expect(cats).toContain('tts')
      expect(cats).toContain('asr')
      expect(cats).toContain('embedding')
      expect(cats).toContain('codingPlan')
      expect(cats.length).toBe(9)
    })
  })

  // ── Static ──
  describe('static', () => {
    test('CATEGORIES should be frozen', () => {
      expect(CategoryRouter.CATEGORIES).toEqual(CATEGORIES)
    })

    test('DOMESTIC_PROVIDERS should be array', () => {
      expect(Array.isArray(DOMESTIC_PROVIDERS)).toBe(true)
      expect(DOMESTIC_PROVIDERS).toContain('deepseek')
    })
  })

  // ── Singleton ──
  describe('singleton', () => {
    test('getCategoryRouter should return same instance', () => {
      const a = getCategoryRouter({ models: { currentProvider: 'qwen' } })
      const b = getCategoryRouter()
      expect(a).toBe(b)
    })

    test('resetCategoryRouter should clear singleton', () => {
      const a = getCategoryRouter({ models: { currentProvider: 'qwen' } })
      resetCategoryRouter()
      const b = getCategoryRouter()
      expect(a).not.toBe(b)
    })
  })
})
