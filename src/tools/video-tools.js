const crypto = require('crypto');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { registry } = require('./registry');
const CONFIG_PATH = require('../core/config').CONFIG_PATH;
const { DATA_DIR } = require('../core/config');
const loadConfig = require('../core/config').loadConfig;
const { getVideoGenerator, VIDEO_GEN_PROVIDERS, VALID_RESOLUTIONS, VALID_ASPECT_RATIOS } = require('../core/video-gen/index');
const { redactText } = require('../core/secret-redactor');
// 2026-08-28 M1: 生成器 outputPath 过权限门(与 Write 同源, 见 permissions/path-rules.js)
const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');

function getVideoUrl(filePath) {
  if (!filePath) return null;
  
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  const isElectron = !!process.versions.electron;
  if (isElectron) {
    return `local:///${normalizedPath}`;
  }
  
  const apiPort = parseInt(process.env.API_PORT || '38767', 10);
  const dataDir = DATA_DIR || process.env.CRABPAW_DATA_DIR || '';
  let relativePath = filePath;
  if (dataDir && filePath.startsWith(dataDir)) {
    relativePath = filePath.substring(dataDir.length).replace(/^[\\/]+/, '');
  } else {
    const genIdx = normalizedPath.indexOf('generated-videos/');
    if (genIdx >= 0) {
      relativePath = normalizedPath.substring(genIdx);
    } else {
      relativePath = path.basename(filePath);
    }
  }
  relativePath = relativePath.replace(/\\/g, '/');
  return `http://localhost:${apiPort}/files/${encodeURIComponent(relativePath).replace(/%2F/g, '/')}`;
}

const VIDEO_GEN_TASKS = new Map();
const TASK_CLEANUP_INTERVAL = 60000;
const MAX_TASK_AGE = 300000;

let _taskCleanupTimer = null;

function startTaskCleanup() {
  if (_taskCleanupTimer) return;
  _taskCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [taskId, task] of VIDEO_GEN_TASKS.entries()) {
      if (task.status === 'completed' || task.status === 'failed') {
        if (now - task.completedAt > MAX_TASK_AGE) {
          VIDEO_GEN_TASKS.delete(taskId);
        }
      }
      if (task.status === 'running' && now - task.startedAt > 600000) {
        task.status = 'failed';
        task.error = 'Task timeout';
        task.completedAt = Date.now();
      }
    }
  }, TASK_CLEANUP_INTERVAL).unref();
}

/**
 * 停止任务清理轮询（进程退出/关闭时调用）
 */
function stopTaskCleanup() {
  if (_taskCleanupTimer) {
    clearInterval(_taskCleanupTimer);
    _taskCleanupTimer = null;
  }
}

function createVideoGenTask(prompt, options) {
  let vrnd; try { vrnd = crypto.randomBytes(4).toString("hex").slice(0, 8); } catch (e) { vrnd = Math.random().toString(36).slice(2, 10); }
  const taskId = `vid_${Date.now()}_${vrnd}`;
  const task = {
    id: taskId,
    prompt: prompt.substring(0, 100),
    fullPrompt: prompt,
    status: 'pending',
    startedAt: Date.now(),
    options,
    result: null,
    error: null
  };
  VIDEO_GEN_TASKS.set(taskId, task);
  startTaskCleanup();
  return task;
}

function completeVideoTask(taskId, result) {
  const task = VIDEO_GEN_TASKS.get(taskId);
  if (task) {
    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();
  }
}

