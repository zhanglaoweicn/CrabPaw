const fs = require('fs').promises;

const fsSync = require('fs');

const path = require('path');

const { registry } = require('./registry');

const { CONFIG_PATH, loadConfig, DATA_DIR } = require('../core/config');

const { redactText, _maskToken } = require('../core/secret-redactor');

const { getAuxiliaryClient } = require('../core/auxiliary-client');

// 2026-08-28 M1: 生成器 outputPath 过权限门(与 Write 同源, 见 permissions/path-rules.js)
const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');

const {

  getImageGenerator,

  IMAGE_GEN_PROVIDERS,

  VALID_SIZES,

  VALID_ASPECT_RATIOS,

  ASPECT_RATIO_TO_SIZE,

  MAX_PROMPT_LENGTH,

  MAX_IMAGE_COUNT,

  MAX_MEDIA_BYTES, // eslint-disable-line no-unused-vars

  DEFAULT_TIMEOUT_MS,

  isSSRFBlocked // eslint-disable-line no-unused-vars

} = require('../core/image-gen');



function getImageUrl(filePath) {

  if (!filePath) return null;

  

  const normalizedPath = filePath.replace(/\\/g, '/');

  

  const isElectron = !!process.versions.electron;

  if (isElectron) {

    // 使用 local:/// 避免 Chromium 将 Windows 盘符 (如 C:) 解析为主机名
    return `local:///${normalizedPath.replace(/\\/g, '/')}`;

  }

  

  const apiPort = parseInt(process.env.API_PORT || '38767', 10);

  const dataDir = DATA_DIR || process.env.CRABPAW_DATA_DIR || '';

  let relativePath = filePath;

  if (dataDir && filePath.startsWith(dataDir)) {

    relativePath = filePath.substring(dataDir.length).replace(/^[\\/]+/, '');

  } else {

    const genIdx = normalizedPath.indexOf('generated-images/');

    if (genIdx >= 0) {

      relativePath = normalizedPath.substring(genIdx);

    } else {

      const ssIdx = normalizedPath.indexOf('screenshots/');

      if (ssIdx >= 0) {

        relativePath = normalizedPath.substring(ssIdx);

      } else {

        relativePath = path.basename(filePath);

      }

    }

  }

  relativePath = relativePath.replace(/\\/g, '/');

  return `http://localhost:${apiPort}/files/${encodeURIComponent(relativePath).replace(/%2F/g, '/')}`;

}



const PROMPT_ENHANCE_SYSTEM = `You are an expert prompt engineer for AI image generation. Your task is to enhance user prompts to produce better images. Rules: 1. Keep the core intent of the original prompt 2. Add artistic style, lighting, composition details 3. Add quality keywords 4. Match the requested image type 5. Output ONLY the enhanced prompt text`;



const PROMPT_ENHANCE_TEMPLATE = `Enhance the following image generation prompt:
Original prompt: {user_prompt}
Image type: {image_type}
Size/Aspect: {size_hint}

Enhanced prompt:`;



const IMAGE_GEN_TASKS = new Map();



const TASK_CLEANUP_INTERVAL = 60000;



let _taskCleanupTimer = null;



function startTaskCleanup() {

  if (_taskCleanupTimer) return;

  

  _taskCleanupTimer = setInterval(() => {

    const now = Date.now();

    for (const [taskId, task] of IMAGE_GEN_TASKS.entries()) {

      if (task.status === 'completed' || task.status === 'failed') {

        if (now - task.completedAt > 300000) {

          IMAGE_GEN_TASKS.delete(taskId);

        }

      }

      if (task.status === 'running' && now - task.startedAt > DEFAULT_TIMEOUT_MS * 2) {

        task.status = 'failed';

        task.error = 'Info';

        task.completedAt = now;

      }

    }

  }, TASK_CLEANUP_INTERVAL).unref();

}



function stopTaskCleanup() {
  if (_taskCleanupTimer) {
    clearInterval(_taskCleanupTimer);
    _taskCleanupTimer = null;
  }
}

function createImageGenTask(prompt, options) {

  let rnd;
  try { rnd = crypto.randomBytes(4).toString("hex").slice(0, 8); } catch (e) { rnd = Math.random().toString(36).slice(2, 10); }
  const taskId = `img_${Date.now()}_${rnd}`;

  const task = {

    id: taskId,

    prompt: prompt.substring(0, 100),

    fullPrompt: prompt,

    status: 'pending',

    startedAt: Date.now(),

    options,

    progress: 0,

    result: null,

    error: null

  };

  IMAGE_GEN_TASKS.set(taskId, task);

  startTaskCleanup();

  return task;

}



function updateTaskProgress(taskId, progress, message) {

  const task = IMAGE_GEN_TASKS.get(taskId);

  if (task) {

    task.progress = progress;

    task.progressMessage = message;

  }

}



function completeTask(taskId, result) {

  const task = IMAGE_GEN_TASKS.get(taskId);

  if (task) {

    task.status = 'completed';

    task.result = result;

    task.completedAt = Date.now();

    task.progress = 100;

  }

}



function failTask(taskId, error) {

  const task = IMAGE_GEN_TASKS.get(taskId);

  if (task) {

    task.status = 'failed';

    task.error = error;

    task.completedAt = Date.now();

  }

}



function getTaskStatus(taskId) {

  const task = IMAGE_GEN_TASKS.get(taskId);

  if (!task) {

    return { error: ` ${taskId}` };

  }

  return {

    success: true,

    task_id: taskId,

    status: task.status,

    progress: task.progress,

    progress_message: task.progressMessage,

    prompt_preview: task.prompt,

    started_at: task.startedAt,

    completed_at: task.completedAt,

    elapsed_ms: task.completedAt ? (task.completedAt - task.startedAt) : (Date.now() - task.startedAt),

    result: task.result,

    error: task.error

  };

}



