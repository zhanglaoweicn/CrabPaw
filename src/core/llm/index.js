/**
 * LLM 模块入口
 * 
 * 核心导出：
 * - ProviderRegistry: 统一 Provider 注册中心（新）
 * - AdapterRegistry: 旧版兼容层
 * - 各适配器和模型定义
 */

const { ProviderRegistry, getProviderRegistry, resetProviderRegistry, PROVIDER_CAPABILITIES, PROVIDER_FAMILIES, PROVIDER_DEFAULT_MODELS, PROVIDER_MODEL_DEFS, CODING_PLAN_ENDPOINTS } = require('./provider-registry');
const { AdapterRegistry, PROVIDER_REGISTRY } = require('./adapter-registry');

// 2026-08-17: 修复——此前 getAdapterRegistry() 返回静态定义表 PROVIDER_REGISTRY
// （无 chat/register/listProviders 方法），stock-interpret 等直接消费方调用
// reg.chat 必 TypeError 恒走兜底；此处改为返回 AdapterRegistry 单例实例。
const adapterRegistryInstance = new AdapterRegistry();

/**
 * 获取适配器注册中心 (用于 CLI 插件系统对接)
 */
function getAdapterRegistry() {
  return adapterRegistryInstance;
}

const { ProviderAdapter } = require('./adapters/base');
const { DeepSeekAdapter, DEEPSEEK_MODELS } = require('./adapters/deepseek');
const { QwenAdapter, QWEN_MODELS } = require('./adapters/qwen');
const { GLMAdapter, GLM_MODELS } = require('./adapters/glm');
const { DoubaoAdapter, DOUBAO_MODELS } = require('./adapters/doubao');
const { MinimaxAdapter, MINIMAX_MODELS } = require('./adapters/minimax');
const { CodingPlanAdapter } = require('./adapters/coding-plan');
const { OllamaAdapter, OLLAMA_MODELS } = require('./adapters/ollama');
const { CustomAdapter, CUSTOM_DEFAULT_MODELS } = require('./adapters/custom');

module.exports = {
  // 新核心
  ProviderRegistry,
  getProviderRegistry,
  resetProviderRegistry,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAMILIES,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODEL_DEFS,
  CODING_PLAN_ENDPOINTS,

  // 旧兼容
  AdapterRegistry,
  PROVIDER_REGISTRY,

  // 适配器
  ProviderAdapter,
  DeepSeekAdapter, DEEPSEEK_MODELS,
  QwenAdapter, QWEN_MODELS,
  GLMAdapter, GLM_MODELS,
  DoubaoAdapter, DOUBAO_MODELS,
  MinimaxAdapter, MINIMAX_MODELS,
  CodingPlanAdapter,
  OllamaAdapter, OLLAMA_MODELS,
  CustomAdapter, CUSTOM_DEFAULT_MODELS,
  getAdapterRegistry,
};