function failVideoTask(taskId, error) {
  const task = VIDEO_GEN_TASKS.get(taskId);
  if (task) {
    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();
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

async function handleVideoGenerate(params, _context) {
  const {
    prompt,
    duration = 5,
    aspect_ratio = '16:9',
    resolution = '720P',
    input_image,
    output_dir
  } = params;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { error: 'Prompt is required and must not be empty' };
  }
  if (prompt.length > 2000) {
    return { error: `Prompt too long: ${prompt.length} chars (max 2000)` };
  }
  if (duration < 1 || duration > 10) {
    return { error: `Invalid duration: ${duration}s (must be 1-10s)` };
  }
  if (!VALID_ASPECT_RATIOS.has(aspect_ratio)) {
    return {
      error: `Invalid aspect ratio: ${aspect_ratio}`,
      supported: Array.from(VALID_ASPECT_RATIOS)
    };
  }
  if (!VALID_RESOLUTIONS.has(resolution)) {
    return {
      error: `Unsupported resolution: ${resolution}`,
      supported: Array.from(VALID_RESOLUTIONS)
    };
  }

  const config = getConfig();
  const videoConfig = config.videoGeneration || {};
  const provider = videoConfig.provider || 'doubao';
  const apiKey = videoConfig.providers?.[provider]?.apiKey ||
                 config.models?.providers?.[provider]?.apiKey;

  if (!apiKey && provider !== 'local') {
    return {
      error: `Missing API Key for ${VIDEO_GEN_PROVIDERS[provider]?.name || provider}`,
      suggestion: 'Configure the API Key in your config file'
    };
  }

  const task = createVideoGenTask(prompt, { duration, aspect_ratio, resolution });
  task.status = 'running';

  try {
    console.log(`Starting video generation with ${VIDEO_GEN_PROVIDERS[provider]?.name || provider}...`);
    console.log(`  Prompt: ${prompt.substring(0, 50)}...`);
    console.log(`  Duration: ${duration}s, Aspect: ${aspect_ratio}, Resolution: ${resolution}`);

    const generator = getVideoGenerator({ config });
    const result = await generator.generate(prompt, {
      duration,
      aspectRatio: aspect_ratio,
      resolution,
      inputImage: input_image,
      outputDir: output_dir
    });

    if (!result.success) {
      failVideoTask(task.id, result.error || 'Generation failed');
      return { error: result.error || 'Generation failed' };
    }

    const videos = result.videos || [];
    const previewUrl = videos.length > 0 && videos[0].filePath
      ? getVideoUrl(videos[0].filePath)
      : null;

    let contentText = 'Video generated successfully\n\n';
    contentText += `**Prompt**: ${prompt}\n`;
    contentText += `**Duration**: ${duration}s\n`;
    contentText += `**Aspect**: ${aspect_ratio}\n`;
    contentText += `**Resolution**: ${resolution}\n`;
    contentText += `**Provider**: ${result.provider}\n`;
    contentText += `**Output**: ${videos[0]?.filePath || 'N/A'}\n\n`;

    if (previewUrl) {
      contentText += `### Video Preview\n\n[video](${previewUrl})\n\n`;
    }

    const response = {
      success: true,
      content: contentText,
      prompt,
      provider: result.provider,
      model: result.model,
      duration,
      aspect_ratio,
      resolution,
      videos: videos.map(v => ({
        file_path: v.filePath,
        file_name: v.fileName,
        duration: v.duration,
        aspect_ratio: v.aspectRatio,
        local_url: v.filePath ? getVideoUrl(v.filePath) : null
      })),
      total_videos: videos.length,
      preview: previewUrl ? `[video](${previewUrl})` : null,
      video_path: videos.length > 0 ? videos[0].filePath : null,
      message: `Generated ${videos.length} video(s)`
    };

    completeVideoTask(task.id, response);

    try {
      const { recordUsage } = require('../core/usage-stats');
      recordUsage(response.provider, response.model, null, {
        type: 'video',
        durationSeconds: response.duration * (response.total_videos || videos.length || 1)
      });
    } catch (e) {
      console.warn('Usage recording failed:', e.message);
    }

    return response;
  } catch (e) {
    const safeMsg = redactText(e.message) || 'Unknown error';
    failVideoTask(task.id, safeMsg);
    return { error: `Generation error: ${safeMsg}` };
  }
}

async function handleVideoGenerateFromImage(params, _context) {
  const {
    image_path,
    prompt = '',
    duration = 5,
    aspect_ratio = '16:9',
    resolution = '720P'
  } = params;

  if (!image_path) {
    return { error: 'image_path is required' };
  }

  try {
    const stats = await fs.stat(image_path);
    if (!stats.isFile()) {
      return { error: 'Path is not a valid file' };
    }
    if (stats.size > 10 * 1024 * 1024) {
      return { error: 'Image file exceeds 10MB limit' };
    }
  } catch (e) {
    return { error: `Cannot access file: ${image_path}` };
  }

  const ext = path.extname(image_path).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  if (!imageExts.includes(ext)) {
    return { error: `Unsupported format: ${ext}` };
  }

  const config = getConfig();
  const videoConfig = config.videoGeneration || {};
  const provider = videoConfig.provider || 'doubao';
  const providerInfo = VIDEO_GEN_PROVIDERS[provider];

  if (!providerInfo?.supportsImageToVideo) {
    return {
      error: `${providerInfo?.name || provider} does not support image-to-video`,
      suggestion: 'Use Seedance provider with a valid API Key'
    };
  }

  const task = createVideoGenTask(prompt || 'Image to video', { duration, aspect_ratio, resolution, image_path });
  task.status = 'running';

  try {
    const imageBuffer = await fs.readFile(image_path);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = ext === '.png' ? 'image/png' :
                      ext === '.gif' ? 'image/gif' :
                      ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const inputImage = `data:${mimeType};base64,${base64Image}`;

    console.log(`Starting image-to-video with ${providerInfo.name}...`);

    const generator = getVideoGenerator({ config });
    const result = await generator.generate(prompt || 'Generate video from image', {
      duration,
      aspectRatio: aspect_ratio,
      resolution,
      inputImage
    });

    if (!result.success) {
      failVideoTask(task.id, result.error || 'Generation failed');
      return { error: result.error || 'Generation failed' };
    }

    const videos = result.videos || [];
    const previewUrl = videos.length > 0 && videos[0].filePath
      ? getVideoUrl(videos[0].filePath)
      : null;

    let contentText = 'Video generated from image\n\n';
    contentText += `**Source**: ${image_path}\n`;
    if (prompt) contentText += `**Prompt**: ${prompt}\n`;
    contentText += `**Duration**: ${duration}s\n`;
    contentText += `**Aspect**: ${aspect_ratio}\n`;
    contentText += `**Provider**: ${result.provider}\n\n`;

    if (previewUrl) {
      contentText += `### Video Preview\n\n[video](${previewUrl})\n\n`;
    }

    const response = {
      success: true,
      content: contentText,
      source_image: image_path,
      prompt,
      provider: result.provider,
      model: result.model,
      duration,
      aspect_ratio,
      videos: videos.map(v => ({
        file_path: v.filePath,
        file_name: v.fileName,
        duration: v.duration,
        aspect_ratio: v.aspectRatio,
        local_url: v.filePath ? getVideoUrl(v.filePath) : null
      })),
      total_videos: videos.length,
      preview: previewUrl ? `[video](${previewUrl})` : null,
      video_path: videos.length > 0 ? videos[0].filePath : null,
      message: `Generated ${videos.length} video(s)`
    };

    completeVideoTask(task.id, response);
    return response;
  } catch (e) {
    const safeMsg = redactText(e.message) || 'Unknown error';
    failVideoTask(task.id, safeMsg);
    return { error: `Generation error: ${safeMsg}` };
  }
}

// eslint-disable-next-line no-unused-vars
async function handleVideoProvidersList(_params, context) {
  const config = getConfig();
  const videoConfig = config.videoGeneration || {};

  const providers = Object.entries(VIDEO_GEN_PROVIDERS).map(([id, info]) => {
    const apiKey = videoConfig.providers?.[id]?.apiKey ||
                    config.models?.providers?.[id]?.apiKey;
    const isConfigured = !!apiKey;
    return {
      id,
      name: info.name,
      model: info.model,
      max_duration: info.maxDuration,
      supports_text_to_video: info.supportsTextToVideo,
      supports_image_to_video: info.supportsImageToVideo,
      configured: isConfigured
    };
  });

  return {
    success: true,
    current_provider: videoConfig.provider || 'doubao',
    current_model: videoConfig.model || 'doubao-seedance-1-5-pro-251215',
    providers,
    supported_aspect_ratios: Array.from(VALID_ASPECT_RATIOS),
    supported_resolutions: Array.from(VALID_RESOLUTIONS)
  };
}

// eslint-disable-next-line no-unused-vars
async function handleVideoStats(_params, context) {
  const config = getConfig();
  const generator = getVideoGenerator({ config });
  const stats = generator.getStats();

  return {
    success: true,
    stats,
    total_tasks: VIDEO_GEN_TASKS.size,
    message: 'Video generation statistics'
  };
}

registry.register({
  name: 'VideoGenerate',
  toolset: 'media',
  description: 'Generate videos from text prompts using Seedance and other AI video models',
  schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description for video generation'
      },
      duration: {
        type: 'number',
        description: 'Video duration in seconds (1-10)',
        default: 5
      },
      aspect_ratio: {
        type: 'string',
        description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9',
        default: '16:9'
      },
      resolution: {
        type: 'string',
        description: 'Resolution: 480P, 720P, 768P, 1080P, 4K',
        default: '720P'
      },
      output_dir: {
        type: 'string',
        description: 'Custom output directory'
      }
    },
    required: ['prompt']
  },
  handler: handleVideoGenerate,
  category: 'media',
  whenNotToUse: ['无可用视频生成提供商时', '需要编辑已有视频时'],
  riskLevel: 'medium'
});

