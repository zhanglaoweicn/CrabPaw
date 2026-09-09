/**
 * Voice Tool - TTS 语音合成
 * 
 * 复用已有的 core/tts 引擎，注册为 AI 可调用的工具
 * 生成语音后通过 SSE 广播给前端播放
 */

const { registry } = require('./registry');
const { getTextToSpeechEngine, TTS_PROVIDERS, normalizeTTSError } = require('../core/tts');
const { broadcastEvent } = require('../core/sse-broadcast');

// TTS 工具
registry.register({
  name: 'TextToSpeech',
  toolset: 'voice',
  category: 'voice',
  description: '将文本转换为语音并播放。支持多种语音和语速调节。会自动选择可用的 TTS 提供商（优先使用配置的提供商，失败后自动降级）。',
  whenNotToUse: '当用户未明确要求播放语音时不应调用。常规对话中不要自动调用此工具，语音回复由前端自动处理。仅在用户明确要求"播放语音"、"朗读这段文字"等场景时才调用。文本超过 500 字时建议分段调用。',
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要转换为语音的文本内容',
      },
      voice: {
        type: 'string',
        description: '语音角色。SAPI本地: Microsoft Huihui Desktop(慧慧-中文女声), Microsoft Zira Desktop(英文女声)。Edge免费: zh-CN-XiaoxiaoNeural(晓晓-女), zh-CN-YunxiNeural(云希-男), en-US-JennyNeural(女)。默认: Microsoft Huihui Desktop',
        default: 'zh-CN-XiaoxiaoNeural',
      },
      speed: {
        type: 'number',
        description: '语速倍率，0.25-4.0，1.0 为正常速度。默认: 1.0',
        default: 1.0,
      },
      provider: {
        type: 'string',
        enum: ['auto', 'openai', 'qwen', 'edge', 'doubao', 'volcano', 'local', 'piper'],
        description: 'TTS 服务提供商。auto=自动选择(优先豆包)，edge=免费Edge TTS，doubao=豆包2.0(火山引擎推荐)，volcano=火山引擎基础版，openai/qwen需要API Key，local/piper=本地TTS。默认: auto',
        default: 'auto',
      },
    },
    required: ['text'],
  },
  handler: async (params) => {
    const { text, voice, speed, provider } = params;

    if (!text || text.trim().length === 0) {
      return { success: false, error: '文本内容不能为空' };
    }

    const ttsEngine = getTextToSpeechEngine();
    const options = {
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      speed: speed || 1.0,
      _refined: params._refined || false, // 前端提炼过的文本，跳过后端二次清理
    };

    // 如果指定了 provider 且不是 auto，临时调整引擎的 provider 顺序（调用后恢复）
    const originalOrder = ttsEngine._providerOrder
    let needRestore = false
    if (provider && provider !== 'auto') {
      ttsEngine._providerOrder = [provider, ...Object.keys(TTS_PROVIDERS).filter(k => k !== provider && k !== 'sapi' && k !== 'local')];
      needRestore = true
    }

    const { resolveRefinedText } = require('../core/voice-evolution');
    const refinedText = resolveRefinedText(String(text), { allowRefine: params.refine !== '0' });

    try {
      const result = await ttsEngine.synthesize(refinedText, options);

      if (result.success) {
        // 通过 SSE 广播语音事件，前端接收后播放
        broadcastEvent('voice_play', {
          filePath: result.filePath,
          text: text.substring(0, 200),
          voice: result.voice || voice,
          provider: result.provider,
          duration: result.duration,
          timestamp: Date.now(),
        });

        return {
          success: true,
          message: `语音已生成并发送播放: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`,
          filePath: result.filePath,
          provider: result.provider,
          voice: result.voice,
          duration: result.duration,
          format: result.format,
        };
      }

      return result;
    } catch (e) {
      const normalized = normalizeTTSError(e, provider || 'TTS')
      return { success: false, error: normalized.message, code: normalized.code, retryable: normalized.retryable };
    } finally {
      if (needRestore) {
        ttsEngine._providerOrder = originalOrder;
      }
    }
  },
  checkFn: () => true,
  timeout: 120000,
});

// 获取可用语音列表
registry.register({
  name: 'ListVoices',
  toolset: 'voice',
  category: 'voice',
  description: '获取可用的 TTS 语音角色列表和提供商状态',
  whenNotToUse: '当用户已明确指定语音角色时无需调用。仅在需要查询可用语音或排查 TTS 问题时使用。',
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const ttsEngine = getTextToSpeechEngine();
      const providers = ttsEngine.getProviders();
      return { success: true, providers };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  checkFn: () => true,
});

console.log('✅ 语音工具已注册 (TextToSpeech, ListVoices)');