function listActiveTasks() {

  const active = [];

  for (const [taskId, task] of IMAGE_GEN_TASKS.entries()) {

    if (task.status ==='running' || task.status === 'pending') {

      active.push({

        task_id: taskId,

        status: task.status,

        progress: task.progress,

        prompt_preview: task.prompt,

        started_at: task.startedAt

      });

    }

  }

  return active;

}



// src/core/vision-resolver.js  config 
// VISION_MODELS / PROVIDER_VISION_MODEL / isVisionModel / getVisionModel 
// vision-resolver.js
const {

  resolveVisionModel: _resolveVisionModel,

  isVisionCapable: isVisionModel,

  buildSetupGuide: _buildVisionSetupGuide,

  VISION_CAPABLE_PROVIDERS,

  SUGGESTED_VISION_MODELS,

} = require('../core/vision-resolver');



// getVisionModel(provider, currentModel, config)
//  config provider/model/baseUrl/apiKey
function getVisionModel(config) {

  return _resolveVisionModel(config);

}



async function enhancePrompt(userPrompt, options = {}) {

  const config = getConfig();

  const imageConfig = config.imageGeneration || {};

  const modelConfig = config.models || {};

  

  const enhanceConfig = imageConfig.enhancePrompt || {};

  const provider = enhanceConfig.provider || modelConfig.currentProvider ||'deepseek';

  const providerConfig = modelConfig.providers?.[provider] || {};

  

  const apiKey = enhanceConfig.apiKey || providerConfig.apiKey;

  const baseUrl = enhanceConfig.baseUrl || providerConfig.baseUrl || 'https://api.deepseek.com/v1';

  const model = enhanceConfig.model || providerConfig.model || 'deepseek-chat';

  

  console.log('Info');

  console.log(`   Provider: ${provider}`);

  console.log(`   Model: ${model}`);

  console.log(`   Base URL: ${baseUrl}`);

  console.log(`   API Key: ${apiKey ? '(' + _maskToken(apiKey) + ')' : 'Info'}`);
  

  if (!apiKey) {

    console.log('API Key');

    return { enhanced: userPrompt, original: userPrompt, enhancedByAI: false };

  }

  

  const imageType = options.imageType || 'general';

  const sizeInfo = options.aspectRatio || options.size || 'default';

  

  const enhancePromptText = PROMPT_ENHANCE_TEMPLATE

    .replace('{user_prompt}', userPrompt)

    .replace('{image_type}', imageType)

    .replace('{size_info}', sizeInfo);

  

  try {

    console.log('..');

    

    const response = await fetch(`${baseUrl}/chat/completions`, {

      method: 'POST',

      headers: {

        'Content-Type': 'application/json',

        'Authorization': `Bearer ${apiKey}`

      },

      body: JSON.stringify({

        model: model,

        messages: [

          { role: 'system', content: PROMPT_ENHANCE_SYSTEM },

          { role: 'user', content: enhancePromptText }

        ],

        max_tokens: 500,

        temperature: 0.7

      }),

      signal: AbortSignal.timeout(30000)

    });

    

    if (!response.ok) {

      console.warn('Info', response.status);

      return { enhanced: userPrompt, original: userPrompt, enhancedByAI: false };

    }

    

    const data = await response.json();

    const enhancedPrompt = data.choices?.[0]?.message?.content?.trim() || userPrompt;

    

    console.log('Info');

    console.log(`   : ${userPrompt.substring(0, 50)}...`);

    console.log(`    ${enhancedPrompt.substring(0, 50)}...`);

    

    return {

      enhanced: enhancedPrompt,

      original: userPrompt,

      enhancedByAI: true,

      model: model,

      provider: provider

    };

  } catch (e) {

    console.warn('Info', e.message);

    return { enhanced: userPrompt, original: userPrompt, enhancedByAI: false };

  }

}



async function sendImageToWecom(imagePath, userId, config) {

  const wecomConfig = config.wecom || {};

  const corpId = wecomConfig.corpId;

  const secret = wecomConfig.secret;

  const agentId = wecomConfig.botId;

  

  if (!corpId || !secret || !agentId) {

    console.warn('Image generation via WeChat failed'); return { success: false, error: 'WeCom image send failed' };

  }

  

  try {

    console.log(` : ${imagePath}`);

    

    const imageBuffer = await fs.readFile(imagePath);

    const fileName = path.basename(imagePath);

    

    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`;

    const tokenResp = await fetch(tokenUrl);

    const tokenData = await tokenResp.json();

    

    if (tokenData.errcode !== 0) {

      console.error('access_token :', tokenData.errmsg);

      return { success: false, error: ` access_token : ${tokenData.errmsg}` };

    }

    

    const accessToken = tokenData.access_token;

    console.log('access_token');

    

    const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=image`;

    

    const boundary = `----WebKitFormBoundary${require('crypto').randomBytes(8).toString('hex')}`;

    const header = Buffer.from([

      `--${boundary}`,

      `Content-Disposition: form-data; name="media"; filename="${fileName}"`,

      `Content-Type: image/png`,

      '',

      ''

    ].join('\r\n'), 'utf-8');

    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');

    const multipartBuffer = Buffer.concat([header, imageBuffer, footer]);

    

    const uploadResp = await fetch(uploadUrl, {

      method: 'POST',

      headers: {

        'Content-Type': `multipart/form-data; boundary=${boundary}`

      },

      body: multipartBuffer

    });

    const uploadData = await uploadResp.json();

    

    if (uploadData.errcode) {

      console.error(':', uploadData.errmsg);

      return { success: false, error: `: ${uploadData.errmsg}` };

    }

    

    const mediaId = uploadData.media_id;

    console.log(', media_id:', mediaId);

    

    const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;

    const sendResp = await fetch(sendUrl, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({

        touser: userId,

        msgtype: 'image',

        agentid: agentId,

        image: { media_id: mediaId }

      })

    });

    const sendData = await sendResp.json();

    

    if (sendData.errcode !== 0) {

      console.error('Info', sendData.errmsg);

      return { success: false, error: ` ${sendData.errmsg}` };

    }

    

    console.log('Info');

    return { success: true, msgId: sendData.msgid };

  } catch (e) {

    console.error(':', e.message);

    return { success: false, error: e.message };

  }

}



