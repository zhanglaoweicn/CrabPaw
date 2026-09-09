/**
 * html-presentation — HTML 网页演示生成器
 *
 * 生成可离线打开、横向翻页的 HTML 演示文稿（参考 DashiAI PPT Skill 的 HTML-first 理念）。
 * 支持 Chart.js 图表、多主题配色、响应式布局。
 */

const path = require('path');
const fs = require('fs');

// ─── 36 套主题色（与 pptx-color-schemes-36.json 对齐） ───
const THEMES = {
  'corporate-clean': { primary: '#1E3C72', secondary: '#4682B4', accent: '#FFC107', bg: '#FFFFFF', text: '#333', font: 'system-ui' },
  'tokyo-night':    { primary: '#1E1E2E', secondary: '#5656A0', accent: '#7DCFFF', bg: '#14141A', text: '#F0F0F0', font: 'system-ui' },
  'pitch-deck-vc':  { primary: '#0F172A', secondary: '#3B82F6', accent: '#F59E0B', bg: '#FFFFFF', text: '#1E293B', font: 'Inter' },
  'nord':           { primary: '#2E3440', secondary: '#5E81AC', accent: '#88C0D0', bg: '#ECEFF4', text: '#2E3440', font: 'system-ui' },
  'aurora':         { primary: '#0F0F23', secondary: '#1A1A4E', accent: '#00FF88', bg: '#0A0A1A', text: '#C0C0E0', font: 'system-ui' },
};

function buildHtml(slides, style) {
  var theme = THEMES[style] || THEMES['pitch-deck-vc'];
  var slidesHtml = slides.map(function(s, i) {
    return buildSlideHtml(s, i, theme);
  }).join('\n');

  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0">\n' +
    '<title>' + (slides[0]?.title || '演示') + '</title>\n' +
    '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>\n' +
    '<style>\n' +
    '* { margin: 0; padding: 0; box-sizing: border-box; }\n' +
    'body { font-family: ' + theme.font + ', sans-serif; background: #111; display: flex; justify-content: center; align-items: center; min-height: 100vh; }\n' +
    '#deck { width: 1200px; height: 675px; position: relative; overflow: hidden; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }\n' +
    '.slide { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 40px 50px; background: ' + theme.bg + '; color: ' + theme.text + '; transition: opacity 0.4s, transform 0.4s; opacity: 0; transform: translateX(30px); overflow-y: auto; }\n' +
    '.slide.active { opacity: 1; transform: translateX(0); z-index: 1; }\n' +
    '.slide-title { font-size: 26px; font-weight: 700; color: ' + theme.primary + '; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 3px solid ' + theme.accent + '; }\n' +
    '.slide-subtitle { font-size: 16px; color: ' + theme.secondary + '; margin-top: -10px; margin-bottom: 20px; }\n' +
    '.bullet-item { font-size: 18px; padding: 6px 0 6px 20px; position: relative; line-height: 1.6; }\n' +
    '.bullet-item::before { content: ""; position: absolute; left: 4px; top: 14px; width: 8px; height: 8px; border-radius: 50%; background: ' + theme.accent + '; }\n' +
    '.two-col { display: flex; gap: 30px; flex: 1; }\n' +
    '.two-col > div { flex: 1; padding: 16px; border-radius: 8px; background: ' + (theme.bg === '#FFFFFF' ? '#F8FAFC' : 'rgba(255,255,255,0.04)') + '; }\n' +
    '.two-col h3 { font-size: 16px; color: ' + theme.accent + '; margin-bottom: 8px; }\n' +
    '.summary-box { margin-top: 20px; padding: 16px 20px; border-radius: 8px; background: ' + theme.secondary + '; color: #fff; font-size: 18px; font-weight: 600; text-align: center; }\n' +
    '.nav-bar { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; z-index: 10; }\n' +
    '.nav-bar button { padding: 8px 20px; border: 0; border-radius: 6px; background: ' + theme.primary + '; color: #fff; cursor: pointer; font-size: 14px; opacity: 0.8; }\n' +
    '.nav-bar button:hover { opacity: 1; }\n' +
    '.page-num { position: absolute; bottom: 20px; right: 24px; font-size: 13px; color: ' + theme.secondary + '; z-index: 10; }\n' +
    '@media (max-width: 1240px) { #deck { width: 100vw; height: 56.25vw; } .slide { padding: 3vw 4vw; } .slide-title { font-size: 2.2vw; } .bullet-item { font-size: 1.5vw; } }\n' +
    '</style></head><body>\n' +
    '<div id="deck">\n' + slidesHtml +
    '<div class="nav-bar"><button onclick="prevSlide()">← 上一页</button><button onclick="nextSlide()">下一页 →</button></div>\n' +
    '<div class="page-num"><span id="pageNum">1</span>/' + slides.length + '</div>\n' +
    '</div>\n<script>\n' +
    'var current = 0, total = ' + slides.length + ';\n' +
    'function show(i) { document.querySelectorAll(".slide").forEach(function(s,i2){s.classList.toggle("active",i2===i)}); document.getElementById("pageNum").textContent = i+1; current=i; }\n' +
    'function nextSlide() { if (current < total-1) show(current+1); }\n' +
    'function prevSlide() { if (current > 0) show(current-1); }\n' +
    'document.addEventListener("keydown", function(e) { if (e.key==="ArrowRight") nextSlide(); if (e.key==="ArrowLeft") prevSlide(); });\n' +
    'show(0);\n' +
    '</script></body></html>';
}