registry.register({
  name: 'VideoGenerateFromImage',
  toolset: 'media',
  description: 'Generate videos from image inputs using Seedance and other AI video models',
  schema: {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: 'Path to the input image file'
      },
      prompt: {
        type: 'string',
        description: 'Optional text prompt to guide video generation'
      },
      duration: {
        type: 'number',
        description: 'Video duration in seconds (1-10)',
        default: 5
      },
      aspect_ratio: {
        type: 'string',
        description: 'Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9',
        default: '16:9'
      },
      resolution: {
        type: 'string',
        description: 'Resolution: 480P, 720P, 768P, 1080P, 4K',
        default: '720P'
      }
    },
    required: ['image_path']
  },
  handler: handleVideoGenerateFromImage,
  category: 'media',
  whenNotToUse: ['无可用视频生成提供商时'],
  riskLevel: 'medium'
});

registry.register({
  name: 'VideoProvidersList',
  description: 'List available video generation providers and their status',
  schema: {
    type: 'object',
    properties: {}
  },
  handler: handleVideoProvidersList,
  category: 'media',
  whenNotToUse: ['需要生成视频时'],
  riskLevel: 'low'
});

registry.register({
  name: 'VideoStats',
  description: 'Get video generation statistics and task status',
  schema: {
    type: 'object',
    properties: {}
  },
  handler: handleVideoStats,
  category: 'media',
  whenNotToUse: ['需要生成视频时'],
  riskLevel: 'low'
});

