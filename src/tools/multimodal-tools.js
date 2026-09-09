/**
 * @deprecated This module is deprecated. Use image-tools.js (ImageGenerate) and
 *             the TTS engine directly (src/core/tts/) instead. The tools remain
 *             registered for backward compatibility but may be removed in a future release.
 */

const TTS_TOOL_SCHEMA = {
  description: '将文本转换为语音音频文件。',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要转换为语音的文本内容'
      },
      voice: {
        type: 'string',
        description: '语音类型 (如 alloy, echo, fable, onyx, nova, shimmer)',
        default: 'alloy'
      },
      speed: {
        type: 'number',
        description: '语速 (0.25 - 4.0)',
        default: 1.0
      },
      output_path: {
        type: 'string',
        description: '输出音频文件路径，不填则自动生成'
      },
      language: {
        type: 'string',
        description: '语言代码 (如 zh, en)'
      }
    },
    required: ['text']
  }
};

const IMAGE_GEN_TOOL_SCHEMA = {
  description: '根据文本描述生成图像。',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '图像描述/提示词'
      },
      size: {
        type: 'string',
        enum: ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'],
        description: '图像尺寸',
        default: '1024x1024'
      },
      quality: {
        type: 'string',
        enum: ['standard', 'hd'],
        description: '图像质量',
        default: 'standard'
      },
      style: {
        type: 'string',
        enum: ['vivid', 'natural'],
        description: '图像风格',
        default: 'vivid'
      },
      n: {
        type: 'number',
        description: '生成图像数量 (1-4)',
        default: 1
      },
      output_dir: {
        type: 'string',
        description: '输出目录，不填则使用默认目录'
      }
    },
    required: ['prompt']
  }
};

async function handleTTS(params) {
  const { getTextToSpeechEngine } = require('../core/tts');
  const engine = getTextToSpeechEngine();

  const options = {};
  if (params.voice) options.voice = params.voice;
  if (params.speed) options.speed = params.speed;
  if (params.output_path) {
    // 2026-08-28 M1: 生成器 outputPath 过权限门（PLAN 只读/系统保护路径拦截）
    const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');
    if (!canWriteGeneratorOutput(params.output_path)) {
      throw new Error(`安全限制：不允许写入该输出路径（PLAN 只读模式或系统保护路径）: ${params.output_path}`);
    }
    options.outputPath = params.output_path;
  }
  if (params.language) options.language = params.language;

  const result = await engine.synthesize(params.text, options);

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      content: `❌ 语音合成失败: ${result.error}`
    };
  }

  return {
    success: true,
    filePath: result.filePath,
    duration: result.duration,
    provider: result.provider,
    content: `🔊 语音已生成: ${result.filePath} (${result.duration?.toFixed(1) || '?'}秒, 提供商: ${result.provider})`
  };
}

async function handleImageGen(params) {
  const { getImageGenerator } = require('../core/image-gen');
  const generator = getImageGenerator();

  const options = {};
  if (params.size) options.size = params.size;
  if (params.quality) options.quality = params.quality;
  if (params.style) options.style = params.style;
  if (params.n) options.n = Math.min(params.n || 1, 4);
  if (params.output_dir) options.outputDir = params.output_dir;

  const result = await generator.generate(params.prompt, options);

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      content: `❌ 图像生成失败: ${result.error}`
    };
  }

  const images = result.images || [];
  const fileList = images.map((img, i) => `  ${i + 1}. ${img.filePath} (${img.size || 'unknown'})`).join('\n');

  return {
    success: true,
    images,
    provider: result.provider,
    content: `🎨 已生成 ${images.length} 张图像 (提供商: ${result.provider}):\n${fileList}`
  };
}

function registerMultimodalTools(registry) {
  // 2026-08-01: TextToSpeech 重复注册移除——voice-tool.js 已注册完整版
  // （含 description/whenNotToUse/riskLevel），此版本（缺契约字段）静默覆盖后者。
  // 注册图片生成工具（多模态工具集版本，镜像 image-tools.js 中的 ImageGenerate）
  registry.register({
    name: 'GenerateImage',
    toolset: 'multimodal',
    category: 'multimodal',
    description: 'Generate images from text descriptions using AI image generation models (Doubao Seedream / Qwen Wanx)',
    schema: IMAGE_GEN_TOOL_SCHEMA,
    handler: handleImageGen,
    checkFn: (params) => !!params.prompt,
    timeout: 180000,
    isReadOnly: false
  });
}

module.exports = {
  registerMultimodalTools,
  handleTTS,
  handleImageGen,
  TTS_TOOL_SCHEMA,
  IMAGE_GEN_TOOL_SCHEMA
};
