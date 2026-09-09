const { registry } = require('./registry');

async function getLyrics(songId) {
  try {
    const url = 'https://music.163.com/api/song/lyric?id=' + songId + '&lv=-1&kv=-1&tv=-1';
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com' },
      signal: AbortSignal.timeout(5000)
    });
    const data = await resp.json();
    if (data.lrc && data.lrc.lyric) {
      return data.lrc.lyric;
    }
  } catch (e) {
    console.warn('[Music] 获取歌词失败:', e.message);
  }
  return null;
}

async function handleMusicSearch(params, _context) {
  const rawQuery = params.query || params.keyword || params.song;
  // 无查询词或查询词过短时用"热门歌曲"兜底，让面板能正常打开
  const query = (rawQuery && rawQuery.length >= 2) ? rawQuery : '热门歌曲';

  try {
    const url = 'https://music.163.com/api/search/get?s=' + encodeURIComponent(query) + '&limit=10&type=1';
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com' },
      signal: AbortSignal.timeout(8000)
    });
    const data = await resp.json();
    const songs = (data.result && data.result.songs) || [];

    if (songs.length === 0) {
      // 2026-08-03 修复: 搜索无结果是正常业务结果，不是工具技术失败——
      // 此前 success:false 计入熔断器失败计数（3 次即熔断），用户"播放音乐"
      // 无歌名时反复触发 → Music 熔断锁死 → "一直说熔断"。
      // 改为 success:true + 空列表：前端显示空态，不触发熔断。
      return {
        success: true,
        data: { query, tracks: [], source: 'search', empty: true },
        message: `未找到与 "${query}" 相关的歌曲，请提供更具体的歌曲名或歌手名。`
      };
    }
    
    const tracks = songs.slice(0, 5).map(s => {
      const artists = s.artists || [];
      return {
        id: String(s.id),
        title: s.name,
        artist: artists.map(a => a.name).join(', '),
        // 2026-08-03: 补播放 URL（对齐 /api/search/music 接口）——此前 tracks 无 url，
        // 前端点播放无源（播放条件 current?.url 不满足）→ "无法播放歌曲"
        url: '/api/proxy-audio?id=' + s.id
      };
    });
    
    const trackList = tracks.map((t, i) => `${i + 1}. ${t.title} - ${t.artist}`).join('\n');

    // Scene surface 是数据主路径
    try {
      const { getSceneStore } = require('../core/scene/scene-store');
      const { setPanelState } = require('../core/panel-state');
      setPanelState('music', 'open');
      getSceneStore().upsertSurface('music-player', {
        kind: 'music',
        // R13: 补 title——前端 music 守卫要求 data.title 是 string,旧数据缺 title
        // → SceneShell 报"数据不完整,无法渲染 music 卡片"。用 query 兜底。
        data: { query, tracks, source: 'search', title: query || '音乐搜索' },
        intent: 'inform',
      });
    } catch (e) {
      console.warn('[Music] 推送 Scene surface 失败:', e.message);
    }
    
    return {
      success: true,
      content: `🎵 搜索到 "${query}" 的歌曲：\n\n${trackList}\n\n音乐播放器已打开，点击即可播放。`
    };
  } catch (e) {
    return {
      success: false,
      error: `搜索音乐失败: ${e.message}。请直接告诉用户无法搜索音乐，不要重试。`
    };
  }
}

