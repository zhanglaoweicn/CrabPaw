// media.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');
const { getDocumentArtifactsDir } = require('../../core/doc-artifacts/registry');
const { sanitizeFilename } = require('../../core/filename-utils');

// 音乐搜索 — GET /api/search/music?query=
async function handleMusicSearch(req, res, _ctx) {
  const url = new URL(req.url, "http://localhost");
  const query = url.searchParams.get("query") || "";
  if (!query) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: "缺少 query" })); return; }
  try {
    const resp = await fetch("https://music.163.com/api/search/get?s=" + encodeURIComponent(query) + "&limit=10&type=1", {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com" },
      signal: AbortSignal.timeout(8000)
    });
    const data = await resp.json();
    const songs = (data.result && data.result.songs) || [];
    const tracks = songs.slice(0, 10).map(function(s) {
      const artists = s.artists || [];
      return { id: String(s.id), title: s.name, artist: artists.map(function(a) { return a.name; }).join(", "), url: "/api/proxy-audio?id=" + s.id };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, tracks: tracks }));
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: e.message, tracks: [] }));
  }
}

// 音乐歌词 — POST /api/search/music/lyrics
async function handleMusicLyrics(req, res, _ctx) {
  let body = '';
  req.on('data', function(chunk) { body += chunk; });
  await new Promise(function(resolve) { req.on("end", resolve); });
  let params;
  try { params = JSON.parse(body); } catch(e) { params = {}; }
  const id = params.id || "";
  if (!id) { res.writeHead(400); res.end(JSON.stringify({ success: false, error: "缺少 id" })); return; }
  try {
    const resp = await fetch('https://music.163.com/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=-1&kv=-1&tv=-1', {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com" },
      signal: AbortSignal.timeout(5000)
    });
    const data = await resp.json();
    const lrc = (data.lrc && data.lrc.lyric) || null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, lrc: lrc }));
  } catch (e) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: e.message, lrc: null }));
  }
}

