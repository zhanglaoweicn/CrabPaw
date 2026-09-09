/**
 * Bilibili Tools — B站视频搜索与播放
 *
 * 超越 差异化功能：Agent 可以搜索并播放 B站视频。
 *
 * 工具：
 * 1. BilibiliSearch — 搜索 B站视频（标题/简介/播放量）
 * 2. BilibiliPlay — 获取视频播放地址并打开播放
 *
 * 数据源：B站公开 API（无需 Cookie，无需 API Key）
 */

const { registry } = require('./registry');

// ─── B站 API ──────────────────────────────────────────

const BILIBILI_HEADERS = {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
 'Referer': 'https://www.bilibili.com/',
};

/**
 * 搜索 B站视频
 * @param {string} keyword 搜索关键词
 * @param {number} page 页码（默认 1）
 * @param {number} pageSize 每页数量（默认 10，最大 30）
 * @returns {Promise<Array>}
 */
async function searchBilibili(keyword, page = 1, pageSize = 10) {
 const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=${Math.min(pageSize, 30)}`;
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 10000);

 try {
 const res = await fetch(url, { headers: BILIBILI_HEADERS, signal: controller.signal });
 clearTimeout(timer);
 if (!res.ok) { clearTimeout(timer); throw new Error(`HTTP ${res.status}`); }

 const data = await res.json();
 if (data.code !== 0) throw new Error(`API error: ${data.message || data.code}`);

 // 从搜索结果中提取视频信息
 const videoResults = [];
 const resultModules = data.data?.result || [];

 for (const module of resultModules) {
 // 2026-08-16 修复: B站 search/all/v2 分区字段是 result_type(实测 video 分区
 // 正常返回 20 条), 旧代码判断不存在的 module_type → 永远匹配不到 video 分区
 // → "未找到相关视频" → LLM 拿不到 bvid → 无法调 SceneMedia 应用内播放
 if ((module.result_type === 'video' || module.module_type === 'video') && Array.isArray(module.data)) {
 for (const item of module.data) {
 videoResults.push({
 bvid: item.bvid || '',
 title: item.title?.replace(/<[^>]+>/g, '') || '',
 author: item.author || '',
 play: item.play || item.play_count || 0,
 danmaku: item.video_review || item.danmaku || 0,
 duration: item.duration || '',
 pic: item.pic || '',
 description: item.description || '',
 url: `https://www.bilibili.com/video/${item.bvid || ''}`,
 });
 }
 }
 }

 return videoResults;
 } catch (err) {
 clearTimeout(timer);
 throw err;
 }
}

/**
 * 获取 B站视频播放地址
 * @param {string} bvid 视频 BV 号
 * @param {Function} fetcher 可注入的 fetch 实现（测试用）
 * @returns {Promise<{bvid: string, title: string, cover: string, author: string, desc: string, duration: number, url: string, playUrl: string|null, quality: string|null}>}
 */
async function getBilibiliPlayUrl(bvid, fetcher = fetch) {
 const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 10000);

 try {
 const res = await fetcher(url, { headers: BILIBILI_HEADERS, signal: controller.signal });
 clearTimeout(timer);
 if (!res.ok) { clearTimeout(timer); throw new Error(`HTTP ${res.status}`); }

 const data = await res.json();
 if (data.code !== 0) throw new Error(`API error: ${data.message || data.code}`);

 const vd = data.data;
 const playUrlInfo = await resolvePlayUrl(vd.bvid || bvid, vd.cid, fetcher);
 return {
 bvid: vd.bvid,
 title: vd.title || '',
 cover: vd.pic || '',
 author: vd.owner?.name || '',
 desc: vd.desc || '',
 duration: vd.duration || 0,
 url: `https://www.bilibili.com/video/${vd.bvid}`,
 playUrl: playUrlInfo ? playUrlInfo.url : null,
 quality: playUrlInfo ? playUrlInfo.quality : null,
 };
 } catch (err) {
 clearTimeout(timer);
 throw err;
 }
}