function buildSlideHtml(s, i, theme) {
  var cls = i === 0 ? 'slide active' : 'slide';
  var html = '<div class="' + cls + '" data-slide="' + i + '">\n';

  if (s.type === 'title') {
    html += '<div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;">\n';
    html += '<div style="width:80px;height:4px;background:' + theme.accent + ';margin-bottom:24px"></div>\n';
    html += '<div class="slide-title" style="font-size:38px;border:0;padding:0;margin-bottom:12px">' + escHtml(s.title || '') + '</div>\n';
    if (s.subtitle) html += '<div class="slide-subtitle" style="font-size:20px;margin-bottom:30px">' + escHtml(s.subtitle) + '</div>\n';
    html += '<div style="width:80px;height:4px;background:' + theme.accent + ';margin-top:12px"></div>\n';
    html += '</div>\n';
  } else if (s.type === 'content') {
    html += '<div class="slide-title">' + escHtml(s.title || '') + '</div>\n';
    if (s.bullets && s.bullets.length > 0) {
      html += '<div style="flex:1;padding-top:8px">';
      s.bullets.forEach(function(b) { html += '<div class="bullet-item">' + escHtml(b) + '</div>\n'; });
      html += '</div>';
    }
  } else if (s.type === 'two_column') {
    html += '<div class="slide-title">' + escHtml(s.title || '') + '</div>\n';
    html += '<div class="two-col">\n';
    html += '<div><h3>' + escHtml(s.leftTitle || '左列') + '</h3>\n';
    (s.left || []).forEach(function(item) { html += '<div class="bullet-item">' + escHtml(item) + '</div>\n'; });
    html += '</div>\n';
    html += '<div><h3>' + escHtml(s.rightTitle || '右列') + '</h3>\n';
    (s.right || []).forEach(function(item) { html += '<div class="bullet-item">' + escHtml(item) + '</div>\n'; });
    html += '</div>\n</div>\n';
  } else if (s.type === 'summary') {
    html += '<div class="slide-title">' + escHtml(s.title || '') + '</div>\n';
    if (s.points && s.points.length > 0) {
      s.points.forEach(function(p) { html += '<div class="bullet-item">' + escHtml(p) + '</div>\n'; });
    }
    if (s.conclusion) html += '<div class="summary-box">' + escHtml(s.conclusion) + '</div>\n';
  } else {
    html += '<div class="slide-title">' + escHtml(s.title || '') + '</div>\n';
    html += '<div class="bullet-item">' + escHtml(s.content || '') + '</div>\n';
  }

  html += '</div>\n';
  return html;
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function execute(params) {
  var topic = params.topic || '';
  var slides = params.slides || [];
  var style = params.style || 'pitch-deck-vc';

  if (!slides || slides.length === 0) {
    // 尝试用 presentation-builder 生成大纲
    try {
      var pb = require('../presentation-builder/executor');
      var outline = await pb.execute({ topic: topic, slideCount: params.slideCount || 8 });
      if (outline.success && outline.slides) slides = outline.slides;
    } catch (e) {
      return { success: false, error: '需要 slides 参数，或提供 topic 自动生成大纲' };
    }
  }

  var html = buildHtml(slides, style);

  var outDir = path.join(__dirname, '..', '..', '..', 'data', 'workspace', 'documents');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  var safeName = (topic || slides[0]?.title || 'presentation').replace(/[^a-zA-Z0-9_一-鿿]/g, '_');
  var outPath = path.join(outDir, safeName + '_' + Date.now() + '.html');

  fs.writeFileSync(outPath, html, 'utf-8');
  var sizeKB = (html.length / 1024).toFixed(1);

  // SP-4 SA-1: 写盘后补注册表登记——executor 无任务上下文（无 filegen:done 广播）,
  // taskId/url 留空（只补注册不补广播, 见 SA-1 报告披露）。失败不阻塞产物返回。
  try {
    const { registerArtifact } = require('../../core/doc-artifacts/registry');
    registerArtifact({
      path: outPath,
      name: path.basename(outPath),
      size: html.length,
      format: 'html',
      url: '',
      taskId: '',
    }).catch(function (e) {
      console.warn('[html-presentation] 产物注册失败(不阻塞):', e && e.message);
    });
  } catch (e) {
    console.warn('[html-presentation] 产物注册失败(不阻塞):', e && e.message);
  }

  return {
    success: true, path: outPath, size: html.length, sizeKB: sizeKB,
    slides: slides.length, style: style,
    message: 'HTML 演示已生成 (' + slides.length + ' 页, ' + sizeKB + 'KB)。浏览器打开即可查看，支持键盘左右键翻页。',
  };
}

module.exports = { execute, buildHtml };
