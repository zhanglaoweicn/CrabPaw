// 模型提供商统一常量 — 基于 ProviderRegistry 能力矩阵
// 所有 Provider 选项从此处推导，不再需要分散的 MODEL_OPTIONS / IMAGE_OPTIONS 等

export interface ProviderEndpoint {
  id: string
  parent?: string
  label?: string
  name: string
  baseUrl: string
  defaultModel: string
  currency: string
  noApiKey?: boolean
  isCodingPlan?: boolean
  relay?: boolean
  capabilities: {
    chat: boolean
    image: boolean
    video: boolean
    vision: boolean
    audio: boolean
  }
  models: ModelDef[]
}

export interface ModelDef {
  id: string
  name: string
  maxTokens: number
  contextWindow: number
  image?: boolean
  video?: boolean
  vision?: boolean
}

export interface ProviderFamily {
  id: string
  name: string
  currency: string
  endpoints: ProviderEndpoint[]
}

// ===== 所有端点定义 =====
export const PROVIDER_ENDPOINTS: ProviderEndpoint[] = [
  {
    id: 'deepseek',
    parent: undefined,
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-flash-vision-exp',
    currency: '¥',
    capabilities: { chat: true, image: false, video: false, vision: true, audio: false },
    models: [
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision（默认）', maxTokens: 8192, contextWindow: 65536, vision: true },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxTokens: 16384, contextWindow: 128000 },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 8192, contextWindow: 65536 },
      { id: 'deepseek-chat', name: 'DeepSeek V3（上游已停用）', maxTokens: 8192, contextWindow: 65536 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', maxTokens: 8192, contextWindow: 65536 },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', maxTokens: 16384, contextWindow: 65536 },
    ],
  },
  {
    id: 'minimax',
    parent: undefined,
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5s-chat',
    currency: '¥',
    capabilities: { chat: true, image: false, video: false, vision: true, audio: true },
    models: [
      { id: 'abab6.5s-chat', name: 'abab6.5s-chat', maxTokens: 8192, contextWindow: 245760 },
      { id: 'abab7-chat-preview', name: 'abab7-chat', maxTokens: 8192, contextWindow: 245760 },
      { id: 'speech-01', name: 'speech-01 (TTS)', maxTokens: 4096, contextWindow: 4096 },
      { id: 'speech-02', name: 'speech-02 (TTS-HD)', maxTokens: 4096, contextWindow: 4096 },
    ],
  },
  {
    id: 'zhipu',
    parent: undefined,
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3-flash',
    currency: '¥',
    capabilities: { chat: true, image: true, video: false, vision: true, audio: false },
    models: [
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash（默认）', maxTokens: 8192, contextWindow: 128000 },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', maxTokens: 4096, contextWindow: 128000 },
      { id: 'glm-4-0520', name: 'GLM-4 0520', maxTokens: 4096, contextWindow: 128000 },
      { id: 'glm-4-air', name: 'GLM-4 Air', maxTokens: 4096, contextWindow: 128000 },
      { id: 'glm-4-airx', name: 'GLM-4 AirX', maxTokens: 4096, contextWindow: 8192 },
      { id: 'glm-4-flash', name: 'GLM-4 Flash', maxTokens: 4096, contextWindow: 128000 },
      { id: 'glm-4-long', name: 'GLM-4 Long', maxTokens: 4096, contextWindow: 1048576 },
      { id: 'glm-4v', name: 'GLM-4V', maxTokens: 1024, contextWindow: 2048, vision: true },
      { id: 'glm-4v-plus', name: 'GLM-4V Plus', maxTokens: 4096, contextWindow: 8192, vision: true },
      { id: 'cogview-4', name: 'CogView-4', maxTokens: 4096, contextWindow: 4096, image: true },
    ],
  },
  {
    id: 'aliyun_standard',
    parent: 'aliyun',
    label: '标准 API',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    currency: '¥',
    capabilities: { chat: true, image: true, video: false, vision: true, audio: false },
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', maxTokens: 8192, contextWindow: 131072 },
      { id: 'qwen-turbo', name: 'Qwen Turbo', maxTokens: 8192, contextWindow: 131072 },
      { id: 'qwen-max', name: 'Qwen Max', maxTokens: 8192, contextWindow: 32768 },
      { id: 'qwen-long', name: 'Qwen Long', maxTokens: 6000, contextWindow: 10000000 },
      { id: 'qwen-vl-plus', name: 'Qwen VL Plus', maxTokens: 8192, contextWindow: 32768, vision: true },
      { id: 'qwen-vl-max', name: 'Qwen VL Max', maxTokens: 8192, contextWindow: 32768, vision: true },
      { id: 'qwen2.5-72b-instruct', name: 'Qwen 2.5 72B', maxTokens: 8192, contextWindow: 131072 },
      { id: 'qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', maxTokens: 8192, contextWindow: 131072 },
      { id: 'wanx-v1', name: '通义万相 v1', maxTokens: 4096, contextWindow: 4096, image: true },
      // 2026-08-07: ASR 语音识别模型——asr 分类 defaultModel 指向此 id，此前不在列表中造成不一致
      { id: 'paraformer-realtime-v2', name: 'Paraformer Realtime V2 (ASR)', maxTokens: 4096, contextWindow: 4096 },
    ],
  },
  {
    id: 'aliyun_coding',
    parent: 'aliyun',
    label: 'Coding Plan',
    name: '阿里云百炼',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
    defaultModel: 'qwen3-coder-plus',
    currency: '¥',
    isCodingPlan: true,
    capabilities: { chat: true, image: false, video: false, vision: false, audio: false },
    models: [
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', maxTokens: 8192, contextWindow: 131072 },
    ],
  },
  {
    id: 'volcengine_standard',
    parent: 'volcengine',
    label: '标准 API',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-code-preview-260215',
    currency: '¥',
    capabilities: { chat: true, image: true, video: true, vision: true, audio: false },
    models: [
      { id: 'doubao-seed-2-0-code-preview-260215', name: 'Seed 2.0 Code Preview', maxTokens: 8192, contextWindow: 65536 },
      { id: 'doubao-1.5-pro-32k', name: 'Doubao 1.5 Pro 32K', maxTokens: 4096, contextWindow: 32768 },
      { id: 'doubao-1.5-pro-128k', name: 'Doubao 1.5 Pro 128K', maxTokens: 4096, contextWindow: 131072 },
      { id: 'doubao-1.5-lite-32k', name: 'Doubao 1.5 Lite 32K', maxTokens: 4096, contextWindow: 32768 },
      { id: 'doubao-seed-vision-1-6', name: 'Seed Vision 1.6', maxTokens: 8192, contextWindow: 65536, vision: true },
      { id: 'doubao-seedream-4-5', name: 'Seedream 4.5', maxTokens: 4096, contextWindow: 4096, image: true },
      { id: 'doubao-seedance-1-5-pro', name: 'Seedance 1.5 Pro', maxTokens: 4096, contextWindow: 4096, video: true },
    ],
  },
  {
    id: 'volcengine_coding',
    parent: 'volcengine',
    label: 'Coding Plan',
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    defaultModel: 'ark-code-latest',
    currency: '¥',
    isCodingPlan: true,
    capabilities: { chat: true, image: false, video: false, vision: false, audio: false },
    models: [
      { id: 'ark-code-latest', name: 'Ark Code Latest', maxTokens: 16384, contextWindow: 128000 },
    ],
  },
  {
    id: 'ollama',
    parent: undefined,
    name: '本地模型 (Ollama)',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    currency: '·',
    noApiKey: true,
    capabilities: { chat: true, image: false, video: false, vision: false, audio: false },
    models: [
      { id: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B', maxTokens: 32768, contextWindow: 32768 },
      { id: 'qwen2.5-coder:14b', name: 'Qwen2.5 Coder 14B', maxTokens: 32768, contextWindow: 32768 },
      { id: 'qwen2.5-coder:32b', name: 'Qwen2.5 Coder 32B', maxTokens: 32768, contextWindow: 32768 },
      { id: 'qwen3:8b', name: 'Qwen3 8B', maxTokens: 32768, contextWindow: 32768 },
      { id: 'llama3.1:8b', name: 'Llama 3.1 8B', maxTokens: 8192, contextWindow: 32768 },
      { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', maxTokens: 16384, contextWindow: 32768 },
    ],
  },
  {
    id: 'custom',
    parent: undefined,
    name: '中继服务',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'custom-model',
    currency: '·',
    noApiKey: true,
    capabilities: { chat: true, image: true, video: true, vision: true, audio: true },
    models: [
      { id: 'custom-model', name: '自定义模型', maxTokens: 8192, contextWindow: 32768 },
    ],
    relay: true,
  },
]

// ===== 家族分组 =====
export const PROVIDER_FAMILIES: ProviderFamily[] = (() => {
  const familyMap = new Map<string, ProviderEndpoint[]>()
  const standalone: ProviderEndpoint[] = []

  for (const ep of PROVIDER_ENDPOINTS) {
    if (ep.parent) {
      const list = familyMap.get(ep.parent) || []
      list.push(ep)
      familyMap.set(ep.parent, list)
    } else {
      standalone.push(ep)
    }
  }

  const families: ProviderFamily[] = []
  for (const [id, endpoints] of familyMap) {
    families.push({ id, name: endpoints[0]?.name || id, currency: endpoints[0]?.currency || '¥', endpoints })
  }

  return families
})()

// ===== 便捷查询 =====
export function getEndpoint(id: string): ProviderEndpoint | undefined {
  return PROVIDER_ENDPOINTS.find(e => e.id === id)
}

export function getEndpointsByCapability(capability: keyof ProviderEndpoint['capabilities']): ProviderEndpoint[] {
  return PROVIDER_ENDPOINTS.filter(e => e.capabilities[capability])
}

export function getChatModels(endpointId: string): ModelDef[] {
  const ep = getEndpoint(endpointId)
  if (!ep) return []
  return ep.models.filter(m => !m.image && !m.video && !m.vision)
}

export function getEndpointName(id: string): string {
  const ep = getEndpoint(id)
  if (!ep) return id
  if (ep.parent && ep.label) return `${ep.name} · ${ep.label}`
  return ep.name
}

// ===== 向后兼容导出 =====
export const MODEL_OPTIONS = PROVIDER_ENDPOINTS.filter(e => e.capabilities.chat).map(e => ({
  id: e.id,
  name: e.parent && e.label ? `${e.name} · ${e.label}` : e.name,
  model: e.defaultModel,
  baseUrl: e.baseUrl,
  currency: e.currency,
  noApiKey: e.noApiKey,
  isCodingPlan: e.isCodingPlan,
}))

export const IMAGE_MODEL_OPTIONS = getEndpointsByCapability('image').map(e => ({
  id: e.id,
  name: e.parent && e.label ? `${e.name} · ${e.label}` : e.name,
  model: e.models.find(m => m.image)?.id || e.defaultModel,
  baseUrl: e.baseUrl,
  currency: e.currency,
}))

export const VIDEO_MODEL_OPTIONS = getEndpointsByCapability('video').map(e => ({
  id: e.id,
  name: e.parent && e.label ? `${e.name} · ${e.label}` : e.name,
  model: e.models.find(m => m.video)?.id || e.defaultModel,
  baseUrl: e.baseUrl,
  currency: e.currency,
}))

export const VISION_MODEL_OPTIONS = getEndpointsByCapability('vision').map(e => ({
  id: e.id,
  name: e.parent && e.label ? `${e.name} · ${e.label}` : e.name,
  model: e.models.find(m => m.vision)?.id || e.defaultModel,
  baseUrl: e.baseUrl,
  currency: e.currency,
}))

export const DEFAULT_PROVIDERS: Record<string, { baseUrl: string; model: string; apiKey: string }> = Object.fromEntries(
  PROVIDER_ENDPOINTS.map(e => [e.id, { baseUrl: e.baseUrl, model: e.defaultModel, apiKey: '' }])
)

export const DEFAULT_IMAGE_PROVIDERS: Record<string, { baseUrl: string; model: string; apiKey: string }> = Object.fromEntries(
  getEndpointsByCapability('image').map(e => [e.id, { baseUrl: e.baseUrl, model: e.models.find(m => m.image)?.id || e.defaultModel, apiKey: '' }])
)

export const DEFAULT_VIDEO_PROVIDERS: Record<string, { baseUrl: string; model: string; apiKey: string }> = Object.fromEntries(
  getEndpointsByCapability('video').map(e => [e.id, { baseUrl: e.baseUrl, model: e.models.find(m => m.video)?.id || e.defaultModel, apiKey: '' }])
)

export const DEFAULT_VISION_PROVIDERS: Record<string, { baseUrl: string; model: string; apiKey: string }> = Object.fromEntries(
  getEndpointsByCapability('vision').map(e => [e.id, { baseUrl: e.baseUrl, model: e.models.find(m => m.vision)?.id || e.defaultModel, apiKey: '' }])
)

export function getModelName(id: string | undefined | null): string {
  if (!id) return ''
  const found = PROVIDER_ENDPOINTS.find(e => e.id === id)
  if (found) return found.parent && found.label ? `${found.name} · ${found.label}` : found.name
  return id
}

// ===== 路由分类系统 =====
export interface RoutingCategory {
  id: string
  label: string
  icon: string
  description: string
  defaultProvider: string
  defaultModel: string
  /** 该分类需要的 provider capability */
  requiredCapability?: keyof ProviderEndpoint['capabilities']
  /** 模型级参数（TTS 音色、ASR 语言等） */
  params?: Record<string, { label: string; type: 'text' | 'select' | 'number'; options?: { value: string; label: string }[]; default: string }>
}

export const ROUTING_CATEGORIES: RoutingCategory[] = [
  {
    id: 'chat',
    label: '对话',
    icon: '💬',
    description: '日常对话、通用问答',
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-v4-flash-vision-exp',
    requiredCapability: 'chat',
  },
  {
    id: 'reasoning',
    label: '推理',
    icon: '🧠',
    description: '深度推理、代码分析、逻辑任务',
    defaultProvider: 'deepseek',
    defaultModel: 'deepseek-reasoner',
    requiredCapability: 'chat',
  },
  {
    id: 'vision',
    label: '视觉理解',
    icon: '👁️',
    description: '图片识别、OCR、视觉问答',
    // 2026-08-07: 'doubao' 非真实端点 id → volcengine_standard(Doubao 视觉模型所在端点)
    defaultProvider: 'volcengine_standard',
    defaultModel: 'doubao-seed-vision-1-6',
    requiredCapability: 'vision',
  },
  {
    id: 'imageGen',
    label: '图片生成',
    icon: '🎨',
    description: '文生图、图生图',
    // 2026-08-07: 'doubao' 非真实端点 id → volcengine_standard
    defaultProvider: 'volcengine_standard',
    defaultModel: 'doubao-seedream-4-5',
    requiredCapability: 'image',
  },
  {
    id: 'videoGen',
    label: '视频生成',
    icon: '🎬',
    description: '文生视频',
    // 2026-08-07: 'doubao' 非真实端点 id → volcengine_standard
    defaultProvider: 'volcengine_standard',
    defaultModel: 'doubao-seedance-1-5-pro',
    requiredCapability: 'video',
  },
  {
    id: 'tts',
    label: '语音合成',
    icon: '🔊',
    description: '文字转语音（语音设置页面控制实际TTS引擎，此处为任务路由）',
    // 2026-08-07: 'volcano-tts' 非真实模型 id → minimax 的 speech-01(PROVIDER_ENDPOINTS 内唯一真实 TTS 模型)
    defaultProvider: 'minimax',
    defaultModel: 'speech-01',
    params: {
      voice: {
        label: '音色',
        type: 'select',
        options: [
          { value: 'BV001_streaming', label: '火山 BV001 (女声)' },
          { value: 'BV002_streaming', label: '火山 BV002 (男声)' },
        ],
        default: 'BV001_streaming',
      },
      speed: {
        label: '语速',
        type: 'number',
        default: '1.0',
      },
    },
  },
  {
    id: 'asr',
    label: '语音识别',
    icon: '🎙️',
    description: '语音转文字',
    // 2026-08-07: 'doubao'/'doubao-asr' 均非真实 id → aliyun_standard + paraformer-realtime-v2
    // (ModelConfig 实际使用的 ASR 模型 id)
    defaultProvider: 'aliyun_standard',
    defaultModel: 'paraformer-realtime-v2',
    params: {
      language: {
        label: '识别语言',
        type: 'select',
        options: [
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'auto', label: '自动识别' },
        ],
        default: 'zh',
      },
    },
  },
  {
    id: 'embedding',
    label: '嵌入',
    icon: '📐',
    description: '文本向量化、语义搜索',
    defaultProvider: 'ollama',
    defaultModel: 'qwen2.5-coder:7b',
    requiredCapability: 'chat',
  },
]