async function handlePlayMusic(params, _context) {
  const { id, title, artist, url } = params;

  // 2026-08-06: 支持 query(歌名)——模型常传 { action:'play', query:'铁血丹心' }
  // 而非 id/url。有 query 无 id/url 时先搜索取第一首播放。
  if (!id && !url && params.query) {
    const searchRes = await handleMusicSearch({ query: params.query, keyword: params.query, song: params.query }, _context);
    const first = searchRes?.data?.tracks?.[0]
    if (first && first.id) {
      const found = { id: first.id, title: first.title, artist: first.artist, url: first.url }
      return handlePlayMusic({ id: found.id, title: found.title, artist: found.artist, url: found.url }, _context)
    }
    return {
      success: false,
      error: `未找到歌曲"${params.query}"，请提供更具体的歌名。`
    };
  }

  if (!id && !url) {
    return {
      success: false,
      error: '请提供歌曲 ID 或播放 URL。'
    };
  }

  try {
    let playUrl = url;
    let lrc = null;
    let cover = null;
    
    if (id && !url) {
      // 2026-08-15: 改为相对 proxy-audio 端点——此前直出网易云 outer url 绝对外链,
      // FMP 对 http(s) URL 短路跳过主进程代理,渲染进程直连 → 网易云 302 到 404 页,
      // 每首歌必"无法播放"。proxy-audio 走主进程代理且有 player/url API 兜底。
      playUrl = `/api/proxy-audio?id=${id}`;
      lrc = await getLyrics(id);
    }

    // Scene surface 是数据主路径 — 补充 tracks 数组供前端自动打开面板
    try {
      const { getSceneStore } = require('../core/scene/scene-store');
      const { setPanelState } = require('../core/panel-state');
      setPanelState('music', 'open');
      // R13: title 兜底——params.title 可能为空,前端守卫要求 title 是 string
      const safeTitle = title || artist || '正在播放'
      const trackEntry = { id, title: safeTitle, artist, url: playUrl, lrc, cover };
      getSceneStore().upsertSurface('music-player', {
        kind: 'music',
        data: {
          id, title: safeTitle, artist, url: playUrl, lrc, cover,
          autoplay: true, status: 'playing', source: 'play',
          tracks: [trackEntry],
        },
        intent: 'inform',
      });
    } catch (e) {
      console.warn('[Music] 推送 Scene surface 失败:', e.message);
    }
    
    console.log('[Music] 已通过 Scene surface 推送歌曲:', title, playUrl);
    
    return {
      success: true,
      content: `🎵 正在播放: ${title || '音乐'}`
    };
  } catch (e) {
    return {
      success: false,
      error: `播放音乐失败: ${e.message}`
    };
  }
}

async function handleMusicControl(params, _context) {
  const { action, volume, currentTime } = params;
  
  if (!['play', 'pause', 'next', 'prev', 'stop', 'set_volume', 'seek'].includes(action)) {
    return {
      success: false,
      error: '不支持的操作: ' + action + '。支持的操作: play, pause, next, prev, stop, set_volume, seek'
    };
  }

  try {
    // 面板状态同步
    const { setPanelState } = require('../core/panel-state');
    if (action === 'stop') {
      setPanelState('music', 'closed');
    }

    // Scene surface 是数据主路径
    try {
      const { getSceneStore } = require('../core/scene/scene-store');
      const data = { status: action, source: 'control' };
      if (action === 'set_volume' && typeof volume === 'number') data.volume = Math.max(0, Math.min(1, volume));
      if (action === 'seek' && typeof currentTime === 'number') data.currentTime = currentTime;
      getSceneStore().upsertSurface('music-player', {
        kind: 'music',
        data,
        intent: 'inform',
      });
    } catch (e) {
      console.warn('[Music] 推送 Scene surface 失败:', e.message);
    }
    
    return {
      success: true,
      content: `🎵 音乐控制: ${action}`
    };
  } catch (e) {
    return {
      success: false,
      error: `音乐控制失败: ${e.message}`
    };
  }
}

registry.register({
  name: 'MusicSearch',
  toolset: 'web',
  category: 'entertainment',
  description: '搜索并播放音乐。调用时必须使用 "query" 参数传入搜索关键词（歌曲名、歌手名等），例如: {"query": "周杰伦"}。搜索后会自动打开音乐播放器。',
  schema: {
    description: '搜索并播放音乐',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，必须使用 "query" 作为参数名，如：周杰伦、晴天、夜曲'
        }
      },
      required: ['query']
    }
  },
  handler: handleMusicSearch,
  checkFn: (params) => !!(params.query || params.keyword || params.song),
  timeout: 15000,
  isReadOnly: true,
  isDangerous: false
});

registry.register({
  name: 'PlayMusic',
  toolset: 'media',
  category: 'entertainment',
  description: '播放指定歌曲。可以通过歌曲ID或直接提供播放URL。如果提供ID，会自动获取歌词。',
  schema: {
    description: '播放音乐',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '网易云音乐歌曲ID，如：12345678'
        },
        title: {
          type: 'string',
          description: '歌曲名称'
        },
        artist: {
          type: 'string',
          description: '歌手名称'
        },
        url: {
          type: 'string',
          description: '音频文件的直接URL（优先使用）'
        }
      },
      required: ['id'],
      anyOf: [
        { required: ['id'] },
        { required: ['url'] }
      ]
    }
  },
  handler: handlePlayMusic,
  timeout: 10000,
  isReadOnly: true,
  isDangerous: false
});