// ============================================================
// VideoEdit — 视频编辑与处理（截图/裁剪/转换/信息，可选 ffmpeg）
// ============================================================

let _ffmpegPathCache; // undefined=未探测, null=不可用, string=可用路径

/**
 * ffmpeg 解析: 便携优先(打包版 resources/portable/ffmpeg/bin, dev=<repo>/portable/ffmpeg/bin,
 * 2026-09-08 全内置发行) → 系统 PATH。结果缓存避免重复 spawnSync 探测。
 */
function _getFfmpeg() {
  if (_ffmpegPathCache !== undefined) return _ffmpegPathCache;
  try {
    const { spawnSync } = require('child_process');
    const { getPortableFfmpegPath } = require('../core/portable-deps');
    const candidates = [getPortableFfmpegPath(), 'ffmpeg'].filter(Boolean);
    for (const candidate of candidates) {
      const result = spawnSync(candidate, ['-version'], { stdio: 'pipe', timeout: 5000, windowsHide: true });
      if (result.status === 0) {
        _ffmpegPathCache = candidate;
        return _ffmpegPathCache;
      }
    }
    console.warn('[video-tools] ffmpeg not found (portable + PATH)');
    _ffmpegPathCache = null;
    return _ffmpegPathCache;
  } catch (_) {
    console.warn('[video-tools] ffmpeg not found');
    _ffmpegPathCache = null;
    return _ffmpegPathCache;
  }
}