/** 获取某分类可用的 provider 端点列表 */
export function getProvidersForCategory(categoryId: string): ProviderEndpoint[] {
  const cat = ROUTING_CATEGORIES.find(c => c.id === categoryId)
  if (!cat || !cat.requiredCapability) return PROVIDER_ENDPOINTS
  return getEndpointsByCapability(cat.requiredCapability)
}

/** 默认路由配置（自动从旧 config 兼容） */
export function getDefaultRouting(): Record<string, { provider: string; model: string; fallback?: string[]; params?: Record<string, string> }> {
  const routing: Record<string, any> = {}
  for (const cat of ROUTING_CATEGORIES) {
    const params: Record<string, string> = {}
    if (cat.params) {
      for (const [key, def] of Object.entries(cat.params)) {
        params[key] = def.default
      }
    }
    routing[cat.id] = {
      provider: cat.defaultProvider,
      model: cat.defaultModel,
      fallback: [],
      ...(Object.keys(params).length ? { params } : {}),
    }
  }
  return routing
}

// ─── TTS 服务商枚举归一(2026-09-10 U 盘验收实测)────────────────────────
// 前端合法枚举与后端本地 TTS 子系统 id(edge-tts/piper)是两个域;历史 bug:
// Settings 加载兜底曾把 "edge-tts"(后端 id)填进 voice.ttsProvider,ModelConfig
// 六个分支全不匹配 → TTS 密钥框/音色下拉整体消失。归一规则:edge-tts→edge,
// 空/未知→doubao(与后端 config.js 默认一致)。
export const VALID_TTS_PROVIDERS = ['doubao', 'volcano', 'edge', 'sapi', 'openai', 'qwen'] as const

export function normalizeTtsProvider(raw: string | undefined | null): string {
  const v = (raw || '').trim()
  if (v === 'edge-tts') return 'edge'
  return (VALID_TTS_PROVIDERS as readonly string[]).includes(v) ? v : 'doubao'
}
