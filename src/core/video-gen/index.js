const { EventEmitter } = require('events');
const { getProviderRegistry } = require('../llm');
const fs = require('fs');
const path = require('path');
const { DATA_DIR, loadConfig } = require('../config');

class VideoGenerator extends EventEmitter {
  constructor(config = {}) {
    super();
    this._registry = config.registry || getProviderRegistry();
    this._config = config.config || loadConfig();
    this._stats = { total: 0, success: 0, failed: 0, lastGenerated: null };
  }

  // 视频生成先查 videoGeneration 配置，不是聊天模型
  _getVideoProviderConfig(providerName) {
    const vg = this._config.videoGeneration?.providers || {};
    if (vg[providerName]?.apiKey) return vg[providerName];
    return this._registry.getProviderConfig(providerName) || null;
  }

  async generate(prompt, options = {}) {
    const assignment = this._registry.getModelAssignment('video');
    if (!assignment.provider || !assignment.model) {
      this._stats.failed++;
      return { success: false, error: '未配置视频生成模型', videos: [] };
    }

    const adapter = this._registry.getAdapter(assignment.provider);
    const providerConfig = this._getVideoProviderConfig(assignment.provider);

    // 支持有适配器 或 直连火山引擎
    const apiKey = providerConfig?.apiKey;
    if (!apiKey && !adapter) {
      this._stats.failed++;
      return { success: false, error: `Provider ${assignment.provider} 未配置 API Key`, videos: [] };
    }

    this._stats.total++;

    try {
      let videoUrl = null;
      let taskId = null;

      if (adapter && typeof adapter.generateVideo === 'function') {
        // 走适配器
        const result = await adapter.generateVideo(prompt, options);
        videoUrl = result.url;
        taskId = result.taskId;
      } else {
        // 直连火山引擎 Seedance API
        const baseUrl = (providerConfig.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
        const url = `${baseUrl}/contents/generations/tasks`;

        const body = { model: assignment.model, content: [{ type: 'text', text: prompt }] };
        const params = {};
        if (options.duration) params.duration = options.duration;
        if (options.resolution) params.resolution = options.resolution;
        if (options.aspect_ratio) params.aspect_ratio = options.aspect_ratio;
        if (Object.keys(params).length > 0) body.parameters = params;

        console.log(`[VideoGen] 请求: provider=${assignment.provider}, model=${assignment.model}`);
        console.log(`[VideoGen] 提示词: ${prompt.substring(0, 80)}...`);

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: options.signal || AbortSignal.timeout(300000),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`Video API ${resp.status}: ${errText.substring(0, 200)}`);
        }

        const data = await resp.json();
        taskId = data.id || data.task_id;

        if (data.content?.video_url) {
          videoUrl = data.content.video_url;
        } else if (data.video_url) {
          videoUrl = data.video_url;
        } else if (taskId) {
          console.log(`[VideoGen] 异步任务 ${taskId}, 开始轮询...`);
          videoUrl = await this._pollTask(baseUrl, taskId, apiKey);
        }
      }

      if (!videoUrl) {
        this._stats.failed++;
        return { success: false, error: '视频生成超时或失败', videos: [] };
      }

      // 下载视频到本地
      const outputDir = options.output_dir
        || path.join(DATA_DIR || require('os').homedir(), '.crabpaw', 'generated-videos');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      const ext = '.mp4';
      const fileName = `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(outputDir, fileName);

      try {
        console.log(`[VideoGen] 下载视频: ${videoUrl.substring(0, 80)}...`);
        const dlResp = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
        if (dlResp.ok) {
          const buffer = Buffer.from(await dlResp.arrayBuffer());
          fs.writeFileSync(filePath, buffer);
          console.log(`[VideoGen] 已保存: ${filePath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        } else {
          // 下载失败时仍然返回 URL
          console.warn(`[VideoGen] 下载失败, 仅返回URL`);
        }
      } catch (dlErr) {
        console.warn(`[VideoGen] 下载异常: ${dlErr.message}, 仅返回URL`);
      }

      const fileExists = fs.existsSync(filePath);
      const fileSize = fileExists ? fs.statSync(filePath).size : 0;

      this._stats.success++;
      this._stats.lastGenerated = Date.now();

      this.emit('video_generated', {
        provider: assignment.provider,
        model: assignment.model,
        promptLength: prompt.length,
        filePath: fileExists ? filePath : null,
        fileSize,
        timestamp: Date.now(),
      });

