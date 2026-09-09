const { registry } = require('./registry');

async function handleMediaStage(params, _context) {
  const { mode, action = 'show', url, src, title, artist, lrc, cover, alt, autoplay, muted, volume, currentTime, camera } = params;

  if (!mode || !['video', 'camera', 'image', 'music'].includes(mode)) {
    return {
      success: false,
      error: 'mode must be video, camera, image, or music'
    };
  }

  if (!['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'].includes(action)) {
    return {
      success: false,
      error: 'unsupported action'
    };
  }

  // ── bvid 直链解析（可选）────────────────────────────
  // 传入 B站视频 BV 号时，自动解析视频直链作为播放源，并把视频标题写入展示字段。
  let bvidPlayUrl = '';
  let bvidTitle = '';
  if (params.bvid) {
    try {
      const { getBilibiliPlayUrl } = require('./bilibili-tools');
      const video = await getBilibiliPlayUrl(String(params.bvid).trim());
      if (video && video.playUrl) {
        bvidPlayUrl = video.playUrl;
        bvidTitle = video.title || '';
        console.log(`🎬 [MediaStage] bvid 直链解析成功: ${params.bvid}（${video.quality}）`);
      } else {
        console.warn(`[MediaStage] bvid 直链解析失败: ${params.bvid}（可能需登录），使用原始参数`);
      }
    } catch (err) {
      console.warn(`[MediaStage] bvid 解析异常: ${err.message}`);
    }
  }

  const payload = {
    mode,
    action,
    url: bvidPlayUrl || (typeof url === 'string' ? url : undefined),
    src: typeof src === 'string' ? src : undefined,
    title: bvidTitle || (typeof title === 'string' ? title : undefined),
    artist: typeof artist === 'string' ? artist : undefined,
    lrc: typeof lrc === 'string' ? lrc : undefined,
    cover: typeof cover === 'string' ? cover : undefined,
    alt: typeof alt === 'string' ? alt : undefined,
    autoplay: typeof autoplay === 'boolean' ? autoplay : (mode === 'music' ? true : undefined),
    muted: typeof muted === 'boolean' ? muted : undefined,
    camera: mode === 'camera' || camera === true,
  };

  if (Number.isFinite(Number(volume))) {
    payload.volume = Math.max(0, Math.min(1, Number(volume)));
  }
  if (Number.isFinite(Number(currentTime))) {
    payload.currentTime = Math.max(0, Number(currentTime));
  }

  const { sseBroadcastEvent } = require('../core/sse-broadcast');
  try {
    // 构建广播数据，传递完整的 action 和控制参数
    const broadcastData = {
      action: action,  // 传递原始 action，不再映射
      mode: mode,
    };

    // 对于 close/hide，清空 items
    if (action === 'close' || action === 'hide') {
      broadcastData.items = [];
    } else {
      // 对于 show 和其他控制指令，构建 items
      broadcastData.items = [{
        id: `media_${Date.now()}`,
        type: mode,
        title: payload.title,
        url: mode === 'music' ? payload.src : payload.url,
        thumbnail: payload.cover,
        source: payload.alt,
        artist: payload.artist,
        cover: payload.cover,
        lrc: payload.lrc,
        autoplay: payload.autoplay,
        muted: payload.muted,
      }];
    }

    // 传递控制参数
    if (Number.isFinite(payload.volume)) {
      broadcastData.volume = payload.volume;
    }
    if (Number.isFinite(payload.currentTime)) {
      broadcastData.currentTime = payload.currentTime;
    }

    sseBroadcastEvent('media_stage', broadcastData);
    console.log('🎬 [MediaStage] 已广播媒体舞台事件:', mode, action);
  } catch (e) {
    console.warn('[MediaStage] 广播事件失败:', e.message);
    return {
      success: false,
      error: '无法广播媒体舞台事件'
    };
  }

  const typeLabels = { video: '视频', camera: '摄像头', image: '图片', music: '音乐' };
  const actionLabels = { show: '展示', hide: '隐藏', close: '关闭', play: '播放', pause: '暂停', seek: '跳转', set_volume: '调整音量', update: '更新' };

  return {
    success: true,
    message: `${typeLabels[mode]}${actionLabels[action]}成功`
  };
}

registry.register({
  name: 'MediaStage',
  toolset: 'media',
  category: 'media',
  description: 'Control the media stage panel. Image opens from the left, video opens from the right, and music opens a record-player card from the right.',
  schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['video', 'camera', 'image', 'music'],
        description: 'video=right-side video mode; camera=right-side camera video; image=left-side image mode; music=right-side record-player mode.'
      },
      action: {
        type: 'string',
        enum: ['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'],
        default: 'show',
        description: 'show loads media; hide/close closes and destroys it; play/pause controls playback; seek jumps; set_volume adjusts volume.'
      },
      url: {
        type: 'string',
        description: 'Media URL for video/image. Must be a complete accessible URL.'
      },
      src: {
        type: 'string',
        description: 'Audio file path for music mode. Use file:///absolute/path for local files or an HTTP direct audio link.'
      },
      title: {
        type: 'string',
        description: 'Optional media title.'
      },
      artist: {
        type: 'string',
        description: 'Optional artist name for music mode.'
      },
      lrc: {
        type: 'string',
        description: 'Optional LRC-format lyrics for music mode.'
      },
      cover: {
        type: 'string',
        description: 'Optional cover image path or URL for music mode.'
      },
      alt: {
        type: 'string',
        description: 'Optional image alt description.'
      },
      autoplay: {
        type: 'boolean',
        description: 'Autoplay, default true for music.'
      },
      muted: {
        type: 'boolean',
        description: 'Mute video, default false.'
      },
      volume: {
        type: 'number',
        description: 'Volume 0-1.'
      },
      currentTime: {
        type: 'number',
        description: 'Seconds to seek to.'
      },
      camera: {
        type: 'boolean',
        description: 'Explicitly open camera when mode=video; default false.'
      },
      bvid: {
        type: 'string',
        description: 'B站视频 BV 号。提供后自动解析视频直链作为播放源，并写入视频标题。'
      },
    },
    required: ['mode'],
    additionalProperties: false
  },
  handler: handleMediaStage,
  timeout: 25000,
  isReadOnly: true,
  isDangerous: false
});

console.log('✅ 媒体舞台工具已注册');