registry.register({
  name: 'MusicControl',
  toolset: 'media',
  category: 'entertainment',
  description: '控制音乐播放器。支持播放、暂停、下一首、上一首、停止、调整音量、跳转进度。',
  schema: {
    description: '音乐控制',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'prev', 'stop', 'set_volume', 'seek'],
          description: '控制操作'
        },
        volume: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '音量（0-1），仅在 action=set_volume 时使用'
        },
        currentTime: {
          type: 'number',
          minimum: 0,
          description: '跳转时间（秒），仅在 action=seek 时使用'
        }
      },
      required: ['action']
    }
  },
  handler: handleMusicControl,
  timeout: 5000,
  isReadOnly: true,
  isDangerous: false
});

/**
 * 统一 Music 工具（借鉴历史实现的 action-based 设计）
 *
 * 用一个工具替代三个分散的 MusicSearch/PlayMusic/MusicControl，
 * 通过 action 参数区分不同操作。降低 AI 的认知负担，减少工具选择错误。
 *
 * action 选项:
 *   search    — 搜索歌曲，传入 query
 *   play      — 播放指定歌曲，传入 id 或 url + title
 *   stop      — 停止播放并关闭音乐面板
 *   pause     — 暂停/恢复播放
 *   next      — 下一首
 *   prev      — 上一首
 *   set_volume — 设置音量 (0-1)
 *   seek      — 跳转到指定时间 (秒)
 */
async function handleUnifiedMusic(params, context) {
  const { action, query, id, title, artist, url, volume, currentTime } = params;

  if (!action || typeof action !== 'string') {
    return {
      success: false,
      error: 'action 参数必填。可用操作: search, play, stop, pause, next, prev, set_volume, seek。例如: { action: "search", query: "周杰伦" }'
    };
  }

  switch (action) {
    case 'search':
      return handleMusicSearch({ query, keyword: query, song: query }, context);
    case 'play':
      return handlePlayMusic({ id, title, artist, url }, context);
    case 'stop':
    case 'pause':
    case 'next':
    case 'prev':
    case 'set_volume':
    case 'seek':
      return handleMusicControl({ action, volume, currentTime }, context);
    default:
      return {
        success: false,
        error: `不支持的 action: "${action}"。可用操作: search, play, stop, pause, next, prev, set_volume, seek`
      };
  }
}

registry.register({
  name: 'Music',
  toolset: 'media',
  category: 'entertainment',
  description: '统一的音乐操作工具。通过 action 参数区分操作：search 搜索歌曲、play 播放指定歌曲、stop 停止并关闭面板、pause 暂停/恢复、next 下一首、prev 上一首、set_volume 调节音量、seek 跳转进度。替代 MusicSearch/PlayMusic/MusicControl 三个独立工具。',
  schema: {
    description: '音乐搜索与播放控制',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'play', 'stop', 'pause', 'next', 'prev', 'set_volume', 'seek'],
          description: '操作类型: search=搜索歌曲(需query), play=播放(需id/url+title), stop=关闭面板, pause=暂停/恢复, next=下一首, prev=上一首, set_volume=调音量, seek=跳转进度'
        },
        query: {
          type: 'string',
          description: '搜索关键词（action=search 时必填）'
        },
        id: {
          type: 'string',
          description: '歌曲 ID（action=play 时必填，传入后自动获取歌词）'
        },
        title: {
          type: 'string',
          description: '歌曲名称'
        },
        artist: {
          type: 'string',
          description: '歌手名称'
        },
        url: {
          type: 'string',
          description: '音频文件直链（action=play，有 id 时可省略）'
        },
        volume: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '音量 0-1（action=set_volume 时使用）'
        },
        currentTime: {
          type: 'number',
          minimum: 0,
          description: '跳转时间（秒），action=seek 时使用'
        }
      },
      required: ['action']
    }
  },
  handler: handleUnifiedMusic,
  checkFn: (params) => !!params.action,
  timeout: 15000,
  isReadOnly: true,
  isDangerous: false
});

console.log('✅ 音乐工具已注册');