/**
 * 解析 B站视频流直链（免登录清晰度）
 * @param {string} bvid BV 号
 * @param {number|string} cid 视频 cid（来自 view 接口）
 * @param {Function} fetcher 可注入的 fetch 实现（测试用）
 * @returns {Promise<{url: string, quality: string}|null>} 直链或 null
 */
async function resolvePlayUrl(bvid, cid, fetcher = fetch) {
  for (const qn of [64, 32]) {
    const url = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=${qn}&platform=html5&high_quality=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetcher(url, { headers: BILIBILI_HEADERS, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { continue; }
      const data = await res.json();
      if (data.code !== 0) { continue; }
      const durl = data.data && data.data.durl;
      if (Array.isArray(durl) && durl.length > 0 && durl[0].url) {
        return { url: durl[0].url, quality: qn === 64 ? '480p' : '360p' };
      }
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[Bilibili] playurl qn=${qn} 解析失败: ${err.message}`);
    }
  }
  return null;
}

/**
 * 格式化时长（秒 → mm:ss）
 */
function formatDuration(seconds) {
 if (!seconds) return '';
 // 2026-08-16 修复: B站搜索接口 duration 已是 "mm:ss" 字符串, 按秒数算得 NaN:NaN
 if (typeof seconds === 'string' && /^\d{1,3}:\d{2}$/.test(seconds)) return seconds;
 const sec = Number(seconds) || 0;
 if (sec <= 0) return '';
 const m = Math.floor(sec / 60);
 const s = sec % 60;
 return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 格式化播放量
 */
function formatPlayCount(count) {
 const n = Number(count) || 0;
 if (n >= 10000) return (n / 10000).toFixed(1) + '万';
 if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
 return String(n);
}

// ─── Tool: BilibiliSearch ──────────────────────────────

async function handleBilibiliSearch(params) {
 // 2026-08-22: query 别名双兼容——deepseek-v4-flash 参数名跟随差传 {"query":...}，
 // 契约层已放行别名（tool-contract.js BilibiliSearch properties 含 query），handler
 // 此前只认 keyword → 「请提供搜索关键词」→ LLM 误判 B站 API 故障放弃（19:19 实机）。
 const keyword = String(params.keyword || params.query || params.q || '').trim();
 if (!keyword) return { ok: false, error: '请提供搜索关键词' };

 const page = Math.max(1, Number(params.page) || 1);
 const pageSize = Math.min(30, Math.max(5, Number(params.pageSize) || 10));

 console.log(`🎬 [BilibiliSearch] 搜索: ${keyword}`);
 try {
 const results = await searchBilibili(keyword, page, pageSize);

 if (results.length === 0) {
 return { ok: false, query: keyword, error: '未找到相关视频', hint: '尝试换个关键词' };
 }

 const formatted = results.slice(0, pageSize).map(v => ({
 title: v.title,
 author: v.author,
 play: formatPlayCount(v.play),
 duration: formatDuration(v.duration),
 bvid: v.bvid,
 url: v.url,
 }));

 return {
 ok: true,
 tool: 'BilibiliSearch',
 query: keyword,
 total: results.length,
 results: formatted,
 hint: `搜索到 ${results.length} 个视频。使用 SceneMedia(id="video_1", bvid="${formatted[0]?.bvid}", autoplay=true) 在应用内面板播放第一个视频。\n视频结果摘要:\n${formatted.slice(0, 5).map((v, i) => `${i + 1}. "${v.title}" by ${v.author} (${v.play}播放, ${v.duration})`).join('\n')}`,
 };
 } catch (err) {
 return { ok: false, error: `搜索失败: ${err.message}`, hint: 'B站 API 可能暂时不可用，请稍后重试' };
 }
}

registry.register({
 name: 'BilibiliSearch',
 toolset: 'web',
 category: 'media',
 description: '搜索 B站（bilibili）视频。支持中文关键词搜索，返回视频标题、作者、播放量、时长等信息。',
 schema: {
 description: '搜索 B站视频',
 parameters: {
 type: 'object',
 properties: {
 keyword: { type: 'string', description: '搜索关键词（中文）' },
 query: { type: 'string', description: '搜索关键词（兼容别名，与 keyword 等价）' },
 q: { type: 'string', description: '搜索关键词（兼容别名，与 keyword 等价）' },
 page: { type: 'number', description: '页码，默认 1' },
 pageSize: { type: 'number', description: '每页数量 5-30，默认 10' },
 },
 required: ['keyword'],
 },
 },
 handler: handleBilibiliSearch,
 timeout: 15000,
 isReadOnly: true,
});

// ─── Tool: BilibiliPlay ────────────────────────────────

async function handleBilibiliPlay(params) {
 const bvid = String(params.bvid || params.videoId || '').trim();
 if (!bvid) return { ok: false, error: '请提供视频 BV 号或 B站 URL' };

 console.log(`🎬 [BilibiliPlay] 获取视频信息: ${bvid}`);
 try {
 const video = await getBilibiliPlayUrl(bvid);

 // 2026-08-16 实机修复: 拿到直链后主动推送 media surface——
 // 此前仅返回 hint, 是否显示面板取决于 LLM 是否继续调 SceneMedia;
 // 实测 LLM 常以 tool_choice="none" 结束 → 面板收不到媒体卡,
 // 却按 system-prompt "播放类确认已播放即可" 口头回复 → "已在播放"但无窗口。
 // 此处与 SceneMedia 同格式推送, MediaStageHost 聚合 kind==='media' 自动开面板。
 if (video.playUrl) {
   try {
     const { getSceneStore } = require('../core/scene/scene-store');
     const store = getSceneStore();
     if (store && typeof store.upsertSurface === 'function') {
       const surfaceId = `media.bilibili_${bvid}`;
       store.upsertSurface(surfaceId, {
         kind: 'media',
         data: {
           items: [{
             id: surfaceId,
             type: 'video',
             title: video.title,
             url: video.playUrl,
             thumbnail: video.cover || '',
             autoplay: true,
             muted: false,
           }],
         },
         intent: 'inform',
       });
       console.log(`🎬 [BilibiliPlay] 已推送媒体面板 surface: ${surfaceId}`);
     } else {
       console.warn('[BilibiliPlay] scene-store 不可用, 跳过媒体面板推送');
     }
   } catch (e) {
     console.warn('[BilibiliPlay] 媒体 surface 推送失败:', e && e.message);
   }
 }

 return {
 ok: true,
 tool: 'BilibiliPlay',
 bvid: video.bvid,
 title: video.title,
 author: video.author,
 url: video.url,
 playUrl: video.playUrl,
 quality: video.quality,
 hint: video.playUrl
   ? `视频「${video.title}」已获取直链（${video.quality}），已自动推送到应用内播放器面板显示。无需再调用 SceneMedia。`
   : `视频「${video.title}」直链解析失败（可能需登录），用户可打开网页观看:\n${video.url}`,
 };
 } catch (err) {
 return { ok: false, error: `获取视频信息失败: ${err.message}` };
 }
}

registry.register({
 name: 'BilibiliPlay',
 toolset: 'web',
 category: 'media',
 description: '获取 B站视频信息，返回视频播放页链接供用户观看。',
 schema: {
 description: '获取 B站视频播放信息',
 parameters: {
 type: 'object',
 properties: {
 bvid: { type: 'string', description: 'B站视频 BV 号（如 BV1GJ411x7）' },
 videoId: { type: 'string', description: 'B站视频 BV 号的别名' },
 },
 required: ['bvid'],
 },
 },
 handler: handleBilibiliPlay,
 timeout: 15000,
 isReadOnly: true,
});

console.log('🎬 B站工具已注册: BilibiliSearch, BilibiliPlay');

module.exports = { handleBilibiliSearch, handleBilibiliPlay, getBilibiliPlayUrl, resolvePlayUrl };