function getConfig() {

  try {

    return loadConfig();

  } catch (e) {

    try {

      const content = fsSync.readFileSync(CONFIG_PATH, 'utf8');

      return JSON.parse(content);

    } catch (e2) {

      return {};

    }

  }

}



async function callOpenAIVisionAPI(baseUrl, apiKey, model, messages, maxTokens = 4096) {

  const response = await fetch(`${baseUrl}/chat/completions`, {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json',

      'Authorization': `Bearer ${apiKey}`

    },

    body: JSON.stringify({

      model: model,

      messages: messages,

      max_tokens: maxTokens

    })

  });

  

  if (!response.ok) {

    const errorText = await response.text();

    throw new Error(`API : ${response.status} ${errorText}`);

  }

  

  return await response.json();

}



async function callAnthropicVisionAPI(baseUrl, apiKey, model, messages, maxTokens = 2000) {

  const systemMessage = messages.find(m => m.role ==='system');

  const userMessages = messages.filter(m => m.role !== 'system');

  

  let content = [];

  for (const msg of userMessages) {

    if (typeof msg.content === 'string') {

      content.push({ type: 'text', text: msg.content });

    } else if (Array.isArray(msg.content)) {

      for (const item of msg.content) {

        if (item.type === 'text') {

          content.push({ type: 'text', text: item.text });

        } else if (item.type === 'image_url') {

          const imageData = item.image_url.url;

          const base64Match = imageData.match(/^data:([^;]+);base64,(.+)$/);

          if (base64Match) {

            content.push({

              type: 'image',

              source: {

                type: 'base64',

                media_type: base64Match[1],

                data: base64Match[2]

              }

            });

          }

        }

      }

    }

  }

  

  const response = await fetch(`${baseUrl}/messages`, {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json',

      'x-api-key': apiKey,

      'anthropic-version': '2023-06-01'

    },

    body: JSON.stringify({

      model: model,

      max_tokens: maxTokens,

      system: systemMessage?.content || '',

      messages: [{ role: 'user', content }]

    })

  });

  

  if (!response.ok) {

    const errorText = await response.text();

    throw new Error(`Anthropic API : ${response.status} ${errorText}`);

  }

  

  const data = await response.json();

  return {

    choices: [{

      message: {

        content: data.content?.[0]?.text ||''

      }

    }],

    usage: data.usage

  };

}



async function callGeminiVisionAPI(baseUrl, apiKey, model, messages, maxTokens = 2000) {

  const userMessage = messages.find(m => m.role === 'user');

  let contents = [];

  

  if (Array.isArray(userMessage?.content)) {

    const parts = [];

    for (const item of userMessage.content) {

      if (item.type === 'text') {

        parts.push({ text: item.text });

      } else if (item.type === 'image_url') {

        const imageData = item.image_url.url;

        const base64Match = imageData.match(/^data:([^;]+);base64,(.+)$/);

        if (base64Match) {

          parts.push({

            inline_data: {

              mime_type: base64Match[1],

              data: base64Match[2]

            }

          });

        }

      }

    }

    contents.push({ role: 'user', parts });

  }

  

  const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {

    method: 'POST',

    headers: {

      'Content-Type': 'application/json'},

    body: JSON.stringify({

      contents,

      generationConfig: {

        maxOutputTokens: maxTokens

      }

    })

  });

  

  if (!response.ok) {

    const errorText = await response.text();

    throw new Error(`Gemini API : ${response.status} ${errorText}`);

  }

  

  const data = await response.json();

  return {

    choices: [{

      message: {

        content: data.candidates?.[0]?.content?.parts?.[0]?.text ||''

      }

    }],

    usage: data.usageMetadata

  };

}