      return {
        success: true,
        videos: [{
          url: videoUrl,
          filePath: fileExists ? filePath : null,
          fileName: fileExists ? fileName : null,
          size: fileSize,
          taskId,
          duration: options.duration,
          aspectRatio: options.aspect_ratio,
        }],
        provider: assignment.provider,
        model: assignment.model,
      };
    } catch (e) {
      console.error(`[VideoGen] 失败:`, e.message);
      this._stats.failed++;
      return { success: false, error: e.message, videos: [] };
    }
  }

  async generateFromImage(imagePath, prompt, options = {}) {
    // 图片转视频：将图片作为 content 传入
    if (!fs.existsSync(imagePath)) {
      this._stats.failed++;
      return { success: false, error: `图片文件不存在: ${imagePath}`, videos: [] };
    }
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const fullPrompt = prompt
      ? `${prompt}\n\n(Base image provided)`
      : 'Generate a video animation from this image';

    // 构建包含图片的 content
    const assignment = this._registry.getModelAssignment('video');
    const providerConfig = this._getVideoProviderConfig(assignment.provider);
    const apiKey = providerConfig?.apiKey;

    if (!apiKey) {
      this._stats.failed++;
      return { success: false, error: `未配置 API Key`, videos: [] };
    }

    this._stats.total++;
    try {
      const baseUrl = (providerConfig.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
      const url = `${baseUrl}/contents/generations/tasks`;

      const body = {
        model: assignment.model,
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          { type: 'text', text: fullPrompt },
        ],
      };
      const params = {};
      if (options.duration) params.duration = options.duration;
      if (options.resolution) params.resolution = options.resolution;
      if (options.aspect_ratio) params.aspect_ratio = options.aspect_ratio;
      if (Object.keys(params).length > 0) body.parameters = params;

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal || AbortSignal.timeout(300000),
      });

      if (!resp.ok) throw new Error(`Video API ${resp.status}`);

      const data = await resp.json();
      const taskId = data.id || data.task_id;
      let videoUrl = data.content?.video_url || data.video_url;

      if (!videoUrl && taskId) {
        videoUrl = await this._pollTask(baseUrl, taskId, apiKey);
      }

      if (!videoUrl) {
        this._stats.failed++;
        return { success: false, error: '图片转视频超时或失败', videos: [] };
      }

      // 下载到本地
      const outputDir = options.output_dir
        || path.join(DATA_DIR || require('os').homedir(), '.crabpaw', 'generated-videos');
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const fileName = `img2video_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp4`;
      const filePath = path.join(outputDir, fileName);

      try {
        const dlResp = await fetch(videoUrl, { signal: AbortSignal.timeout(120000) });
        if (dlResp.ok) {
          fs.writeFileSync(filePath, Buffer.from(await dlResp.arrayBuffer()));
        }
      } catch (_) {
        /* URL only */
        console.warn('[index.js] 空 catch 补日志:', _ && _.message);
      }


      const fileExists = fs.existsSync(filePath);

      this._stats.success++;
      this._stats.lastGenerated = Date.now();

      return {
        success: true,
        videos: [{
          url: videoUrl,
          filePath: fileExists ? filePath : null,
          fileName: fileExists ? fileName : null,
          size: fileExists ? fs.statSync(filePath).size : 0,
          taskId,
        }],
        provider: assignment.provider,
        model: assignment.model,
      };
    } catch (e) {
      this._stats.failed++;
      return { success: false, error: e.message, videos: [] };
    }
  }

  getStats() {
    return {
      ...this._stats,
      activeTasks: 0,
    };
  }

  listProviders() {
    const providers = [];
    const assignment = this._registry.getModelAssignment('video');
    const config = this._getVideoProviderConfig(assignment.provider);
    providers.push({
      id: assignment.provider || 'doubao',
      name: assignment.provider || '豆包 Seedance',
      model: assignment.model || 'doubao-seedance-1.5-pro',
      configured: !!(config?.apiKey),
    });
    return providers;
  }

  async _pollTask(baseUrl, taskId, apiKey) {
    const url = `${baseUrl}/contents/generations/tasks/${taskId}`;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const resp = await fetch(url, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        if (data.status === 'succeeded' && data.content?.video_url) {
          return data.content.video_url;
        }
        if (data.status === 'failed') break;
        console.log(`[VideoGen] 轮询 ${i + 1}/60: status=${data.status}`);
      } catch (e) {
        console.warn('[video-gen] poll iteration error:', e.message);
      }
    }
    return null;
  }
}

// ── 导出的常量与工厂函数（供 video-tools.js 使用） ──
const VALID_RESOLUTIONS = new Set(['480p', '720p', '1080p', '1440p', '4k']);
const VALID_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);
const VIDEO_GEN_PROVIDERS = {
  doubao: { name: '豆包视频生成' },
  volcengine: { name: '火山引擎 Seedance' },
};

/**
 * 工厂函数：创建 VideoGenerator 实例
 * @param {{ config?: object }} opts
 * @returns {VideoGenerator}
 */
function getVideoGenerator({ config } = {}) {
  return new VideoGenerator({ config });
}

module.exports = { VideoGenerator, getVideoGenerator, VIDEO_GEN_PROVIDERS, VALID_RESOLUTIONS, VALID_ASPECT_RATIOS };
