const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig, DATA_DIR } = require('../config');
const { getProviderRegistry } = require('../llm');
const { redactText } = require('../secret-redactor');

const IMAGE_GEN_PROVIDERS = {
  doubao: {
    name: '豆包 Seedream',
    url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    model: 'doubao-seedream-5-0-260128',
    minPixels: 3686400,
    maxSize: '2048x2048',
    maxN: 4
  },
  qwen: {
    name: 'Qwen ImageGen',
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
    model: 'wanx-v1',
    maxSize: '1024x1024',
    maxN: 4
  }
};

const VALID_SIZES = new Set([
  '1024x1024', '1280x1280', '1536x1536', '1920x1920', '2048x2048',
  '1440x2560', '2560x1440',
  '1080x1920', '1920x1080',
  '1024x1792', '1792x1024',
  '768x1024', '1024x768'
]);

const VALID_ASPECT_RATIOS = new Set([
  '1:1', '2:3', '3:2', '3:4', '4:3',
  '4:5', '5:4', '9:16', '16:9', '21:9'
]);

const ASPECT_RATIO_TO_SIZE = {
  '1:1': '1920x1920',
  '2:3': '1440x2160',
  '3:2': '2160x1440',
  '3:4': '1440x1920',
  '4:3': '1920x1440',
  '4:5': '1536x1920',
  '5:4': '1920x1536',
  '9:16': '1440x2560',
  '16:9': '2560x1440',
  '21:9': '2560x1097'
};

const MAX_PROMPT_LENGTH = 4000;
const MAX_IMAGE_COUNT = 4;
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;

const SSRF_BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '10.',
  '192.168.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '169.254.',
  '::1',
  'fc00:',
  'fe80:'
];

function isSSRFBlocked(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    
    for (const blocked of SSRF_BLOCKED_HOSTS) {
      if (host === blocked || host.startsWith(blocked)) {
        return true;
      }
    }
    
    return false;
  } catch {
    return true;
  }
}

const DEFAULT_OUTPUT_DIR = path.join(DATA_DIR, 'generated-images');