async function handleImageAnalyze(params, _context) {

  // Accept both image_path (from tool contract) and file_path (legacy)
  const file_path = params.image_path || params.file_path;
  const prompt = params.prompt || params.query || 'Analyze this image in detail';

  if (!file_path) {
    return { error: 'file_path is required' };
  }

  try {
    const stats = await fs.stat(file_path);
    if (!stats.isFile()) {
      return { error: 'Path is not a file' };
    }
    if (stats.size > 20 * 1024 * 1024) {
      return { error: 'File exceeds 20MB limit' };
    }
  } catch (e) {
    return { error: `Cannot access file: ${file_path}` };
  }

  const ext = path.extname(file_path).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  if (!imageExts.includes(ext)) {
    return { error: `Unsupported format: ${ext}` };
  }

  const config = getConfig();
  const provider = config.models?.currentProvider || 'deepseek';
  const currentModel = config.models?.providers?.[provider]?.model;

  let imageBuffer;
  try {
    imageBuffer = await fs.readFile(file_path);
  } catch (e) {
    return { error: `Failed to read file: ${e.message}` };
  }
  const base64Image = imageBuffer.toString('base64');

  // Step 1: Try AuxiliaryClient for vision analysis
  try {
    const auxClient = getAuxiliaryClient();
    const auxResult = await auxClient.analyzeImage(base64Image, prompt, {
      // 2026-08-21: 推理模型（deepseek-v4-flash-vision-exp）maxTokens 低时
      // reasoning 占满预算 → content 空 → 误报「视觉接口返回为空」。4096 实测有内容。
      maxTokens: 4096,
      temperature: 0.3,
      timeout: 60000,
    });
    if (auxResult && auxResult.content) {
      console.log(`AuxiliaryClient analysis succeeded (provider=${auxResult.provider}, model=${auxResult.model})`);
      // 2026-08-25 视觉记忆: 图片语义入记忆库(标签:视觉/影像)——
      // 之后「之前看过的那张图/那些截图」可经 Memory/KbSearch 检索(Memory 工具 search)。
      try {
        const { handleMemory } = require('./memory-tools');
        await handleMemory({
          action: 'write',
          content: '[视觉影像] ' + String(auxResult.content).slice(0, 500),
          title: '[视觉] ' + path.basename(file_path),
          type: 'image',
          tags: '视觉,影像,图片语义',
          importance: 0.6,
        }, {});
      } catch (memErr) { console.warn('[ImageAnalyze] 视觉记忆写入失败(不阻塞):', memErr.message); }
      return {
        success: true,
        file_path,
        analysis: auxResult.content,
        model: auxResult.model,
        provider: auxResult.provider,
        routed_via: 'auxiliary-client',
        source: auxResult.source,
        warning: auxResult.warning || null,
        usage: auxResult.usage,
      };
    }
  } catch (auxErr) {
    console.warn(`AuxiliaryClient unavailable: ${auxErr.message}`);
    if (auxErr.setupGuide) {
      console.warn(auxErr.setupGuide);
    }
  }

  // Step 2: Fall back to direct provider API
  if (isVisionModel(provider, currentModel)) {
    const apiKey = config.models?.providers?.[provider]?.apiKey;
    const baseUrl = config.models?.providers?.[provider]?.baseUrl;
    if (!apiKey) {
      return { error: 'No API key configured for vision provider' };
    }
    const visionModel = currentModel;
    const mimeType = ext === '.png' ? 'image/png' :
                      ext === '.gif' ? 'image/gif' :
                      ext === '.webp' ? 'image/webp' : 'image/jpeg';
    console.log(`Calling ${provider} vision API (model: ${visionModel})...`);

    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${base64Image}`,
            detail: 'high'
          }
        }
      ]
    }];

    try {
      let data;
      const apiBaseUrl = baseUrl || getDefaultBaseUrl(provider);
      switch (provider) {
        case 'anthropic':
          data = await callAnthropicVisionAPI(apiBaseUrl, apiKey, visionModel, messages);
          break;
        case 'google':
          data = await callGeminiVisionAPI(apiBaseUrl, apiKey, visionModel, messages);
          break;
        default:
          data = await callOpenAIVisionAPI(apiBaseUrl, apiKey, visionModel, messages);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        return { error: 'Vision API returned empty response' };
      }

      return {
        success: true,
        file_path,
        analysis: content,
        model: visionModel,
        provider,
        routed_via: 'direct',
        usage: data.usage || null
      };
    } catch (e) {
      if (e.message.includes('unknown variant') || e.message.includes('image_url')) {
        return _visionErrorResult(currentModel, provider, e, config);
      }
      return { error: `Vision analysis error: ${e.message}` };
    }
  }

  // Step 3: No vision-capable model available
  return _visionErrorResult(currentModel, provider, null, config);
}

function _visionErrorResult(currentModel, provider, originalError, config) {
  const guide = (config && _buildVisionSetupGuide(config)) || '';
  const suggestion = [
    `Model ${currentModel || 'current'} from provider ${provider} is not vision-capable.`,
    '',
    guide || 'Configure models.auxiliary.vision for automatic routing to a capable vision model.',
    '',
    'Supported vision models: gpt-4o, claude-3-5-sonnet, gemini-2.0-flash, deepseek-vision, qwen-vl'
  ].join('\n');
  return {
    error: 'No vision-capable model available',
    suggestion,
    provider,
    current_model: currentModel,
    original_error: originalError?.message || null
  };
}



function getDefaultBaseUrl(provider) {

  const urls = {

    openai:'https://api.openai.com/v1',

    deepseek: 'https://api.deepseek.com/v1',

    anthropic: 'https://api.anthropic.com/v1',

    google: 'https://generativelanguage.googleapis.com/v1beta',

    qwen: 'https://dashscope.aliyuncs.com/api/v1',

    zhipu: 'https://open.bigmodel.cn/api/paas/v4',

    doubao: 'https://ark.cn-beijing.volces.com/api/coding/v3'

  };

  return urls[provider] || 'https://api.openai.com/v1';

}



async function handleImageOCR(params, context) {
  const file_path = params.image_path || params.file_path;

  if (!file_path) {
    return { error: 'image_path is required' };
  }

  try {
    const stats = await fs.stat(file_path);
    if (!stats.isFile()) {
      return { error: 'Path is not a valid file' };
    }
  } catch (e) {
    return { error: `Cannot access file: ${file_path}` };
  }

  const ext = path.extname(file_path).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  if (!imageExts.includes(ext)) {
    return { error: `Unsupported format: ${ext}` };
  }

  // Delegate to handleImageAnalyze with OCR-optimized prompt
  return handleImageAnalyze({
    file_path,
    prompt: 'Extract and transcribe all visible text from this image. Return the text exactly as it appears, preserving formatting and structure.'
  }, context);
}

async function handleImageInfo(params, _context) {
  const { file_path } = params;

  if (!file_path) {
    return { error: 'file_path is required' };
  }

  try {
    const stats = await fs.stat(file_path);
    const ext = path.extname(file_path).toLowerCase();

    return {
      success: true,
      file_path,
      file_name: path.basename(file_path),
      size_bytes: stats.size,
      size_kb: Math.round(stats.size / 1024 * 100) / 100,
      extension: ext,
      created: stats.birthtime,
      modified: stats.mtime
    };
  } catch (e) {
    return { error: `Cannot read file info: ${e.message}` };
  }
}

// eslint-disable-next-line no-unused-vars
async function handleVisionModelsList(_params, context) {
  const config = getConfig();
  const resolved = _resolveVisionModel(config);

  return {
    success: true,
    currentlyResolved: resolved,
    suggestedModels: SUGGESTED_VISION_MODELS,
    visionCapableProviders: VISION_CAPABLE_PROVIDERS,
    detectionKeywords: require('../core/vision-resolver').VISION_KEYWORDS,
    note: 'Configure models.auxiliary.vision or use Ollama: ollama pull llava / llama3.2-vision / moondream / minicpm-v'
  };
}

async function handleImageGenerate(params, context) {
  const {
    action = 'generate',
    prompt,
    size,
    aspectRatio,
    n = 1,
    quality = 'standard',
    style = 'vivid',
    output_dir,
    timeoutMs,
    task_id,
    enhance_prompt = true,
    send_to_wecom = false,
    wecom_user_id
  } = params;

  // Action routing
  if (action === 'list') {
    return handleImageProvidersList(params, context);
  }

  if (action === 'status') {
    if (task_id) {
      return getTaskStatus(task_id);
    }
    return {
      success: true,
      active_tasks: listActiveTasks(),
      total_tasks: IMAGE_GEN_TASKS.size,
      message: `${IMAGE_GEN_TASKS.size} active tasks`
    };
  }

  if (action === 'enhance') {
    if (!prompt) {
      return { error: 'prompt is required for enhancement' };
    }
    const result = await enhancePrompt(prompt, { imageType: aspectRatio || '1:1' });
    return {
      success: true,
      original: prompt,
      enhanced: result.enhanced,
      preview_params: result.preview_params || null
    };
  }

  // Validate generation params
  if (!prompt) {
    return { error: 'prompt is required for image generation' };
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return { error: `Prompt exceeds max length: ${prompt.length} (max ${MAX_PROMPT_LENGTH})` };
  }

  if (aspectRatio && !VALID_ASPECT_RATIOS.has(aspectRatio)) {
    return {
      error: `Invalid aspect ratio: ${aspectRatio}`,
      supported: Array.from(VALID_ASPECT_RATIOS)
    };
  }

  let effectiveSize = size;
  if (aspectRatio && !effectiveSize) {
    effectiveSize = ASPECT_RATIO_TO_SIZE[aspectRatio] || '1920x1920';
  }
  if (!effectiveSize) {
    effectiveSize = '1920x1920';
  }

  if (!VALID_SIZES.has(effectiveSize)) {
    return {
      error: `Invalid size: ${effectiveSize}`,
      supported: Array.from(VALID_SIZES)
    };
  }

  if (n < 1 || n > MAX_IMAGE_COUNT) {
    return { error: `Count must be 1-${MAX_IMAGE_COUNT}` };
  }

  const config = getConfig();
  const imageConfig = config.imageGeneration || {};
  const provider = imageConfig.provider || 'doubao';
  const apiKey = imageConfig.providers?.[provider]?.apiKey ||
                 config.models?.providers?.[provider]?.apiKey;

  if (!apiKey && provider !== 'local') {
    return {
      error: `Missing API Key for ${IMAGE_GEN_PROVIDERS[provider]?.name || provider}`,
      suggestion: 'Configure the API Key in your config file'
    };
  }

  let effectivePrompt = prompt;
  if (enhance_prompt) {
    try {
      const enhanced = await enhancePrompt(prompt, { imageType: aspectRatio || '1:1' });
      effectivePrompt = enhanced.enhanced || prompt;
    } catch (e) {
      console.warn('Prompt enhancement failed, using original:', e.message);
    }
  }

  const task = createImageGenTask(prompt, {
    size: effectiveSize,
    aspectRatio,
    n,
    quality,
    style,
    output_dir,
    provider
  });
  task.status = 'running';

  try {
    console.log(`Starting image generation with ${IMAGE_GEN_PROVIDERS[provider]?.name || provider}...`);
    console.log(`  Prompt: ${prompt.substring(0, 50)}...`);
    console.log(`  Size: ${effectiveSize}, Aspect: ${aspectRatio || 'N/A'}, Count: ${n}`);

    const generator = getImageGenerator({ config });
    const result = await generator.generate(effectivePrompt, {
      size: effectiveSize,
      aspectRatio,
      n,
      quality,
      style,
      outputDir: output_dir,
      timeoutMs: timeoutMs || imageConfig.timeoutMs || 120000
    });

    if (!result.success) {
      failTask(task.id, result.error || 'Generation failed');
      return { error: result.error || 'Generation failed' };
    }

    updateTaskProgress(task.id, 90, 'Processing results...');

    const images = result.images || [];
    const previews = images.map(img => img.filePath ? getImageUrl(img.filePath) : null);

    let contentText = 'Image generation completed\n\n';
    contentText += `**Prompt**: ${prompt}\n`;
    if (effectivePrompt !== prompt) {
      contentText += `**Enhanced**: ${effectivePrompt}\n`;
    }
    contentText += `**Size**: ${effectiveSize}\n`;
    contentText += `**Aspect**: ${aspectRatio || 'auto'}\n`;
    contentText += `**Provider**: ${result.provider}\n`;
    contentText += `**Model**: ${result.model}\n`;
    contentText += `**Output**: ${images[0]?.filePath || 'N/A'}\n\n`;

    if (previews.length > 0) {
      const previewUrl = previews[0];
      contentText += `### Preview\n\n${previewUrl ? `![Preview](${previewUrl})` : 'No preview available'}\n\n`;
    }

    let wecomSendResult = null;
    if (send_to_wecom && images.length > 0 && images[0].filePath) {
      try {
        const wecomConfig = config.wechatWork || config.wecom || {};
        const userId = wecom_user_id || wecomConfig.defaultUserId;
        if (userId) {
          wecomSendResult = await sendImageToWecom(images[0].filePath, userId, config);
          if (wecomSendResult.success) {
            contentText += `Sent to WeChat user ${userId}\n`;
          }
        }
      } catch (we) {
        console.warn('WeChat send failed:', we.message);
      }
    }

    const response = {
      success: true,
      content: contentText,
      prompt,
      enhanced_prompt: effectivePrompt !== prompt ? effectivePrompt : null,
      provider: result.provider,
      model: result.model,
      size: effectiveSize,
      aspect_ratio: aspectRatio,
      images: images.map(img => ({
        file_path: img.filePath,
        file_name: img.fileName,
        width: img.width,
        height: img.height,
        local_url: img.filePath ? getImageUrl(img.filePath) : null,
        revised_prompt: img.revisedPrompt || null
      })),
      total_images: images.length,
      preview: previews.length > 0 ? previews[0] : null,
      image_path: images.length > 0 ? images[0].filePath : null,
      wecom_sent: wecomSendResult?.success || false,
      message: `Generated ${images.length} images${wecomSendResult?.success ? ' (sent to WeChat)' : ''}`
    };

    completeTask(task.id, response);

    try {
      const { recordUsage } = require('../core/usage-stats');
      recordUsage(response.provider, response.model, null, {
        type: 'image',
        imageCount: response.total_images
      });
    } catch (e) {
      console.warn('Usage recording failed:', e.message);
    }

    return response;
  } catch (e) {
    const safeMsg = redactText(e.message) || 'Unknown error';
    failTask(task.id, safeMsg);
    return { error: `Generation error: ${safeMsg}` };
  }
}

