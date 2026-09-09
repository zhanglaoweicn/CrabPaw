/**
 * html-presentation executor — 生成 HTML 演讲演示文稿
 * 36 主题 · 31 布局 · 27 动效 · Chart.js · 演讲者模式
 */
var fs = require('fs');
var path = require('path');
var SKILL_DIR = path.join(__dirname);
var THEMES_DIR = path.join(SKILL_DIR, 'assets', 'themes');

function getThemes() {
  try { return fs.readdirSync(THEMES_DIR).filter(function(f) { return f.endsWith('.css'); }).map(function(f) { return path.basename(f, '.css'); }); }
  catch(e) { return ['minimal-white','aurora','tokyo-night','corporate-clean']; }
}
var ALL_THEMES = getThemes();

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function rp(t) { return './assets/' + t.replace(/^assets\//,''); }

var EXTRA_CSS = '.data-table{width:100%;border-collapse:collapse;font-size:14px}.data-table th{background:var(--surface-2);padding:10px 14px;text-align:left;font-weight:600;border-bottom:2px solid var(--border)}.data-table td{padding:8px 14px;border-bottom:1px solid var(--border);color:var(--text-2)}.flow{display:flex;align-items:center;gap:12px;margin-top:32px;flex-wrap:wrap}.flow .node{flex:1;min-width:100px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 14px;text-align:center;box-shadow:var(--shadow)}.flow .node .ic{font-size:28px;margin-bottom:4px}.flow .node h4{font-size:14px;margin:0}.flow .node p{font-size:11px;color:var(--text-3);margin:4px 0 0}.flow .arr{color:var(--text-3);font-size:24px;flex-shrink:0}.flow .node.hl{border-color:var(--accent)}';

function slideHTML(s, i, total) {
  var t = s.type || 'content';
  var ac = i === 0 ? ' is-active' : '';
  var ct = ['title','cover'].indexOf(t) >= 0 ? ' center tc' : '';

  if (t === 'title' || t === 'cover') {
    var anim = s.animation || 'rise-in';
    return '\n    <section class="slide'+ac+ct+'" data-title="'+esc(s.title||'Cover')+'">\n      <div class="deck-header"><span class="eyebrow">'+esc(s.subtitle||'')+'</span></div>\n      <div style="max-width:1000px;margin:0 auto" class="anim-stagger-list">\n        <p class="kicker">'+esc(s.kicker||'Keynote')+'</p>\n        <h1 class="h1 anim-'+anim+'" data-anim="'+anim+'">'+esc(s.title||'')+'</h1>\n        '+(s.lede?'<p class="lede">'+esc(s.lede)+'</p>':'')+'\n        '+(s.tags&&s.tags.length?'<div class="row wrap mt-l" style="gap:8px;justify-content:center">'+s.tags.map(function(t){return '<span class="pill pill-accent">'+esc(t)+'</span>';}).join('\n')+'</div>':'')+'\n      </div>\n      <div class="deck-footer"><span class="dim2">'+esc(s.author||'')+'</span><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  if (t === 'content') {
    var hasImg = s.image || (s.images&&s.images.length);
    return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      '+(s.bullets&&s.bullets.length?'<div class="stack mt-l anim-stagger-list">\n        '+s.bullets.map(function(b){return '<div class="card">'+esc(typeof b==='string'?b:b.text||'')+'</div>';}).join('\n')+'\n      </div>':'')+'\n      '+(hasImg?'<div class="mt-l tc"><img src="'+esc(s.image||s.images[0])+'" style="max-height:400px;border-radius:var(--radius);box-shadow:var(--shadow)"></div>':'')+'\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  if (t === 'two_column') {
    return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      <div class="grid g2 mt-l">\n        <div class="card anim-fade-left"><h3>'+esc(s.leftTitle||'')+'</h3><ul>'+(s.left||[]).map(function(item){return '<li>'+esc(item)+'</li>';}).join('\n')+'</ul></div>\n        <div class="card anim-fade-right"><h3>'+esc(s.rightTitle||'')+'</h3><ul>'+(s.right||[]).map(function(item){return '<li>'+esc(item)+'</li>';}).join('\n')+'</ul></div>\n      </div>\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  if (t === 'data' || t === 'chart') {
    var html = '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'Data')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n';
    if (s.metrics&&s.metrics.length) {
      html += '      <div class="grid g'+Math.min(s.metrics.length,4)+' mt-l anim-stagger-list">\n';
      for (var mi=0;mi<s.metrics.length;mi++) {
        var m = s.metrics[mi];
        html += '        <div class="card"><p class="eyebrow">'+esc(m.label||'')+'</p><div style="font-size:48px;font-weight:800">'+esc(String(m.value||''))+'</div>'+(m.change?'<p class="dim" style="color:'+(m.change.indexOf('↑')>=0?'var(--good)':'var(--bad)')+'">'+esc(m.change)+'</p>':'')+'</div>\n';
      }
      html += '      </div>\n';
    }
    html += '      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
    return html;
  }
  if (t === 'diagram' || t === 'flow' || t === 'architecture') {
    if (s.image || (s.images&&s.images.length)) {
      return '\n    <section class="slide'+ac+ct+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'Architecture')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      <div class="mt-l"><img src="'+esc(s.image||s.images[0])+'" style="max-height:520px;border-radius:var(--radius);box-shadow:var(--shadow-lg)"></div>\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
    }
    if (s.nodes) {
      var flowHtml = '';
      for (var ni=0;ni<s.nodes.length;ni++) {
        var n = s.nodes[ni];
        if (ni>0) flowHtml += '<div class="arr">→</div>';
        flowHtml += '<div class="node'+(n.highlight?' hl':'')+'">'+(n.icon?'<div class="ic">'+n.icon+'</div>':'')+'<h4>'+esc(n.label)+'</h4>'+(n.desc?'<p>'+esc(n.desc)+'</p>':'')+'</div>';
      }
      return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'Flow')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      <div class="flow anim-stagger-list">'+flowHtml+'</div>\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
    }
    return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'Architecture')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      '+(s.body?'<p class="lede mt-l">'+esc(s.body)+'</p>':'')+'\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  if (t === 'table') {
    return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'Data')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      <div class="card mt-l" style="overflow:auto"><table class="data-table"><thead><tr>'+(s.headers||[]).map(function(h){return '<th>'+esc(h)+'</th>';}).join('')+'</tr></thead><tbody>'+(s.rows||[]).map(function(r){return '<tr>'+r.map(function(c){return '<td>'+esc(String(c))+'</td>';}).join('')+'</tr>';}).join('\n')+'</tbody></table></div>\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  if (t === 'quote') {
    return '\n    <section class="slide'+ac+' center tc" data-title="'+esc(s.title||'Quote')+'">\n      <div style="max-width:1000px">\n        <div class="serif" style="font-size:120px;line-height:.9;color:var(--accent);opacity:.7">"</div>\n        <blockquote class="serif anim-fade-up" style="font-size:48px;line-height:1.3;margin:-24px 0 18px;font-weight:600;font-style:italic">'+esc(s.body||s.text||'')+'</blockquote>\n        <p class="dim" style="font-size:18px">— '+esc(s.author||'')+'</p>\n      </div>\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n    </section>';
  }
  if (t === 'summary') {
    return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'Summary')+'">\n      <p class="kicker">'+esc(s.kicker||'Summary')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      '+(s.points&&s.points.length?'<div class="stack mt-l anim-stagger-list">'+s.points.map(function(p){return '<div class="card"><span style="color:var(--good);font-weight:700">✓</span> '+esc(typeof p==='string'?p:p.text||'')+'</div>';}).join('\n')+'</div>':'')+'\n      '+(s.conclusion?'<div class="card card-accent mt-l tc" style="padding:24px"><h3>'+esc(s.conclusion)+'</h3></div>':'')+'\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  if (t === 'thanks' || t === 'end' || t === 'cta') {
    return '\n    <section class="slide'+ac+' center tc" data-title="'+esc(s.title||'Thanks')+'">\n      <div class="anim-confetti-burst" style="display:inline-block">\n        <h2 class="h1 gradient-text" style="font-size:96px;line-height:1.1">'+esc(s.title||'谢谢')+'</h2>\n      </div>\n      '+(s.body?'<p class="lede mt-l">'+esc(s.body)+'</p>':'')+'\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
  }
  // fallback content
  return '\n    <section class="slide'+ac+'" data-title="'+esc(s.title||'')+'">\n      <p class="kicker">'+esc(s.kicker||'')+'</p>\n      <h2 class="h2">'+esc(s.title||'')+'</h2>\n      '+(s.body?'<p class="lede mt-l">'+esc(s.body)+'</p>':'')+'\n      <div class="deck-footer"><span class="slide-number" data-current="'+(i+1)+'" data-total="'+total+'"></span></div>\n      '+(s.notes?'<div class="notes">'+esc(s.notes)+'</div>':'')+'\n    </section>';
}

async function execute(input, options, params) {
  var topic, slides, style;
  if (typeof input === 'string') { topic = input; slides = []; style = params?.style || 'minimal-white'; }
  else if (input && typeof input === 'object') { topic = input.topic||input.title||'Presentation'; slides = input.slides||[]; style = input.style||options?.style||params?.style||'minimal-white'; }

  if (ALL_THEMES.indexOf(style) < 0) {
    var found = null;
    for (var ti=0;ti<ALL_THEMES.length;ti++) { if (ALL_THEMES[ti].indexOf(style)>=0||style.indexOf(ALL_THEMES[ti])>=0) { found=ALL_THEMES[ti]; break; } }
    style = found || 'minimal-white';
  }

  var slideHtmls = [];
  for (var i=0;i<slides.length;i++) slideHtmls.push(slideHTML(slides[i], i, slides.length));

  var altThemes = ALL_THEMES.filter(function(t){return t!==style;}).slice(0,5);
  var safeTopic = topic.replace(/[<>"']/g,'').substring(0,60);

  var deckHtml = '<!DOCTYPE html>\n<html lang="zh-CN" data-theme="'+style+'">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>'+esc(safeTopic)+'</title>\n<link rel="stylesheet" href="'+rp('assets/fonts.css')+'">\n<link rel="stylesheet" href="'+rp('assets/base.css')+'">\n<link rel="stylesheet" id="theme-link" href="'+rp('assets/themes/'+style+'.css')+'">\n<link rel="stylesheet" href="'+rp('assets/animations/animations.css')+'">\n<style>'+EXTRA_CSS+'</style>\n</head>\n<body data-themes="'+altThemes.join(',')+'" data-theme-base="'+rp('assets/themes/')+'">\n\n<div class="deck">\n'+slideHtmls.join('\n')+'\n</div>\n\n<script src="'+rp('assets/runtime.js')+'"></script>\n</body>\n</html>';

  var wsDir = path.join(__dirname, '..', '..', 'data', 'workspace', 'documents');
  if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, {recursive:true});
  // 2026-08-22: 与 src/core/filename-utils.js sanitizeFilename 保持一致的简化内联规则
  // （技能是独立单元，只依赖内置模块，不 require 项目模块）。旧字符类 `_`、`-`、`一`
  // 相邻会被 V8 解析成范围 U+005F~U+4E00——中文全变下划线，改用 \p{L}\p{N}（u 标志）。
  var safeName = (topic || '').replace(/[<>:"/\\|?*\x00-\x1f]/g,'')
    .replace(/[^\p{L}\p{N}._\-\s]/gu,' ').replace(/\s+/g,'_')
    .replace(/_+/g,'_').replace(/-+/g,'-').replace(/^[_-]+|[_-]+$/g,'')
    .slice(0,60) || 'presentation';
  var fname = safeName+'_'+Date.now()+'.html';
  var outPath = path.join(wsDir, fname);
  fs.writeFileSync(outPath, deckHtml, 'utf-8');
  var sizeKB = (Buffer.byteLength(deckHtml,'utf-8')/1024).toFixed(1);

  return { success:true, path:outPath, slides:slides.length, style:style, sizeKB:sizeKB, message:'HTML 演示文稿已生成 ('+slides.length+' 页, 主题: '+style+')', tip:'在浏览器中打开 HTML 文件即可演示。按 S 键演讲者模式，T 键切换主题，F 键全屏。' };
}

module.exports = { execute:execute, schema:{name:'html-presentation',description:'Generate HTML presentation: 36 themes, 31 layouts, 47 animations, Chart.js.',capabilities:['document_generation','presentation']}, ALL_THEMES:ALL_THEMES };