// ─── 音频代理 — 解决 Netease 防盗链 ───
async function handleProxyAudio(req, res, _ctx) {
  const url_ = new URL(req.url, "http://localhost");
  const audioUrl = url_.searchParams.get("url") || "";
  let id = url_.searchParams.get("id") || "";
  if (!id && audioUrl) { const m = audioUrl.match(/id=(\d+)/); if (m) id = m[1]; }
  if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: "缺少 id" })); return; }
  try {
    const audioResp = await fetch("https://music.163.com/song/media/outer/url?id=" + id + ".mp3", {
      headers: { "Referer": "https://music.163.com", "User-Agent": "Mozilla/5.0" },
      redirect: "manual", signal: AbortSignal.timeout(15000)
    });
    if (audioResp.status >= 300 && audioResp.status < 400) {
      const loc = audioResp.headers.get("location") || "";
      if (loc.indexOf("/404") >= 0) { return proxyFallbackSource(); }
      const fr = await fetch(loc, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com" }, signal: AbortSignal.timeout(15000) });
      if (!fr.ok) { return proxyFallbackSource(); }
      res.writeHead(200, { "Content-Type": fr.headers.get("content-type") || "audio/mpeg", "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" });
      const reader = fr.body.getReader();
      (function pump() { reader.read().then(function(r) { if (r.done) { res.end(); return; } res.write(Buffer.from(r.value)); pump(); }).catch(function() { res.end(); }); })();
      return;
    }
    if (!audioResp.ok) { return proxyFallbackSource(); }
    res.writeHead(200, { "Content-Type": audioResp.headers.get("content-type") || "audio/mpeg", "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" });
    res.end(Buffer.from(await audioResp.arrayBuffer()));
  } catch (e) {
    res.writeHead(502); res.end(JSON.stringify({ error: "代理音频失败: " + e.message }));
  }

  // 2026-08-03: 网易 outer url 失效（版权/VIP）时的替代源——官方 player/url API
  // 成功率高于 outer url（部分歌 outer url 404 但 player API 有流）
  async function proxyFallbackSource() {
    try {
      const apiResp = await fetch("https://music.163.com/api/song/enhance/player/url?ids=[" + id + "]&br=3200000", {
        headers: { "Referer": "https://music.163.com", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15000)
      });
      const data = await apiResp.json().catch(() => null);
      const realUrl = data && data.data && data.data[0] && data.data[0].url;
      if (!realUrl) { res.writeHead(404); res.end(JSON.stringify({ error: "无法播放（版权限制）" })); return; }
      const fr = await fetch(realUrl, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://music.163.com" }, signal: AbortSignal.timeout(20000) });
      if (!fr.ok) { res.writeHead(404); res.end(JSON.stringify({ error: "无法播放（版权限制）" })); return; }
      res.writeHead(200, { "Content-Type": fr.headers.get("content-type") || "audio/mpeg", "Cache-Control": "public, max-age=600", "Access-Control-Allow-Origin": "*" });
      const reader = fr.body.getReader();
      (function pump() { reader.read().then(function(r) { if (r.done) { res.end(); return; } res.write(Buffer.from(r.value)); pump(); }).catch(function() { res.end(); }); })();
    } catch (e) {
      res.writeHead(404); res.end(JSON.stringify({ error: "无法播放（版权限制）" }));
    }
  }
}

// ── 文档格式转换（2026-08-07: 用户反馈"转成 WORD 没反应"——docx_generate 仅 LLM
// 工具，语音/前端无法直达；此 API 让 DocReader/语音命令直接调 document-tools） ──
// 2026-08-17: filegen 插桩——此为 POST /api/document/convert 的唯一实况实现
// （ROUTE_TABLE → LOCAL_HANDLERS.handleDocumentConvert）。广播自身失败只降级
// console.error，绝不阻塞转换主流程/200 响应（fgBroadcast 统一包裹）。
async function handleDocumentConvert(req, res) {
  const filegen = require('../../core/filegen-events');
  let fgTaskId = null;
  const fgBroadcast = (fn, ...args) => {
    try { fn(...args); } catch (err) {
      console.error('[DocumentConvert] filegen 广播失败(不阻塞转换):', err.message);
    }
  };
  try {
    const body = await readJsonBody(req);
    const content = String(body?.content || '').trim();
    const title = String(body?.title || 'document').trim();
    const target = ['docx', 'pdf', 'html'].includes(body?.target) ? body.target : 'docx';
    if (!content) return sendJson(res, 400, { success: false, error: '缺少内容 content' });

    const documentTools = require('../../tools/document-tools');
    const fs = require('fs');
    const path = require('path');
    // SP-4 SA-1: 转换产物归主轨 data/workspace/documents（此前 .crabpaw/workspace 双轨）
    const outDir = getDocumentArtifactsDir();
    fs.mkdirSync(outDir, { recursive: true });
    const safe = sanitizeFilename(title, 'document');
    const style = body?.style || '商务报告';

    // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进④文档生成；
    // 无活跃任务（直接转格式）则新建。错误隔离保持原 fgBroadcast 语义（广播失败不阻塞转换）。
    try {
      fgTaskId = filegen.ensureFileGenTask({
        title, format: target,
        phase: 'converting',
        label: `正在转换为 ${target.toUpperCase()}…`,
      });
    } catch (fgErr) {
      console.error('[DocumentConvert] filegen 插桩失败(不阻塞):', fgErr.message);
    }

    let buffer;
    let ext;
    if (target === 'docx') {
      buffer = await documentTools._generateDocx(content, safe, style);
      ext = 'docx';
    } else if (target === 'pdf') {
      const html = documentTools._generateHtml(content, { title: safe, style });
      buffer = await documentTools._generatePdf(html, { title: safe, style });
      ext = 'pdf';
    } else {
      buffer = documentTools._generateHtml(content, { title: safe, style });
      ext = 'html';
    }

    const outPath = path.join(outDir, `${safe}_${Date.now()}.${ext}`);
    fs.writeFileSync(outPath, buffer);
    const sizeKB = (buffer.length / 1024).toFixed(1);
    fgBroadcast(filegen.doneFileGen, fgTaskId, {
      path: outPath,
      name: path.basename(outPath),
      size: buffer.length,
      format: filegen.formatFromPath(outPath),
      url: filegen.previewUrlFor(filegen.formatFromPath(outPath), outPath),
    });
    console.log(`📄 文档转换: ${outPath} (${sizeKB}KB) [${style}]`);
    return sendJson(res, 200, { success: true, path: outPath, ext, size: buffer.length, sizeKB });
  } catch (err) {
    if (fgTaskId) {
      try { filegen.failFileGen(fgTaskId, err.message); } catch (fgErr) { console.error('[DocumentConvert] filegen 广播失败(不阻塞):', fgErr.message); }
    }
    console.error('[DocumentConvert] 转换失败:', err.message);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}

module.exports = {
  handleMusicSearch,
  handleMusicLyrics,
  handleProxyAudio,
  handleDocumentConvert,
};