// eslint-disable-next-line no-unused-vars
async function handleImageProvidersList(_params, context) {
  const config = getConfig();
  const imageConfig = config.imageGeneration || {};

  const providers = Object.entries(IMAGE_GEN_PROVIDERS).map(([id, info]) => {
    const apiKey = imageConfig.providers?.[id]?.apiKey ||
                    config.models?.providers?.[id]?.apiKey;
    const isConfigured = !!apiKey;
    return {
      id,
      name: info.name,
      model: info.model,
      configured: isConfigured,
      auth_hint: isConfigured ? 'Configured' : `Set API key at models.providers.${id}.apiKey or imageGeneration.providers.${id}.apiKey`
    };
  });

  const configuredCount = providers.filter(p => p.configured).length;

  return {
    success: true,
    current_provider: imageConfig.provider || 'doubao',
    current_model: imageConfig.model || IMAGE_GEN_PROVIDERS.doubao?.model,
    providers,
    configured_count: configuredCount,
    supported_sizes: Array.from(VALID_SIZES),
    supported_aspect_ratios: Array.from(VALID_ASPECT_RATIOS),
    max_images_per_request: MAX_IMAGE_COUNT
  };
}

// eslint-disable-next-line no-unused-vars
async function handleImageGenStats(_params, context) {
  const config = getConfig();
  const generator = getImageGenerator({ config });
  const stats = generator.getStats ? generator.getStats() : {};

  return {
    success: true,
    stats,
    total_tasks: IMAGE_GEN_TASKS.size,
    active_tasks: listActiveTasks(),
    message: 'Image generation statistics'
  };
}