async function _execFfmpeg(args, timeout = 60000) {
  const { spawn } = require('child_process');
  const ffmpegExe = _getFfmpeg();
  if (!ffmpegExe) {
    throw new Error('ffmpeg 未安装');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const errChunks = [];
    let totalSize = 0;
    const maxBuffer = 50 * 1024 * 1024;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeout);
    child.stdout.on('data', (d) => {
      totalSize += d.length;
      if (totalSize <= maxBuffer) chunks.push(d);
    });
    child.stderr.on('data', (d) => {
      totalSize += d.length;
      if (totalSize <= maxBuffer) errChunks.push(d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('ffmpeg timeout after ' + timeout + 'ms'));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const errText = Buffer.concat(errChunks).toString('utf-8').slice(0, 500);
        reject(new Error('ffmpeg exited with code ' + code + ': ' + errText));
      }
    });
  });
}

async function handleVideoEdit(params) {
  const {
    input_path, output_path,
    screenshot,     // { time: '00:00:01', width, height } — capture frame
    trim,            // { start: '00:00:01', duration: 5 } — cut segment
    format,          // mp4/webm/gif/mov/avi — convert
    fps,             // frame rate conversion
    resize,          // { width, height }
    rotate,          // 90/180/270
    mute,            // remove audio
    info,            // return video metadata
  } = params;

  if (!input_path || !fsSync.existsSync(input_path)) {
    return { success: false, error: `文件不存在: ${input_path || '(empty)'}` };
  }

  const ffmpeg = _getFfmpeg();
  const useFfmpeg = ffmpeg !== null;

  // --- info only (no ffmpeg needed — use ffprobe or basic stat) ---
  if (info && !screenshot && !trim && !format && !fps && !resize && !rotate && !mute) {
    const stats = fsSync.statSync(input_path);
    const ext = path.extname(input_path).toLowerCase();
    let meta = { path: input_path, size: stats.size, sizeMB: (stats.size / 1024 / 1024).toFixed(1), format: ext };

    if (ffmpeg) {
      try {
        const probeOut = await _execFfmpeg(['-i', input_path, '-f', 'null', '-'], 10000);
        const probeStr = probeOut.toString('utf-8');
        const durMatch = probeStr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (durMatch) meta.duration = `${durMatch[1]}:${durMatch[2]}:${durMatch[3]}`;
        const resMatch = probeStr.match(/(\d{3,4})x(\d{3,4})/);
        if (resMatch) { meta.width = parseInt(resMatch[1]); meta.height = parseInt(resMatch[2]); }
        const fpsMatch = probeStr.match(/([\d.]+)\s*fps/);
        if (fpsMatch) meta.fps = parseFloat(fpsMatch[1]);
      } catch (_) { console.warn('[video-tools] ffprobe probe failed, returning basic info only'); }
    } else {
      meta.note = 'ffmpeg 未安装，仅返回文件基本信息。安装 ffmpeg 以获取完整元数据。';
    }

    return { success: true, metadata: meta, message: '视频信息' };
  }

  // --- operations requiring ffmpeg ---
  if (!useFfmpeg) {
    return {
      success: false,
      error: 'ffmpeg 不可用。视频编辑需要 ffmpeg（便携版已内置，随包发行）。',
      hint: '便携版: resources/portable/ffmpeg/bin/ffmpeg.exe; 开发版: portable/ffmpeg/bin/ 或系统 PATH。均缺失时重新运行 npm run download:deps'
    };
  }

  const outPath = output_path || input_path.replace(/\.\w+$/, `_edited${format ? '.' + format.replace(/^\./, '') : path.extname(input_path)}`);
  // 2026-08-28 M1: 输出路径过权限门（PLAN 只读/系统保护路径拦截）
  if (!canWriteGeneratorOutput(outPath)) {
    throw new Error(`安全限制：不允许写入该输出路径（PLAN 只读模式或系统保护路径）: ${outPath}`);
  }

  try {
    const args = ['-i', input_path, '-y'];

    // --- screenshot ---
    if (screenshot) {
      const time = screenshot.time || '00:00:01';
      const vfParts = [];
      if (screenshot.width || screenshot.height) {
        vfParts.push(`scale=${screenshot.width || -1}:${screenshot.height || -1}`);
      }
      const ssArgs = ['-ss', time, '-i', input_path, '-vframes', '1'];
      if (vfParts.length > 0) ssArgs.push('-vf', vfParts.join(','));
      ssArgs.push('-y', outPath);
      await _execFfmpeg(ssArgs);
      const ssStats = fsSync.statSync(outPath);
      return { success: true, path: outPath, size: ssStats.size, type: 'screenshot', message: `截图已保存 (${(ssStats.size/1024).toFixed(1)} KB)` };
    }

    // --- trim ---
    if (trim) {
      if (trim.start) args.unshift('-ss', trim.start);
      if (trim.duration) args.push('-t', String(trim.duration));
    }

    // --- format / fps / resize ---
    if (fps) args.push('-r', String(fps));
    if (resize) args.push('-vf', `scale=${resize.width || -1}:${resize.height || -1}`);
    if (mute) args.push('-an');

    // --- rotate (metadata only, fast) ---
    if (rotate) {
      const rotateMap = { 90: 1, 180: 2, 270: 3 };
      const rotVal = rotateMap[rotate] || 0;
      if (rotVal > 0) args.push('-metadata:s:v', `rotate=${rotVal * 90}`);
    }

    args.push(outPath);
    console.log(`[VideoEdit] ffmpeg ${args.slice(0, 5).join(' ')}...`);
    await _execFfmpeg(args);

    const outStats = fsSync.statSync(outPath);
    return {
      success: true,
      path: outPath,
      size: outStats.size,
      sizeMB: (outStats.size / 1024 / 1024).toFixed(1),
      message: `视频已处理 (${(outStats.size / 1024 / 1024).toFixed(1)} MB)`,
    };
  } catch (e) {
    console.error('VideoEdit 失败:', e.message);
    return { success: false, error: '视频编辑失败: ' + e.message };
  }
}