class ImageGenerator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config.config || loadConfig();
    this._providerOrder = this._buildProviderOrder();
    this._outputDir = config.outputDir || DEFAULT_OUTPUT_DIR;
    this._stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalImagesGenerated: 0
    };
  }

  _buildProviderOrder() {
    // 图片生成: 优先用图片模型配置
    const imageConfig = this.config.imageGeneration || {};
    const primary = imageConfig.provider || 'doubao';
    const order = [primary];
    for (const provider of ['doubao', 'volcengine_standard', 'aliyun_standard', 'zhipu', 'qwen']) {
      if (!order.includes(provider)) order.push(provider);
    }
    return order;
  }

  _getProviderConfig(providerName) {
    // 图片生成只查图片配置，不查聊天模型
    const imageConfig = this.config.imageGeneration || {};
    const imageProviders = imageConfig.providers || {};
    if (imageProviders[providerName]?.apiKey) return imageProviders[providerName];
    // 回退: 聊天模型 registry（仅当图片配置不存在时）
    const registry = getProviderRegistry();
    const cfg = registry.getProviderConfig(providerName);
    if (cfg && cfg.apiKey) return cfg;
    return null;
  }

  _hasValidKey(providerName) {
    if (providerName === 'local') return true;
    const cfg = this._getProviderConfig(providerName);
    return cfg && cfg.apiKey && cfg.apiKey.trim() !== '' && !cfg.apiKey.includes('***');
  }

  async generate(prompt, options = {}) {
    this._stats.totalRequests++;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      this._stats.failedRequests++;
      return { success: false, error: '提示词不能为空', images: [] };
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      this._stats.failedRequests++;
      return { success: false, error: `提示词过? ${prompt.length} (最?${MAX_PROMPT_LENGTH} 字符)`, images: [] };
    }

    let size = options.size;
    const aspectRatio = options.aspectRatio;

    if (aspectRatio && !VALID_ASPECT_RATIOS.has(aspectRatio)) {
      this._stats.failedRequests++;
      return { 
        success: false, 
        error: `不支持的宽高? ${aspectRatio}`,
        supported: Array.from(VALID_ASPECT_RATIOS),
        images: [] 
      };
    }

    if (aspectRatio && !size) {
      size = ASPECT_RATIO_TO_SIZE[aspectRatio] || '1024x1024';
    }

    if (!size) {
      size = '1024x1024';
    }

    if (!VALID_SIZES.has(size)) {
      this._stats.failedRequests++;
      return { success: false, error: `不支持的图像尺寸: ${size}`, images: [] };
    }

    const n = Math.min(options.n || 1, MAX_IMAGE_COUNT);
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const signal = options.signal || AbortSignal.timeout(timeoutMs);

    for (const providerName of this._providerOrder) {
      const providerInfo = IMAGE_GEN_PROVIDERS[providerName];
      if (!providerInfo) continue;

      if (!this._hasValidKey(providerName)) continue;

      try {
        const result = await this._callProvider(providerName, providerInfo, prompt, { 
          ...options, 
          size, 
          n, 
          aspectRatio,
          signal 
        });

        if (result.success) {
          this._stats.successfulRequests++;
          this._stats.totalImagesGenerated += result.images.length;

          this.emit('image_generated', {
            provider: providerName,
            promptLength: prompt.length,
            imageCount: result.images.length,
            size,
            aspectRatio,
            timestamp: Date.now()
          });

          return result;
        }
      } catch (error) {
        const safeMsg = redactText(error.message) || 'Unknown error';
        console.warn(`⚠️ 图像生成 ${providerName} 失败:`, safeMsg);
        this.emit('provider_error', {
          provider: providerName,
          error: safeMsg,
          timestamp: Date.now()
        });
      }
    }

    this._stats.failedRequests++;
    return {
      success: false,
      error: '所有图像生成提供商均失败',
      images: [],
      provider: 'none'
    };
  }

  async _callProvider(providerName, providerInfo, prompt, options) {
    switch (providerName) {
      case 'doubao':
        return this._callDoubao(providerName, providerInfo, prompt, options);
      case 'qwen':
        return this._callQwen(providerName, providerInfo, prompt, options);
      default:
        return this._callDoubao(providerName, providerInfo, prompt, options);
    }
  }

  async _callDoubao(providerName, providerInfo, prompt, options) {
    const providerConfig = this._getProviderConfig(providerName);
    if (!providerConfig) {
      return { success: false, error: `未找?${providerName} 配置`, images: [] };
    }

    const baseUrl = providerConfig.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3';
    const apiKey = providerConfig.apiKey;
    const model = providerConfig.model || providerInfo.model;
    const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`;

    const size = options.size || '1920x1920';
    const [width, height] = size.split('x').map(Number);
    const pixels = width * height;
    const minPixels = providerInfo.minPixels || 3686400;

    if (pixels < minPixels) {
      throw new Error(`图片尺寸 ${size} 太小，豆?Seedream 要求至少 ${minPixels} 像素（约 ${Math.sqrt(minPixels).toFixed(0)}x${Math.sqrt(minPixels).toFixed(0)}）`);
    }

    const enhancedPrompt = this._addQualityKeywords(prompt, options);

    const body = {
      model,
      prompt: enhancedPrompt,
      n: Math.min(options.n || 1, providerInfo.maxN),
      size,
      response_format: 'url',
      quality: options.quality === 'hd' ? 'hd' : 'standard',
      style: options.style || 'vivid'
    };

    console.log(`🎨 豆包 Seedream 请求: model=${model}, size=${size}, quality=${body.quality}`);
    console.log(`   提示? ${enhancedPrompt.substring(0, 50)}...`);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: options.signal || AbortSignal.timeout(180000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Doubao Image API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();
    
    const images = [];
    for (const item of (data.data || [])) {
      if (item.url) {
        const downloaded = await this._downloadImage(item.url, options, providerName);
        if (downloaded.filePath) {
          images.push({
            url: item.url,
            filePath: downloaded.filePath,
            fileName: downloaded.fileName,
            size
          });
        } else {
          images.push({
            url: item.url,
            filePath: null,
            fileName: null,
            size
          });
        }
      }
    }

    return {
      success: true,
      images,
      provider: providerName,
      model,
      revisedPrompt: enhancedPrompt,
      raw: data
    };
  }

  _addQualityKeywords(prompt, options) {
    const qualityKeywords = [
      'high quality',
      'detailed',
      'professional',
      'sharp focus'
    ];
    
    const styleKeywords = {
      vivid: ['vivid colors', 'rich saturation', 'dynamic lighting'],
      natural: ['natural lighting', 'realistic', 'soft tones'],
      cinematic: ['cinematic', 'dramatic lighting', 'film look'],
      artistic: ['artistic', 'creative', 'stylized']
    };
    
    const style = options.style || 'vivid';
    const styleWords = styleKeywords[style] || styleKeywords.vivid;
    
    if (prompt.toLowerCase().includes('high quality') || 
        prompt.toLowerCase().includes('professional') ||
        prompt.toLowerCase().includes('detailed')) {
      return prompt;
    }
    
    const enhancedPrompt = `${prompt}. ${qualityKeywords.join(', ')}, ${styleWords.join(', ')}`;
    
    if (enhancedPrompt.length > MAX_PROMPT_LENGTH) {
      return prompt;
    }
    
    return enhancedPrompt;
  }

  async _downloadImage(url, options, providerName) {
    const outputDir = options.outputDir || this._outputDir;
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const timestamp = Date.now();
    let randomSuffix;
    try {
      randomSuffix = crypto.randomBytes(4).toString("hex").slice(0, 8);
    } catch (e) {
      randomSuffix = Math.random().toString(36).slice(2, 10);
    }
    let fileName = `${providerName}_${timestamp}_${randomSuffix}.png`;
    let filePath = path.join(outputDir, fileName);
    
    try {
      console.log(`📥 下载图片: ${url.substring(0, 60)}...`);
      // 2026-09-08 实机修复: 下载无超时——返回 URL 下载挂起会让整个生成请求无限等待（实测 6 分钟无响应）
      const resp = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!resp.ok) {
        throw new Error(`下载图片失败: ${resp.status}`);
      }
      
      const arrayBuffer = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      // 2026-09-08: 按实际内容/响应头推断扩展名——豆包返回 JPEG 却硬编码 .png，
      // 扩展名失真会误导依赖它的下游工具
      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      const sniffExt = buffer[0] === 0x89 && buffer[1] === 0x50 ? '.png'
        : buffer[0] === 0xff && buffer[1] === 0xd8 ? '.jpg'
        : contentType.includes('png') ? '.png'
        : contentType.includes('webp') ? '.webp'
        : contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
        : path.extname(fileName) || '.png';
      if (path.extname(fileName) !== sniffExt) {
        const adjusted = filePath.slice(0, -path.extname(fileName).length) + sniffExt;
        fileName = path.basename(adjusted);
        filePath = adjusted;
      }
      fs.writeFileSync(filePath, buffer);
      
      console.log(`?图片已保? ${filePath}`);
      return { filePath, fileName };
    } catch (e) {
      console.warn(`⚠️ 下载图片失败: ${e.message}`);
      return { filePath: null, fileName: null };
    }
  }

  async _callQwen(providerName, providerInfo, prompt, options) {
    const providerConfig = this._getProviderConfig(providerName);
    if (!providerConfig) {
      return { success: false, error: `未找?${providerName} 配置`, images: [] };
    }

    const apiKey = providerConfig.apiKey;
    const baseUrl = providerConfig.baseUrl || providerConfig.base_url || providerInfo.url;

    const enhancedPrompt = this._addQualityKeywords(prompt, options);
    const size = options.size || '1024*1024';
    const qwenSize = size.replace('x', '*');

    const styleMap = {
      vivid: '<auto>',
      natural: '<photography>',
      cinematic: '<photography>',
      artistic: '<portrait>'
    };

    const body = {
      model: options.model || providerInfo.model,
      input: {
        prompt: enhancedPrompt
      },
      parameters: {
        size: qwenSize,
        n: Math.min(options.n || 1, providerInfo.maxN),
        style: styleMap[options.style] || '<auto>',
        ref_strength: 0.5,
        seed: Math.floor(Math.random() * 1000000)
      }
    };

    console.log(`🎨 Qwen ImageGen 请求: model=${body.model}, size=${qwenSize}, style=${body.parameters.style}`);
    console.log(`   提示? ${enhancedPrompt.substring(0, 50)}...`);

    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable'
      },
      body: JSON.stringify(body),
      signal: options.signal || AbortSignal.timeout(180000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Qwen Image API ${resp.status}: ${errText.substring(0, 200)}`);
    }

    const data = await resp.json();

    if (data.output?.task_status === 'SUCCEEDED') {
      const urls = data.output.results?.map(r => r.url || r.b64_image) || [];
      const images = await this._downloadAndSaveImages(urls, options, providerName);
      return {
        success: true,
        images,
        provider: providerName,
        model: providerInfo.model,
        raw: data
      };
    }

    if (data.output?.task_id) {
      const result = await this._pollQwenTask(baseUrl, apiKey, data.output.task_id, options, providerName);
      return result;
    }

    throw new Error(`Qwen Image API 返回异常状? ${data.output?.task_status || 'unknown'}`);
  }

  async _pollQwenTask(baseUrl, apiKey, taskId, options, providerName) {
    const pollUrl = `${baseUrl.replace(/\/text-to-image.*$/, '')}/tasks/${taskId}`;
    const maxAttempts = 60;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      const resp = await fetch(pollUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (!resp.ok) continue;

      const data = await resp.json();

      if (data.output?.task_status === 'SUCCEEDED') {
        const urls = data.output.results?.map(r => r.url || r.b64_image) || [];
        const images = await this._downloadAndSaveImages(urls, options, providerName);
        return {
          success: true,
          images,
          provider: providerName,
          model: IMAGE_GEN_PROVIDERS[providerName].model,
          raw: data
        };
      }

      if (data.output?.task_status === 'FAILED') {
        throw new Error(`Qwen 图像生成任务失败: ${data.output?.message || 'unknown'}`);
      }
    }

    throw new Error('Qwen 图像生成任务超时');
  }

  async _saveImageItems(items, options, providerName) {
    const outputDir = options.outputDir || this._outputDir;
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const images = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const timestamp = Date.now();
      let hash;
      try {
        hash = crypto.createHash('sha256').update(`${timestamp}_${i}`).digest('hex').slice(0, 8);
      } catch (e) {
        hash = Math.random().toString(36).slice(2, 10);
      }
      const fileName = `img_${hash}_${i + 1}.png`;
      let filePath = path.join(outputDir, fileName);

      try {
        let saved = false;

        if (item.b64_json) {
          const buffer = Buffer.from(item.b64_json, 'base64');
          fs.writeFileSync(filePath, buffer);
          saved = true;
        } else if (item.url) {
          if (item.url.startsWith('data:')) {
            const base64 = item.url.split(',')[1];
            if (base64) {
              fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
              saved = true;
            }
          } else {
            const imgResp = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
            if (imgResp.ok) {
              const arrayBuffer = await imgResp.arrayBuffer();
              fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
              saved = true;
            }
          }
        }

        if (saved && fs.existsSync(filePath)) {
          images.push({
            filePath,
            fileName,
            size: options.size || '1024x1024',
            provider: providerName
          });
        }
      } catch (e) {
        console.warn(`⚠️ 保存图像失败: ${e.message}`);
      }
    }

    return images;
  }

  async _saveGeneratedImages(imageDataList, options, providerName) {
    return this._saveImageItems(imageDataList, options, providerName);
  }

  async _downloadAndSaveImages(urls, options, providerName) {
    const items = urls.map(url => ({ url }));
    return this._saveImageItems(items, options, providerName);
  }

  getStats() {
    return { ...this._stats };
  }

  getProviders() {
    return Object.entries(IMAGE_GEN_PROVIDERS).map(([id, info]) => ({
      id,
      name: info.name,
      available: id === 'local' || this._hasValidKey(id)
    }));
  }
}

let _instance = null;

function getImageGenerator(config) {
  if (!_instance) {
    _instance = new ImageGenerator(config);
  }
  return _instance;
}

module.exports = {
  ImageGenerator,
  getImageGenerator,
  IMAGE_GEN_PROVIDERS,
  VALID_SIZES,
  VALID_ASPECT_RATIOS,
  ASPECT_RATIO_TO_SIZE,
  MAX_PROMPT_LENGTH,
  MAX_IMAGE_COUNT,
  MAX_MEDIA_BYTES,
  DEFAULT_TIMEOUT_MS,
  isSSRFBlocked
};