// ============ Registry ============

registry.register({
  name: 'ImageGenStats',
  description: 'Get image generation statistics and active task status',
  schema: {
    type: 'object',
    properties: {}
  },
  handler: handleImageGenStats,
  category: 'media',
  whenNotToUse: ['需要生成或编辑图像时'],
  riskLevel: 'low'
});

registry.register({
  name: 'ImageAnalyze',
  description: 'Analyze images with AI vision models (gpt-4o, claude-3-5-sonnet, gemini-2.0-flash, deepseek-vision). Supports PNG, JPG, JPEG, GIF, BMP, WEBP up to 20MB. 参数名为 file_path（图片绝对路径，如 D:\\...\\uploads\\x.png），不是 image/imagePath/图片路径。',
  schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the image file to analyze（必填，图片绝对路径，来自上传返回的 path 或用户提到的文件路径）'
      },
      prompt: {
        type: 'string',
        description: 'Question or instruction about the image (e.g. "What is in this image?")'
      }
    },
    required: ['file_path']
  },
  handler: handleImageAnalyze,
  category: 'media',
  whenNotToUse: ['需要生成或编辑图像时', '图像文件不存在时'],
  riskLevel: 'low'
});

registry.register({
  name: 'ImageOCR',
  description: 'Extract text from images using AI-powered OCR',
  schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the image for text extraction'
      }
    },
    required: ['file_path']
  },
  handler: handleImageOCR,
  category: 'media',
  whenNotToUse: ['需要生成或编辑图像时'],
  riskLevel: 'low'
});

registry.register({
  name: 'ImageInfo',
  description: 'Get metadata and file information for an image (size, format, dimensions)',
  schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Path to the image file'
      }
    },
    required: ['file_path']
  },
  handler: handleImageInfo,
  category: 'media',
  whenNotToUse: ['需要图像内容理解时'],
  riskLevel: 'low'
});

registry.register({
  name: 'ImageGenerate',
  description: 'Generate images using AI from text prompts via supported providers (OpenAI DALL-E, Doubao, Stability AI, etc.)',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation: generate, list, status, or enhance',
        enum: ['generate', 'list', 'status', 'enhance'],
        default: 'generate'
      },
      prompt: {
        type: 'string',
        description: 'Text description of the image to generate'
      },
      size: {
        type: 'string',
        description: 'Output size (1024x1024, 1792x1024, etc.)'
      },
      aspectRatio: {
        type: 'string',
        description: 'Aspect ratio (1:1, 16:9, 9:16, 4:3, 3:4)'
      },
      n: {
        type: 'number',
        description: 'Number of images to generate (1-4)',
        default: 1
      },
      quality: {
        type: 'string',
        description: 'Quality: standard or hd',
        default: 'standard'
      },
      style: {
        type: 'string',
        description: 'Style: vivid or natural',
        default: 'vivid'
      },
      output_dir: {
        type: 'string',
        description: 'Custom output directory'
      },
      timeoutMs: {
        type: 'number',
        description: 'Custom timeout in milliseconds'
      },
      task_id: {
        type: 'string',
        description: 'Task ID for status tracking'
      },
      enhance_prompt: {
        type: 'boolean',
        description: 'Auto-enhance prompt for better results',
        default: true
      },
      send_to_wecom: {
        type: 'boolean',
        description: 'Send generated image to WeChat Work',
        default: false
      },
      wecom_user_id: {
        type: 'string',
        description: 'WeChat Work user ID to send image to'
      }
    },
    required: ['prompt']
  },
  handler: handleImageGenerate,
  category: 'media',
  whenNotToUse: ['无可用图像生成提供商时', '需要编辑已有图像时'],
  riskLevel: 'medium'
});