registry.register({
  name: 'VideoEdit',
  toolset: 'media',
  category: 'media',
  description: 'Edit and process video files — capture screenshots, trim/cut segments, convert format, resize, rotate, mute, get metadata. Requires ffmpeg for editing operations (metadata works without).',
  schema: {
    type: 'object',
    properties: {
      input_path: { type: 'string', description: 'Path to input video file' },
      output_path: { type: 'string', description: 'Output path (auto-generated if omitted)' },
      screenshot: { type: 'object', description: '{ time: "00:00:01", width, height } — Capture a frame as image' },
      trim: { type: 'object', description: '{ start: "00:00:05", duration: 10 } — Cut video segment' },
      format: { type: 'string', enum: ['mp4', 'webm', 'gif', 'mov', 'avi', 'mkv'], description: 'Convert to format' },
      fps: { type: 'number', description: 'Change frame rate (e.g. 30, 24, 60)' },
      resize: { type: 'object', description: '{ width, height } — Resize video resolution' },
      rotate: { type: 'number', enum: [90, 180, 270], description: 'Rotate video (metadata, fast)' },
      mute: { type: 'boolean', description: 'Remove audio track' },
      info: { type: 'boolean', description: 'Return video metadata (works without ffmpeg)' },
    },
    required: ['input_path'],
  },
  handler: handleVideoEdit,
  timeout: 120000,
  isReadOnly: false,
  whenNotToUse: ['需要生成全新视频时', 'ffmpeg 不可用且需要编辑操作时'],
  riskLevel: 'medium',
});

module.exports = {
  handleVideoGenerate,
  handleVideoGenerateFromImage,
  handleVideoProvidersList,
  handleVideoStats,
  handleVideoEdit,
  VIDEO_GEN_TASKS,
  stopTaskCleanup
};
