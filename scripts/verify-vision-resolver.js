// 验证 vision-resolver 的 config-driven 选择逻辑
// 不需要真实 API Key，只检查 provider/model 路由

const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { resolveVisionModel, isVisionCapable, buildSetupGuide, SUGGESTED_VISION_MODELS, VISION_CAPABLE_PROVIDERS } = require('../src/core/vision-resolver');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('✅', name); pass++; }
  else { console.log('❌', name); fail++; }
}

console.log('=== 1. SUGGESTED_VISION_MODELS 不再硬编码（用户可改） ===');
console.log('  推荐默认值：', SUGGESTED_VISION_MODELS);
check('SUGGESTED_VISION_MODELS 是个对象（不是被冻结的硬编码）', typeof SUGGESTED_VISION_MODELS === 'object');
check('OpenAI 默认 gpt-4o-mini', SUGGESTED_VISION_MODELS.openai === 'gpt-4o-mini');
check('Qwen 默认 qwen-vl-plus', SUGGESTED_VISION_MODELS.qwen === 'qwen-vl-plus');
check('Ollama 不给默认（避免误用文本模型）', SUGGESTED_VISION_MODELS.ollama === undefined);

console.log('\n=== 2. isVisionCapable 覆盖常见视觉模型 ===');
check("gpt-4o / openai", isVisionCapable('openai', 'gpt-4o'));
check("gpt-4o-mini / openai", isVisionCapable('openai', 'gpt-4o-mini'));
check("claude-3-5-sonnet / anthropic", isVisionCapable('anthropic', 'claude-3-5-sonnet'));
check("gemini-1.5-flash / google", isVisionCapable('google', 'gemini-1.5-flash'));
check("qwen-vl-plus / qwen", isVisionCapable('qwen', 'qwen-vl-plus'));
check("glm-4v / glm", isVisionCapable('glm', 'glm-4v'));
check("doubao-1.5-vision-pro-32k / doubao", isVisionCapable('doubao', 'doubao-1.5-vision-pro-32k'));
check("llama3.2-vision / ollama", isVisionCapable('ollama', 'llama3.2-vision'));
check("llava / ollama", isVisionCapable('ollama', 'llava'));
check("moondream / ollama", isVisionCapable('ollama', 'moondream'));
check("deepseek-chat / deepseek (false)", isVisionCapable('deepseek', 'deepseek-chat') === false);
check("deepseek-reasoner / deepseek (false)", isVisionCapable('deepseek', 'deepseek-reasoner') === false);
check("qwen-turbo / qwen (false)", isVisionCapable('qwen', 'qwen-turbo') === false);
check("minimax-abab / minimax (false)", isVisionCapable('minimax', 'abab6-chat') === false);

console.log('\n=== 3. resolveVisionModel 5 级优先级 ===');

// Case 3.1: 用户显式配置 auxiliary.vision.provider='qwen', model='my-custom-vl'
const cfg1 = {
  models: {
    currentProvider: 'deepseek',
    providers: { deepseek: { model: 'deepseek-chat', apiKey: 'sk-ds' }, qwen: { model: 'qwen-turbo', apiKey: 'sk-qw' } },
    auxiliary: { vision: { provider: 'qwen', model: 'qwen3-vl-plus-2026' } },
  },
};
const r1 = resolveVisionModel(cfg1);
check('3.1 auxiliary.vision 优先于其他', r1 && r1.source === 'auxiliary.vision');
check('3.1 model 优先用 auxiliary.vision.model', r1 && r1.model === 'qwen3-vl-plus-2026');
check('3.1 provider 来自 auxiliary.vision.provider', r1 && r1.provider === 'qwen');

// Case 3.2: visionGeneration 兜底
const cfg2 = {
  models: {
    currentProvider: 'deepseek',
    providers: { deepseek: { model: 'deepseek-chat', apiKey: 'sk-ds' } },
  },
  visionGeneration: {
    provider: 'openai',
    providers: { openai: { apiKey: 'sk-oa', model: 'gpt-4-vision-preview' } },
  },
};
const r2 = resolveVisionModel(cfg2);
check('3.2 visionGeneration 命中', r2 && r2.source === 'visionGeneration');
check('3.2 选了 openai', r2 && r2.provider === 'openai');

// Case 3.3: 当前主模型是视觉模型
const cfg3 = {
  models: {
    currentProvider: 'openai',
    providers: { openai: { model: 'gpt-4o', apiKey: 'sk-oa' } },
  },
};
const r3 = resolveVisionModel(cfg3);
check('3.3 当前主模型是 gpt-4o 时命中 current-provider', r3 && r3.source === 'current-provider');
check('3.3 provider 是 openai', r3 && r3.provider === 'openai');
check('3.3 model 是 gpt-4o', r3 && r3.model === 'gpt-4o');

// Case 3.4: 主 provider 不行，找其它已配视觉供应商
const cfg4 = {
  models: {
    currentProvider: 'deepseek',
    providers: {
      deepseek: { model: 'deepseek-chat', apiKey: 'sk-ds' },
      qwen: { model: 'qwen-turbo', apiKey: 'sk-qw' },
      glm: { model: 'glm-4-flash', apiKey: 'sk-glm' },
    },
  },
};
const r4 = resolveVisionModel(cfg4);
check('3.4 命中 provider-default', r4 && r4.source === 'provider-default');
check('3.4 选了 qwen（在 VISION_CAPABLE_PROVIDERS 中靠前）', r4 && r4.provider === 'qwen');
check('3.4 推荐的 model 是 qwen-vl-plus', r4 && r4.model === 'qwen-vl-plus');
check('3.4 给了 warning', r4 && typeof r4.warning === 'string');

// Case 3.5: 啥都没有
const cfg5 = {
  models: {
    currentProvider: 'deepseek',
    providers: { deepseek: { model: 'deepseek-chat', apiKey: 'sk-ds' } },
  },
};
const r5 = resolveVisionModel(cfg5);
check('3.5 没配视觉供应商时返回 null', r5 === null);

// Case 3.6: 用户自定义了不在白名单的 provider（如 'custom'）和模型名
const cfg6 = {
  models: {
    currentProvider: 'custom',
    providers: {
      custom: { model: 'my-finetuned-vision', apiKey: 'sk-x', baseUrl: 'https://my.api/v1' },
    },
  },
};
const r6 = resolveVisionModel(cfg6);
check('3.6 current-provider 命中（user custom model 含 vision 关键词）', r6 && r6.source === 'current-provider');
check('3.6 保留用户的自定义 model 名', r6 && r6.model === 'my-finetuned-vision');
check('3.6 保留用户的自定义 baseUrl', r6 && r6.baseUrl === 'https://my.api/v1');

console.log('\n=== 4. buildSetupGuide 输出包含 4 种方案 ===');
const guide = buildSetupGuide({});
check('包含 auxiliary.vision 配置示例', /auxiliary\.vision/.test(guide));
check('包含"切换主模型"建议', /主模型|支持多模态/.test(guide));
check('包含 Ollama 离线方案', /Ollama|ollama/.test(guide));
check('包含纯本地元信息 fallback', /EXIF|元信息|ImageInfo/.test(guide));

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