registry.register({
  name: 'ImageProvidersList',
  description: 'List available image generation providers and their configuration status',
  schema: {
    type: 'object',
    properties: {}
  },
  handler: handleImageProvidersList,
  category: 'media',
  whenNotToUse: ['需要生成图像时'],
  riskLevel: 'low'
});

registry.register({
  name: 'VisionModelsList',
  description: 'List available vision models and their capabilities',
  schema: {
    type: 'object',
    properties: {}
  },
  handler: handleVisionModelsList,
  category: 'media',
  whenNotToUse: ['需要图像处理时'],
  riskLevel: 'low'
});

// ============================================================
// ImageEdit — 图片编辑与美化（裁剪/缩放/旋转/滤镜/水印/格式转换）
// ============================================================

function _getSharp() {
  try { return require('sharp'); } catch (_) { return null; }
}

/**
 * 解析十六进制颜色字符串为 sharp 可用的对象
 */
function _parseColor(color) {
  if (!color) return null;
  if (typeof color === 'object') return color;
  const hex = color.replace('#', '');
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

async function handleImageEdit(params) {
  const sharp = _getSharp();
  if (!sharp) {
    return { success: false, error: 'sharp 未安装。请运行: npm install sharp' };
  }

  const {
    input_path, output_path,
    resize, crop, rotate, flip, flop,
    format, quality,
    blur, sharpen,
    brightness, contrast, saturation,
    grayscale, negate, tint,
    watermark_text, watermark_image, watermark_position,
    metadata: returnMeta,
  } = params;

  if (!input_path) {
    return { success: false, error: 'input_path is required' };
  }
  if (!fsSync.existsSync(input_path)) {
    return { success: false, error: `文件不存在: ${input_path}` };
  }

  try {
    let pipeline = sharp(input_path);

    // --- Resize ---
    if (resize) {
      const { width, height, fit = 'inside', withoutEnlargement = true } = resize;
      pipeline = pipeline.resize({
        width: width || undefined,
        height: height || undefined,
        fit: fit,
        withoutEnlargement: withoutEnlargement,
      });
    }

    // --- Crop ---
    if (crop) {
      const { left, top, width, height } = crop;
      pipeline = pipeline.extract({ left: left || 0, top: top || 0, width, height });
    }

    // --- Rotate ---
    if (rotate) {
      const angle = typeof rotate === 'object' ? (rotate.angle || 0) : Number(rotate);
      const bg = typeof rotate === 'object' ? _parseColor(rotate.background) : null;
      pipeline = pipeline.rotate(angle, bg ? { background: bg } : undefined);
    }

    // --- Flip/Flop ---
    if (flip) pipeline = pipeline.flip();
    if (flop) pipeline = pipeline.flop();

    // --- Colors & Filters ---
    if (grayscale) pipeline = pipeline.grayscale();
    if (negate) pipeline = pipeline.negate();
    if (tint) {
      const tintColor = _parseColor(tint);
      if (tintColor) pipeline = pipeline.tint(tintColor);
    }
    if (typeof brightness === 'number' || typeof saturation === 'number') {
      const modOpts = {};
      if (typeof brightness === 'number') modOpts.brightness = brightness;
      if (typeof saturation === 'number') modOpts.saturation = saturation;
      pipeline = pipeline.modulate(modOpts);
    }
    if (typeof contrast === 'number') {
      // sharp doesn't have direct contrast, use linear for approximation
      const c = contrast;
      pipeline = pipeline.linear(c, -(0.5 * (c - 1)));
    }
    if (typeof blur === 'number') {
      pipeline = pipeline.blur(blur);
    }
    if (typeof sharpen === 'number' || sharpen === true) {
      const sigma = typeof sharpen === 'number' ? sharpen : 1.5;
      pipeline = pipeline.sharpen(sigma);
    }

    // --- Watermark (text overlay via SVG composite) ---
    if (watermark_text) {
      const meta = await sharp(input_path).metadata();
      const fontSize = watermark_text.size || Math.max(16, Math.floor(meta.width * 0.04));
      const wmColor = watermark_text.color || 'rgba(255,255,255,0.6)';
      const pos = watermark_position || 'southeast';

      // Build SVG text overlay
      const gravityMap = { northwest: 'top-left', north: 'top', northeast: 'top-right', west: 'left', center: 'center', east: 'right', southwest: 'bottom-left', south: 'bottom', southeast: 'bottom-right' };
      const gravity = gravityMap[pos] || 'bottom-right';
      const padding = 20;

      const svgText = `<svg width="${meta.width}" height="${meta.height}">
        <text x="${gravity.includes('right') ? meta.width - padding : gravity.includes('left') ? padding : meta.width / 2}"
              y="${gravity.includes('bottom') ? meta.height - padding : gravity.includes('top') ? fontSize + padding : meta.height / 2}"
              text-anchor="${gravity.includes('right') ? 'end' : gravity.includes('left') ? 'start' : 'middle'}"
              font-family="Arial, Microsoft YaHei, sans-serif"
              font-size="${fontSize}"
              fill="${wmColor}"
              stroke="rgba(0,0,0,0.3)"
              stroke-width="1">${watermark_text.text || watermark_text}</text>
      </svg>`;

      pipeline = pipeline.composite([{ input: Buffer.from(svgText), top: 0, left: 0 }]);
    }

    // --- Watermark image overlay ---
    if (watermark_image && fsSync.existsSync(watermark_image)) {
      const meta = await sharp(input_path).metadata();
      const wmMeta = await sharp(watermark_image).metadata();
      const pos = watermark_position || 'southeast';
      const padding = 10;

      const posMap = {
        northwest: { left: padding, top: padding },
        northeast: { left: meta.width - wmMeta.width - padding, top: padding },
        southwest: { left: padding, top: meta.height - wmMeta.height - padding },
        southeast: { left: meta.width - wmMeta.width - padding, top: meta.height - wmMeta.height - padding },
        center: { left: Math.floor((meta.width - wmMeta.width) / 2), top: Math.floor((meta.height - wmMeta.height) / 2) },
      };
      const wmPos = posMap[pos] || posMap.southeast;

      pipeline = pipeline.composite([{ input: watermark_image, ...wmPos }]);
    }

    // --- Format conversion ---
    const outFormat = format || path.extname(input_path).replace('.', '');
    const validFormats = ['png', 'jpeg', 'jpg', 'webp', 'avif', 'tiff', 'gif'];
    if (validFormats.includes(outFormat)) {
      const formatOpts = {};
      if (quality && ['jpeg', 'jpg', 'webp', 'avif', 'tiff'].includes(outFormat)) {
        formatOpts.quality = Math.min(100, Math.max(1, quality));
      }
      pipeline = pipeline.toFormat(outFormat === 'jpg' ? 'jpeg' : outFormat, Object.keys(formatOpts).length > 0 ? formatOpts : undefined);
    }

    // --- Output ---
    const outPath = output_path || input_path.replace(/\.\w+$/, `_edited.${outFormat === 'jpg' ? 'jpg' : outFormat || path.extname(input_path).replace('.', '')}`);
    // 2026-08-28 M1: 输出路径过权限门（PLAN 只读/系统保护路径拦截）
    if (!canWriteGeneratorOutput(outPath)) {
      throw new Error(`安全限制：不允许写入该输出路径（PLAN 只读模式或系统保护路径）: ${outPath}`);
    }
    await pipeline.toFile(outPath);

    const stats = fsSync.statSync(outPath);
    let meta = null;
    if (returnMeta) {
      meta = await sharp(outPath).metadata();
    }

    return {
      success: true,
      path: outPath,
      original: input_path,
      size: stats.size,
      sizeKB: (stats.size / 1024).toFixed(1),
      ...(meta ? { width: meta.width, height: meta.height, format: meta.format } : {}),
      message: `图片已处理 (${(stats.size / 1024).toFixed(1)} KB)`,
    };
  } catch (e) {
    console.error('ImageEdit 失败:', e.message);
    return { success: false, error: 'Image editing failed: ' + e.message };
  }
}

registry.register({
  name: 'ImageEdit',
  toolset: 'media',
  category: 'media',
  description: 'Edit and beautify images — resize, crop, rotate, flip, format conversion, blur, sharpen, brightness/contrast/saturation, grayscale, tint, watermark (text or image overlay). Uses sharp for high-performance processing.',
  schema: {
    type: 'object',
    properties: {
      input_path: { type: 'string', description: 'Path to the input image file' },
      output_path: { type: 'string', description: 'Output path (auto-generated if omitted, appends _edited)' },
      resize: { type: 'object', description: '{ width, height, fit: "cover"|"contain"|"fill"|"inside"|"outside", withoutEnlargement: true }' },
      crop: { type: 'object', description: '{ left, top, width, height } — pixel-accurate crop' },
      rotate: { description: 'Rotation angle in degrees (e.g. 90, 180, -45), or {angle, background: "#FFF"}' },
      flip: { type: 'boolean', description: 'Mirror vertically' },
      flop: { type: 'boolean', description: 'Mirror horizontally' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'avif', 'tiff', 'gif'], description: 'Convert to format' },
      quality: { type: 'number', description: 'Output quality 1-100 (JPEG/WebP/AVIF/TIFF)' },
      blur: { type: 'number', description: 'Gaussian blur sigma (0.3-1000)' },
      sharpen: { description: 'Sharpen the image. true = default sigma, or a number for custom strength' },
      brightness: { type: 'number', description: 'Brightness multiplier (1.0=unchanged, >1 brighter, <1 darker)' },
      contrast: { type: 'number', description: 'Contrast multiplier (1.0=unchanged, >1 more, <1 less)' },
      saturation: { type: 'number', description: 'Saturation multiplier (1.0=unchanged, 0=grayscale, >1 boosted)' },
      grayscale: { type: 'boolean', description: 'Convert to black and white' },
      negate: { type: 'boolean', description: 'Invert all colors' },
      tint: { type: 'string', description: 'Apply color tint, e.g. "#FF5733" or "#4080FF80"' },
      watermark_text: { description: '{ text, size, color } — overlay text watermark' },
      watermark_image: { type: 'string', description: 'Path to watermark image to overlay' },
      watermark_position: { type: 'string', enum: ['northwest', 'north', 'northeast', 'west', 'center', 'east', 'southwest', 'south', 'southeast'], description: 'Watermark position (default: southeast)' },
      metadata: { type: 'boolean', description: 'Return image metadata (width, height, format) in result' },
    },
    required: ['input_path'],
  },
  handler: handleImageEdit,
  timeout: 60000,
  isReadOnly: false,
  whenNotToUse: ['需要生成全新图像时', 'sharp 库不可用时'],
  riskLevel: 'medium',
});

module.exports = {
  handleImageAnalyze,
  handleImageOCR,
  handleImageInfo,
  handleVisionModelsList,
  handleImageGenerate,
  handleImageEdit,
  handleImageProvidersList,
  handleImageGenStats,
  isVisionModel,
  getVisionModel,
  VISION_MODELS: undefined,
  PROVIDER_VISION_MODEL: undefined,
  getTaskStatus,
  listActiveTasks,
  IMAGE_GEN_TASKS,
  stopTaskCleanup
};
